/**
 * Outbound messages (system design §7, INB-7, INB-11). Every send, from staff or the system:
 *
 *   send(conversationId, payload, author)
 *     → policy (24h window for non-templates, approved template, channel enabled)
 *     → Message row (QUEUED; a BLOCKED send is returned without a row)
 *     → outbound.send job (global limiter 10/s, 5 attempts, exponential backoff)
 *     → adapter → SENT (sandbox: DELIVERED) or FAILED. Provider status webhooks move it on to ✓✓.
 *
 * The Message row exists before the provider call, so retries update the same row and the
 * thread shows the bubble immediately (🕓 until the provider accepts it).
 */
import type { Author, MessageKind, Prisma } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import { publish } from "../pubsub";
import { enqueue } from "../queue";
import { getStorage } from "../storage/s3";
import { channelEnabled, getAdapter } from "./index";
import { ChannelSendError } from "./types";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutboundPayload =
  | { type: "text"; body: string }
  | { type: "cta"; body: string; button: { label: string; url: string } }
  | { type: "template"; name: string; vars: Record<string, string>; buttonUrlSuffix?: string }
  | { type: "document"; documentId: string; caption?: string }
  /** Centred note in the thread; never sent to the customer. */
  | { type: "note"; body: string };

/** A logged-in user (owner or staff), or the system (reminders, confirmations). */
export type OutboundAuthor = { userId: string } | "SYSTEM";

export type OutboundOptions = {
  /** Render the bubble as a quote or payment-link card (P4 deal desk). */
  card?: { kind: Extract<MessageKind, "QUOTE" | "PAYMENT_LINK">; payload: Record<string, unknown> };
  now?: Date;
};

export type BlockReason =
  | "WINDOW_CLOSED"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_NOT_APPROVED"
  | "NOT_OPTED_IN"
  | "NO_TEMPLATES_ON_CHANNEL"
  | "CHANNEL_DISABLED"
  | "DOCUMENT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "EMPTY";

export type OutboundResult =
  | { status: "QUEUED"; messageId: string; conversationId: string; body: string }
  | { status: "NOTED"; messageId: string; conversationId: string; body: string }
  | { status: "BLOCKED"; reason: BlockReason; conversationId: string };

/** The stored send instruction the worker replays (Message.payload.out). */
type OutSpec =
  | { type: "text"; body: string }
  | { type: "cta"; body: string; button: { label: string; url: string } }
  | { type: "template"; name: string; lang: string; vars: string[]; buttonUrlSuffix?: string }
  | { type: "document"; documentId: string; fileName: string; caption?: string };

/** The 24h customer-service window: open while the customer wrote within the last 24 hours. */
export function windowOpen(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() <= WINDOW_MS;
}

/** Fill a template body: {{1}} → vars[variables[0]], … Missing values render as "". PURE. */
export function renderTemplate(template: { bodyPreview: string; variables: string[] }, vars: Record<string, string>): string {
  return template.bodyPreview.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[template.variables[Number(n) - 1] ?? ""] ?? "");
}

export async function send(
  conversationId: string,
  payload: OutboundPayload,
  author: OutboundAuthor,
  opts: OutboundOptions = {},
): Promise<OutboundResult> {
  const now = opts.now ?? new Date();
  const conv = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conv) return { status: "BLOCKED", reason: "CONVERSATION_NOT_FOUND", conversationId };
  const blocked = (reason: BlockReason): OutboundResult => {
    logger.info({ conversationId, reason, type: payload.type }, "outbound blocked");
    return { status: "BLOCKED", reason, conversationId };
  };

  const byUser = author !== "SYSTEM";
  const authorFields = {
    author: (byUser ? "OWNER" : "SYSTEM") as Author, // Author.OWNER = any logged-in user
    authorUserId: byUser ? author.userId : null,
  };

  // ── System notes: stored only.
  if (payload.type === "note") {
    if (!payload.body.trim()) return blocked("EMPTY");
    const note = await db.message.create({
      data: { conversationId, direction: "OUTBOUND", ...authorFields, kind: "SYSTEM_NOTE", body: payload.body.slice(0, 2000), status: "SENT", createdAt: now },
    });
    await announce(conversationId, note.id, "message.created");
    return { status: "NOTED", messageId: note.id, conversationId, body: note.body };
  }

  if (!channelEnabled(conv.channel)) return blocked("CHANNEL_DISABLED");

  let spec: OutSpec;
  let body: string;
  let kind: MessageKind;
  const extra: Record<string, unknown> = {};

  if (payload.type === "template") {
    if (conv.channel === "INSTAGRAM") return blocked("NO_TEMPLATES_ON_CHANNEL");
    const template = await db.messageTemplate.findUnique({ where: { name: payload.name } });
    if (!template) return blocked("TEMPLATE_NOT_FOUND");
    if (template.metaStatus !== "APPROVED") return blocked("TEMPLATE_NOT_APPROVED");
    if (template.category === "MARKETING") {
      // Marketing templates only to customers who opted in (Meta policy, DESK-7).
      const optedIn = conv.customerId ? (await db.customer.findUnique({ where: { id: conv.customerId }, select: { marketingOptIn: true } }))?.marketingOptIn : false;
      if (!optedIn) return blocked("NOT_OPTED_IN");
    }
    body = renderTemplate(template, payload.vars);
    spec = {
      type: "template",
      name: template.name,
      lang: template.language,
      vars: template.variables.map((v) => payload.vars[v] ?? ""),
      buttonUrlSuffix: payload.buttonUrlSuffix,
    };
    kind = "TEMPLATE";
    extra.template = template.name;
    extra.vars = payload.vars;
  } else {
    // Free-form (text, button, document) only inside the 24h window (INB-11).
    if (!windowOpen(conv.lastInboundAt, now)) return blocked("WINDOW_CLOSED");
    if (payload.type === "document") {
      const doc = await db.document.findUnique({ where: { id: payload.documentId }, select: { id: true, fileName: true, mimeType: true } });
      if (!doc) return blocked("DOCUMENT_NOT_FOUND");
      spec = { type: "document", documentId: doc.id, fileName: doc.fileName, caption: payload.caption };
      body = payload.caption ? `📎 ${doc.fileName}\n${payload.caption}` : `📎 ${doc.fileName}`;
      kind = "MEDIA";
      Object.assign(extra, { documentId: doc.id, fileName: doc.fileName, mime: doc.mimeType });
    } else {
      if (!payload.body.trim()) return blocked("EMPTY");
      spec = payload.type === "cta" ? { type: "cta", body: payload.body, button: payload.button } : { type: "text", body: payload.body };
      body = payload.body;
      kind = "TEXT";
    }
  }
  if (opts.card) {
    kind = opts.card.kind;
    Object.assign(extra, opts.card.payload);
  }

  const message = await db.message.create({
    data: {
      conversationId,
      direction: "OUTBOUND",
      ...authorFields,
      kind,
      body: body.slice(0, 4096),
      payload: { ...extra, out: spec } as Prisma.InputJsonValue,
      status: "QUEUED",
      createdAt: now,
    },
  });
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: now,
      // A person replying has read the chat; a brand-new lead becomes an active conversation.
      ...(byUser ? { unreadCount: 0, ...(conv.status === "NEW" ? { status: "ACTIVE" as const } : {}) } : {}),
    },
  });

  try {
    await enqueue("outbound.send", { messageId: message.id }, { jobId: `send-${message.id}` });
  } catch (err) {
    await db.message.update({ where: { id: message.id }, data: { status: "FAILED", error: "could not queue the send" } });
    await announce(conversationId, message.id, "message.created");
    throw err;
  }
  await announce(conversationId, message.id, "message.created");
  return { status: "QUEUED", messageId: message.id, conversationId, body: message.body };
}

async function announce(conversationId: string, messageId: string, type: "message.created" | "message.updated") {
  await publish({ type, payload: { conversationId, messageId } }).catch(() => undefined);
  if (type === "message.created") await publish({ type: "conversation.updated", payload: { conversationId } }).catch(() => undefined);
}

// ───────────────────────────── worker side ─────────────────────────────

export type DeliverResult = { status: "SENT" | "DELIVERED" | "FAILED" | "SKIPPED"; error?: string };

/**
 * outbound.send job body. Idempotent: only a QUEUED message is sent. Retryable provider errors
 * throw (BullMQ retries with backoff) until the last attempt, which marks the message FAILED.
 */
export async function deliverMessage(messageId: string, opts: { finalAttempt: boolean }): Promise<DeliverResult> {
  const msg = await db.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
  if (!msg || msg.status !== "QUEUED") return { status: "SKIPPED" };
  const spec = (msg.payload as { out?: OutSpec } | null)?.out;
  if (!spec) return markFailed(msg.id, msg.conversationId, "nothing to send");

  const conv = msg.conversation;
  const to = conv.externalThreadId;
  try {
    const adapter = getAdapter(conv.channel);
    let receipt;
    switch (spec.type) {
      case "text":
        receipt = await adapter.sendText(to, spec.body);
        break;
      case "cta":
        receipt = await adapter.sendCta(to, spec.body, spec.button);
        break;
      case "template":
        receipt = await adapter.sendTemplate(to, spec.name, spec.lang, spec.vars, spec.buttonUrlSuffix);
        break;
      case "document": {
        const doc = await db.document.findUniqueOrThrow({ where: { id: spec.documentId } });
        // Fresh link per attempt; the provider fetches it right away.
        const url = await getStorage().presignGet(doc.storageKey, { fileName: doc.fileName, expiresIn: 15 * 60 });
        receipt = await adapter.sendDocument(to, { url, filename: doc.fileName }, spec.caption);
        break;
      }
    }
    const status = conv.channel === "SANDBOX" ? "DELIVERED" : "SENT";
    await db.message.updateMany({ where: { id: msg.id, status: "QUEUED" }, data: { status, externalId: receipt.externalId, error: null } });
    await announce(msg.conversationId, msg.id, "message.updated");
    return { status };
  } catch (err) {
    const retryable = err instanceof ChannelSendError ? err.retryable : true;
    if (retryable && !opts.finalAttempt) throw err;
    return markFailed(msg.id, msg.conversationId, err instanceof Error ? err.message : String(err));
  }
}

async function markFailed(messageId: string, conversationId: string, error: string): Promise<DeliverResult> {
  await db.message.updateMany({ where: { id: messageId, status: "QUEUED" }, data: { status: "FAILED", error: error.slice(0, 300) } });
  logger.warn({ messageId, error: error.slice(0, 200) }, "outbound send failed");
  await announce(conversationId, messageId, "message.updated");
  return { status: "FAILED", error };
}

// ───────────────────────────── caller conveniences ─────────────────────────────

export type OutboundTarget = { conversationId: string } | { customerId: string };
export type TemplateVars = Record<string, string>;
export type SendResult = { sent: true; messageId: string; conversationId: string; body: string } | { sent: false; reason: string };

/** The customer's latest WhatsApp conversation, created on first send if they have a phone number. */
async function resolveConversation(target: OutboundTarget) {
  if ("conversationId" in target) return db.conversation.findUnique({ where: { id: target.conversationId } });
  const existing = await db.conversation.findFirst({
    where: { customerId: target.customerId, channel: "WHATSAPP" },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;
  const customer = await db.customer.findUnique({ where: { id: target.customerId }, select: { phone: true } });
  if (!customer?.phone) return null;
  return db.conversation.upsert({
    where: { channel_externalThreadId: { channel: "WHATSAPP", externalThreadId: customer.phone } },
    update: {},
    create: { channel: "WHATSAPP", externalThreadId: customer.phone, customerId: target.customerId, status: "ACTIVE" },
  });
}

/**
 * Send an approved template to a conversation or a customer (reminders, confirmations, follow-ups).
 * Templates are allowed outside the 24h window. `sent: true` means queued for delivery.
 */
export async function sendTemplate(
  target: OutboundTarget,
  templateName: string,
  vars: TemplateVars,
  opts: { authorUserId?: string | null; buttonUrlSuffix?: string } = {},
): Promise<SendResult> {
  const conversation = await resolveConversation(target);
  if (!conversation) return { sent: false, reason: "customer has no WhatsApp number" };
  const r = await send(
    conversation.id,
    { type: "template", name: templateName, vars, buttonUrlSuffix: opts.buttonUrlSuffix },
    opts.authorUserId ? { userId: opts.authorUserId } : "SYSTEM",
  );
  if (r.status === "BLOCKED") return { sent: false, reason: r.reason };
  return { sent: true, messageId: r.messageId, conversationId: r.conversationId, body: r.body };
}

export function sendText(conversationId: string, body: string, author: OutboundAuthor) {
  return send(conversationId, { type: "text", body }, author);
}

export function sendDocument(conversationId: string, documentId: string, author: OutboundAuthor, caption?: string) {
  return send(conversationId, { type: "document", documentId, caption }, author);
}
