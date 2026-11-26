/**
 * Outbound messages: MINIMAL STUB for P2 (reminders, payment links).
 *
 * P3 (inbox) owns the real channels layer: provider adapters (WhatsApp Cloud API / Instagram /
 * fakes), the outbound.send queue, the 24h window and delivery statuses. On merge, keep the
 * `sendTemplate(target, templateName, vars)` signature and replace the body with P3's
 * implementation. This stub writes the Message row a real send would create (status SENT,
 * nothing leaves the building) and logs without PII.
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import { publish } from "../pubsub";

export type OutboundTarget = { conversationId: string } | { customerId: string };
export type TemplateVars = Record<string, string>;
export type SendResult =
  | { sent: true; messageId: string; conversationId: string; body: string }
  | { sent: false; reason: string };

/** Fill a template body: {{1}} → vars[variables[0]], … Missing values render as "". PURE. */
export function renderTemplate(template: { bodyPreview: string; variables: string[] }, vars: TemplateVars): string {
  return template.bodyPreview.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[template.variables[Number(n) - 1] ?? ""] ?? "");
}

/** The customer's WhatsApp conversation, created on first send if they have a phone number. */
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

export async function sendTemplate(
  target: OutboundTarget,
  templateName: string,
  vars: TemplateVars,
  opts: { authorUserId?: string | null } = {},
): Promise<SendResult> {
  const template = await db.messageTemplate.findUnique({ where: { name: templateName } });
  if (!template) return { sent: false, reason: `template ${templateName} not found` };
  if (template.metaStatus !== "APPROVED") return { sent: false, reason: `template ${templateName} is not approved` };

  const conversation = await resolveConversation(target);
  if (!conversation) return { sent: false, reason: "customer has no WhatsApp number" };

  const body = renderTemplate(template, vars);
  const message = await db.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: opts.authorUserId ? "OWNER" : "SYSTEM",
      authorUserId: opts.authorUserId ?? null,
      kind: "TEMPLATE",
      body,
      payload: { template: templateName, vars } as Prisma.InputJsonValue,
      status: "SENT", // stub: P3's adapter sets QUEUED → SENT → DELIVERED from provider statuses
    },
  });
  await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt } });
  logger.info({ template: templateName, conversationId: conversation.id, messageId: message.id }, "outbound template (stub)");
  await publish({ type: "message.created", payload: { conversationId: conversation.id, messageId: message.id } }).catch(() => undefined);
  return { sent: true, messageId: message.id, conversationId: conversation.id, body };
}
