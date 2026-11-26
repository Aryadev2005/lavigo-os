/**
 * Inbound pipeline (INB-1, INB-3, INB-4, INB-10, INB-12). One function for every channel: the
 * WhatsApp/Instagram webhook jobs and the /sandbox page all call ingestInbound().
 *
 * Idempotent: Message.externalId is unique, so the same provider message twice is one row.
 */
import { Prisma, type Channel } from "@prisma/client";
import { db } from "../../db";
import { logger } from "../../logger";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import { getStorage } from "../../storage/s3";
import { getAdapter } from "../../channels";
import { ALLOWED_MEDIA } from "../../channels/media";
import { ChannelSendError, type NormalizedInbound, type NormalizedStatus } from "../../channels/types";

export type IngestOutcome =
  | { status: "duplicate"; messageId: string; conversationId: string }
  | { status: "customer"; messageId: string; conversationId: string; createdConversation: boolean }
  | { status: "supplier"; messageId: string; conversationId: string; supplierId: string };

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** "Instagram reel → WhatsApp" style note from a click-to-chat referral. */
export function sourceNoteFromReferral(referral: Record<string, unknown> | undefined): string | null {
  if (!referral) return null;
  const type = String(referral.source_type ?? "").toLowerCase();
  const headline = typeof referral.headline === "string" ? referral.headline.slice(0, 80) : "";
  const what = type === "ad" ? "Ad" : type === "post" ? "Post" : "Link";
  return `${what}${headline ? ` "${headline}"` : ""} → WhatsApp`;
}

async function existingMessage(externalId: string) {
  return db.message.findUnique({ where: { externalId }, select: { id: true, conversationId: true } });
}

/** Upsert by (channel, thread). Retries once on the unique race between two first messages. */
async function upsertConversation(channel: Channel, threadId: string, create: Prisma.ConversationUncheckedCreateInput) {
  for (let i = 0; ; i++) {
    const found = await db.conversation.findUnique({ where: { channel_externalThreadId: { channel, externalThreadId: threadId } } });
    if (found) return { conversation: found, created: false };
    try {
      return { conversation: await db.conversation.create({ data: create }), created: true };
    } catch (err) {
      if (i === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

async function upsertCustomer(m: NormalizedInbound) {
  if (m.channel === "WHATSAPP") {
    const existing = await db.customer.findUnique({ where: { phone: m.from } });
    if (existing) {
      // A customer first created from a bare number gets their WhatsApp profile name.
      if (m.profileName && existing.name === existing.phone) {
        return db.customer.update({ where: { id: existing.id }, data: { name: m.profileName.slice(0, 120) } });
      }
      return existing;
    }
    try {
      return await db.customer.create({ data: { name: (m.profileName ?? m.from).slice(0, 120), phone: m.from } });
    } catch (err) {
      if (isUniqueViolation(err)) return db.customer.findUniqueOrThrow({ where: { phone: m.from } });
      throw err;
    }
  }
  if (m.channel === "INSTAGRAM") {
    const existing = await db.customer.findUnique({ where: { igUserId: m.from } });
    if (existing) return existing;
    try {
      return await db.customer.create({ data: { name: (m.profileName ?? "Instagram user").slice(0, 120), igUserId: m.from } });
    } catch (err) {
      if (isUniqueViolation(err)) return db.customer.findUniqueOrThrow({ where: { igUserId: m.from } });
      throw err;
    }
  }
  return null;
}

export async function ingestInbound(m: NormalizedInbound): Promise<IngestOutcome> {
  const dup = await existingMessage(m.externalId);
  if (dup) return { status: "duplicate", messageId: dup.id, conversationId: dup.conversationId };
  const at = new Date(m.timestamp);
  const messagePayload = m.media ? ({ media: m.media } as Prisma.InputJsonValue) : undefined;

  // ── Supplier replies never reach the customer inbox (INB-4 → supplier pipeline, §4.7).
  const supplier = m.channel === "WHATSAPP" ? await db.supplier.findUnique({ where: { phone: m.from }, select: { id: true } }) : null;
  if (supplier) {
    const { conversation } = await upsertConversation(m.channel, m.from, {
      channel: m.channel,
      externalThreadId: m.from,
      supplierId: supplier.id,
      status: "ACTIVE",
    });
    if (!conversation.supplierId) await db.conversation.update({ where: { id: conversation.id }, data: { supplierId: supplier.id } });
    let messageId: string;
    try {
      messageId = await saveInbound(conversation.id, m, at, "SUPPLIER", messagePayload);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const again = (await existingMessage(m.externalId))!;
        return { status: "duplicate", messageId: again.id, conversationId: again.conversationId };
      }
      throw err;
    }
    // Parsed by the rule-based RFQ parser (P5); the job is a no-op until then.
    await enqueue("rfq.parseReply", { messageId, supplierId: supplier.id }, { jobId: `rfq-parse-${messageId}` });
    return { status: "supplier", messageId, conversationId: conversation.id, supplierId: supplier.id };
  }

  // ── Customer.
  let conversationId: string;
  let created = false;
  if (m.channel === "SANDBOX") {
    const conv = await db.conversation.findUnique({ where: { channel_externalThreadId: { channel: "SANDBOX", externalThreadId: m.from } } });
    if (!conv) throw new Error("sandbox conversation not found");
    conversationId = conv.id;
  } else {
    const customer = await upsertCustomer(m);
    const r = await upsertConversation(m.channel, m.from, {
      channel: m.channel,
      externalThreadId: m.from,
      customerId: customer?.id ?? null,
      status: "NEW",
      sourceNote: sourceNoteFromReferral(m.referral),
      referral: m.referral as Prisma.InputJsonValue | undefined,
      lastMessageAt: at,
    });
    conversationId = r.conversation.id;
    created = r.created;
  }

  let messageId: string;
  try {
    messageId = await saveInbound(conversationId, m, at, "CUSTOMER", messagePayload);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = (await existingMessage(m.externalId))!;
      return { status: "duplicate", messageId: again.id, conversationId: again.conversationId };
    }
    throw err;
  }
  await notify(conversationId, messageId, "message.created");
  return { status: "customer", messageId, conversationId, createdConversation: created };
}

/** Message row + conversation counters in one transaction. */
async function saveInbound(
  conversationId: string,
  m: NormalizedInbound,
  at: Date,
  author: "CUSTOMER" | "SUPPLIER",
  payload: Prisma.InputJsonValue | undefined,
): Promise<string> {
  return db.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: {
        conversationId,
        direction: "INBOUND",
        author,
        kind: m.kind,
        body: m.text.slice(0, 4096),
        payload,
        externalId: m.externalId,
        status: "RECEIVED",
        createdAt: at,
      },
    });
    // The customer wrote: the 24h window (re)opens, the chat is unread, and a closed or
    // follow-up chat is live again. "Waiting for reply" is derived (customer spoke last).
    await tx.$executeRaw`
      UPDATE "Conversation" SET
        "lastInboundAt" = GREATEST(COALESCE("lastInboundAt", ${at}), ${at}),
        "lastMessageAt" = GREATEST("lastMessageAt", ${at}),
        "unreadCount"   = "unreadCount" + 1,
        status = CASE WHEN status IN ('CLOSED', 'FOLLOW_UP') THEN 'ACTIVE'::"ConversationStatus" ELSE status END,
        "updatedAt" = now()
      WHERE id = ${conversationId}`;
    return msg.id;
  });
}

async function notify(conversationId: string, messageId: string, type: "message.created" | "message.updated") {
  await publish({ type, payload: { conversationId, messageId } }).catch(() => undefined);
  if (type === "message.created") await publish({ type: "conversation.updated", payload: { conversationId } }).catch(() => undefined);
}

// ───────────────────────────── delivery statuses (INB-10) ─────────────────────────────

const BEFORE: Record<NormalizedStatus["status"], ("QUEUED" | "SENT" | "DELIVERED" | "READ")[]> = {
  SENT: ["QUEUED"],
  DELIVERED: ["QUEUED", "SENT"],
  READ: ["QUEUED", "SENT", "DELIVERED"],
  FAILED: ["QUEUED", "SENT"], // a delivered/read message can't un-deliver
};

/** Statuses only move forward (out-of-order webhooks can't regress ✓✓ to ✓). */
export async function applyStatus(s: NormalizedStatus): Promise<"updated" | "unchanged" | "unknown"> {
  const msg = await db.message.findUnique({ where: { externalId: s.externalId }, select: { id: true, conversationId: true } });
  if (!msg) return "unknown";
  const { count } = await db.message.updateMany({
    where: { id: msg.id, status: { in: BEFORE[s.status] } },
    data: { status: s.status, ...(s.status === "FAILED" ? { error: (s.error ?? "failed").slice(0, 300) } : {}) },
  });
  if (count) await notify(msg.conversationId, msg.id, "message.updated");
  return count ? "updated" : "unchanged";
}

// ───────────────────────────── inbound media (INB-12) ─────────────────────────────

type StoredMedia = { media?: { ref: string; mime?: string; filename?: string }; documentId?: string; fileName?: string; mime?: string; mediaError?: string };

/**
 * Download a customer's photo/PDF from the provider and keep it privately (Document, kind OTHER,
 * key under chat/ so staff can open it). Retryable provider errors throw so the job retries.
 */
export async function storeInboundMedia(messageId: string): Promise<"stored" | "skipped" | "rejected"> {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: { select: { id: true, channel: true } } } });
  const payload = (msg?.payload ?? {}) as StoredMedia;
  if (!msg || !payload.media || payload.documentId) return "skipped";
  const adapter = getAdapter(msg.conversation.channel);
  if (!adapter.downloadMedia) return "skipped"; // fake adapters: nothing to fetch

  let file: { bytes: Buffer; mime: string };
  try {
    file = await adapter.downloadMedia(payload.media.ref);
  } catch (err) {
    if (err instanceof ChannelSendError && !err.retryable) {
      await db.message.update({ where: { id: msg.id }, data: { payload: { ...payload, mediaError: err.message } as Prisma.InputJsonValue } });
      logger.warn({ messageId, reason: err.message }, "inbound media rejected");
      return "rejected";
    }
    throw err;
  }
  const ext = ALLOWED_MEDIA[file.mime as keyof typeof ALLOWED_MEDIA] ?? "bin";
  const key = `chat/${msg.conversation.id}/${msg.id}.${ext}`;
  await getStorage().put(key, file.bytes, file.mime);
  const fileName = (payload.media.filename ?? `${file.mime.startsWith("image/") ? "photo" : "document"}-${msg.id.slice(-6)}.${ext}`).slice(0, 200);
  const doc = await db.document.upsert({
    where: { storageKey: key },
    update: {},
    create: { kind: "CHAT_MEDIA", storageKey: key, fileName, mimeType: file.mime, sizeBytes: file.bytes.length },
  });
  await db.message.update({
    where: { id: msg.id },
    data: { mediaKey: key, payload: { ...payload, documentId: doc.id, fileName, mime: file.mime } as Prisma.InputJsonValue },
  });
  await notify(msg.conversation.id, msg.id, "message.updated");
  return "stored";
}
