"use server";
/**
 * Inbox mutations (INB-7, INB-8, INB-11) and the deal desk (DESK-*). requireUser → zod → domain → revalidate.
 * Every outbound message records its author (Message.authorUserId), which is the send audit trail;
 * lead edits write an AuditLog entry.
 */
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { clientIp } from "@/server/auth";
import { send, type BlockReason } from "@/server/channels/outbound";
import { ALLOWED_MEDIA, MAX_MEDIA_BYTES, sniffMime } from "@/server/channels/media";
import { db } from "@/server/db";
import { markRead, updateLead } from "@/server/domain/conversations";
import { departureSnippet } from "@/server/domain/conversations/queries";
import {
  askOwner,
  DealError,
  decideApproval,
  previewQuote,
  sendFollowUp,
  sendPaymentLink,
  sendQuote,
  type DealActor,
  type DealErrorCode,
  type QuotePreview,
} from "@/server/domain/deals";
import { logger } from "@/server/logger";
import { requireUser } from "@/server/rbac";
import { getStorage } from "@/server/storage/s3";

const id = z.string().min(1).max(64);

export type SendActionResult = { ok: true } | { ok: false; error: string; reason?: BlockReason };

const BLOCK_COPY: Record<BlockReason, string> = {
  WINDOW_CLOSED: "The 24-hour window is closed. Send an approved template instead.",
  TEMPLATE_NOT_FOUND: "That template doesn't exist.",
  TEMPLATE_NOT_APPROVED: "That template isn't approved by Meta yet.",
  NOT_OPTED_IN: "This customer hasn't opted in to marketing messages.",
  NO_TEMPLATES_ON_CHANNEL: "Instagram has no templates. You can reply once the customer writes again.",
  CHANNEL_DISABLED: "This channel is switched off.",
  DOCUMENT_NOT_FOUND: "That file is gone. Attach it again.",
  CONVERSATION_NOT_FOUND: "Conversation not found.",
  EMPTY: "Type a message first.",
};

/** Customer conversations only: supplier threads are worked from the Supplier desk. */
async function assertCustomerConversation(conversationId: string) {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { customerId: true, supplierId: true } });
  if (!c || !c.customerId || c.supplierId) throw new Error("conversation not found");
}

function done(r: Awaited<ReturnType<typeof send>>): SendActionResult {
  if (r.status === "BLOCKED") return { ok: false, error: BLOCK_COPY[r.reason], reason: r.reason };
  revalidatePath("/inbox");
  return { ok: true };
}

export async function sendTextAction(conversationId: string, body: string): Promise<SendActionResult> {
  const user = await requireUser();
  const input = z.object({ conversationId: id, body: z.string().trim().min(1).max(4000) }).safeParse({ conversationId, body });
  if (!input.success) return { ok: false, error: "Type a message first." };
  await assertCustomerConversation(input.data.conversationId);
  return done(await send(input.data.conversationId, { type: "text", body: input.data.body }, { userId: user.id }));
}

export async function sendTemplateAction(conversationId: string, name: string, vars: Record<string, string>): Promise<SendActionResult> {
  const user = await requireUser();
  const input = z
    .object({ conversationId: id, name: z.string().min(1).max(100), vars: z.record(z.string().max(40), z.string().trim().min(1, "Fill in every field").max(500)) })
    .safeParse({ conversationId, name, vars });
  if (!input.success) return { ok: false, error: input.error.issues[0]?.message ?? "Fill in every field" };
  await assertCustomerConversation(input.data.conversationId);
  return done(await send(input.data.conversationId, { type: "template", name: input.data.name, vars: input.data.vars }, { userId: user.id }));
}

/** Attachment: ≤ 10 MB, jpg/png/webp/pdf by magic bytes, stored privately, sent as a document. */
export async function sendAttachmentAction(form: FormData): Promise<SendActionResult> {
  const user = await requireUser();
  const conversationId = id.parse(form.get("conversationId"));
  const caption = z.string().max(1000).optional().parse((form.get("caption") as string | null) || undefined);
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a file" };
  if (file.size > MAX_MEDIA_BYTES) return { ok: false, error: "Files up to 10 MB" };
  await assertCustomerConversation(conversationId);

  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, error: "Only JPG, PNG, WebP or PDF files" };
  const ext = ALLOWED_MEDIA[mime];
  const base = file.name.replace(/[^\w.\- ]/g, "_").replace(/\.[^.]*$/, "").slice(0, 80) || "attachment";
  const fileName = `${base}.${ext}`;
  const key = `chat/${conversationId}/out-${randomUUID()}.${ext}`;
  await getStorage().put(key, bytes, mime);
  const doc = await db.document.create({ data: { kind: "CHAT_MEDIA", storageKey: key, fileName, mimeType: mime, sizeBytes: bytes.length } });
  logger.info({ conversationId, documentId: doc.id, mime, size: bytes.length }, "chat attachment stored");
  return done(await send(conversationId, { type: "document", documentId: doc.id, caption }, { userId: user.id }));
}

export async function departureSnippetAction(departureId: string): Promise<string | null> {
  await requireUser();
  return departureSnippet(id.parse(departureId));
}

export async function markReadAction(conversationId: string) {
  await requireUser();
  await markRead(id.parse(conversationId));
}

const leadInput = z.object({
  departureId: id.nullable().optional(),
  pax: z.number().int().min(1).max(200).nullable().optional(),
  sourceNote: z.string().max(120).nullable().optional(),
  temp: z.enum(["NEW", "COLD", "WARM", "HOT"]).optional(),
});

export async function updateLeadAction(conversationId: string, patch: z.input<typeof leadInput>) {
  const user = await requireUser();
  const parsed = leadInput.safeParse(patch);
  if (!parsed.success) return { ok: false as const, error: "Check the lead details" };
  await assertCustomerConversation(id.parse(conversationId));
  await updateLead(conversationId, parsed.data, { id: user.id, role: user.role }, clientIp(await headers()));
  revalidatePath("/inbox");
  return { ok: true as const };
}

// ───────────────────────────── deal desk (DESK-1 … DESK-7) ─────────────────────────────
// Thin wrappers: requireUser + zod, then deals.*. Prices are integer paise and are only ever the
// REQUESTED input: the domain re-derives every price and checks it for the caller's role.

const paise = z.number().int().positive().max(100_000_000);
const code = z.string().trim().min(1).max(40);
const pax = z.number().int().min(1).max(200);

export type DealActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: DealErrorCode; reason?: string };

async function deal<T>(fn: (actor: DealActor, ip: string) => Promise<T>, revalidate = true): Promise<DealActionResult<T>> {
  const user = await requireUser();
  try {
    const data = await fn({ id: user.id, role: user.role }, clientIp(await headers()));
    if (revalidate) revalidatePath("/inbox");
    return { ok: true, data };
  } catch (err) {
    if (err instanceof DealError) return { ok: false, error: err.message, code: err.code, reason: err.reason };
    throw err;
  }
}

function invalid(e: z.ZodError): DealActionResult<never> {
  return { ok: false, error: e.issues[0]?.message ?? "Check the details", code: "INVALID" };
}

const previewInput = z.object({ conversationId: id, code, pax, requestedPricePerPax: paise.nullable().optional() });

/** Live quote-builder preview. The response is role-filtered (no floor/cost/margin for STAFF). */
export async function previewQuoteAction(input: z.input<typeof previewInput>): Promise<DealActionResult<QuotePreview>> {
  const p = previewInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  return deal((actor) => previewQuote(p.data, actor), false);
}

const sendQuoteInput = z.object({ conversationId: id, code, pax, pricePerPax: paise, confirmBelowFloor: z.boolean().optional() });

export async function sendQuoteAction(input: z.input<typeof sendQuoteInput>): Promise<DealActionResult<{ quoteId: string; pricePerPax: number; totalAmount: number }>> {
  const p = sendQuoteInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  return deal(async (actor, ip) => {
    const q = await sendQuote(p.data, actor, { ip });
    return { quoteId: q.quoteId, pricePerPax: q.pricePerPax, totalAmount: q.totalAmount };
  });
}

// Note: no suggested price in the input. The suggestion always comes from the engine.
const askOwnerInput = z.object({ conversationId: id, code, pax, requestedPricePerPax: paise.nullable().optional(), note: z.string().max(300).nullable().optional() });

export async function askOwnerAction(input: z.input<typeof askOwnerInput>): Promise<DealActionResult<{ approvalId: string }>> {
  const p = askOwnerInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  return deal(async (actor) => ({ approvalId: (await askOwner(p.data, actor)).approvalId }));
}

const decideInput = z.object({
  approvalId: id,
  action: z.enum(["APPROVE", "COUNTER", "DECLINE"]),
  pricePerPax: paise.nullable().optional(),
  confirmBelowFloor: z.boolean().optional(),
  reason: z.string().max(300).nullable().optional(),
});

/** OWNER only (checked here and again in deals.decideApproval). */
export async function decideApprovalAction(input: z.input<typeof decideInput>): Promise<DealActionResult<{ status: string; sendError: string | null }>> {
  await requireUser("OWNER");
  const p = decideInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  const r = await deal(async (actor, ip) => {
    const d = await decideApproval(p.data, actor, { ip });
    return { status: d.status, sendError: "sendError" in d ? d.sendError : null };
  });
  revalidatePath(`/approvals/${p.data.approvalId}`);
  return r;
}

const linkInput = z.object({ quoteId: id, purpose: z.enum(["ADVANCE", "FULL"]).optional() });

export async function sendPaymentLinkAction(input: z.input<typeof linkInput>): Promise<DealActionResult<{ queued: true }>> {
  const p = linkInput.safeParse(input);
  if (!p.success) return invalid(p.error);
  return deal(async (actor) => {
    await sendPaymentLink(p.data, actor);
    return { queued: true as const };
  });
}

export async function sendFollowUpAction(conversationId: string): Promise<DealActionResult<{ via: "text" | "template" }>> {
  const p = id.safeParse(conversationId);
  if (!p.success) return invalid(p.error);
  return deal(async (actor) => ({ via: (await sendFollowUp({ conversationId: p.data }, actor)).via }));
}
