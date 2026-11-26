/**
 * Conversation mutations for the inbox (INB-8) and the sandbox (INB-3). The send path itself lives
 * in channels/outbound.ts; inbound in ./ingest.ts.
 */
import { randomUUID } from "node:crypto";
import type { LeadTemp } from "@prisma/client";
import { audit } from "../../audit";
import { db } from "../../db";
import { publish } from "../../pubsub";
import type { Actor } from "../bookings";
import { ingestInbound } from "./ingest";

export { ingestInbound, applyStatus, storeInboundMedia } from "./ingest";

/** Opening a chat clears its unread count. */
export async function markRead(conversationId: string) {
  const { count } = await db.conversation.updateMany({ where: { id: conversationId, unreadCount: { gt: 0 } }, data: { unreadCount: 0 } });
  if (count) await publish({ type: "conversation.updated", payload: { conversationId } }).catch(() => undefined);
  return count > 0;
}

export type LeadPatch = { departureId?: string | null; pax?: number | null; sourceNote?: string | null; temp?: LeadTemp };

export async function updateLead(conversationId: string, patch: LeadPatch, actor: Actor, ip?: string) {
  const before = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { interestedDepartureId: true, paxCount: true, sourceNote: true, leadTemp: true },
  });
  const data = {
    ...(patch.departureId !== undefined ? { interestedDepartureId: patch.departureId } : {}),
    ...(patch.pax !== undefined ? { paxCount: patch.pax } : {}),
    ...(patch.sourceNote !== undefined ? { sourceNote: patch.sourceNote?.trim() || null } : {}),
    ...(patch.temp !== undefined ? { leadTemp: patch.temp } : {}),
  };
  const after = await db.conversation.update({
    where: { id: conversationId },
    data,
    select: { interestedDepartureId: true, paxCount: true, sourceNote: true, leadTemp: true },
  });
  await audit({ userId: actor.id, action: "conversation.lead_update", entityType: "Conversation", entityId: conversationId, before, after, ip });
  await publish({ type: "conversation.updated", payload: { conversationId } }).catch(() => undefined);
  return after;
}

// ───────────────────────────── sandbox (INB-3) ─────────────────────────────

/**
 * A sandbox customer chat. With a phone number it attaches to that customer (so bookings and
 * history line up); without one it's a fresh customer. Thread id is a uuid (system design §7).
 */
export async function createSandboxConversation(input: { name: string; phone?: string | null }, actor: Actor) {
  const phone = input.phone ?? null;
  const customer =
    (phone ? await db.customer.findUnique({ where: { phone } }) : null) ??
    (await db.customer.create({ data: { name: input.name, phone, notes: "Created from the sandbox" } }));
  const conversation = await db.conversation.create({
    data: { channel: "SANDBOX", externalThreadId: `sbx-${randomUUID()}`, customerId: customer.id, status: "NEW" },
  });
  await audit({ userId: actor.id, action: "sandbox.create", entityType: "Conversation", entityId: conversation.id });
  await publish({ type: "conversation.updated", payload: { conversationId: conversation.id } }).catch(() => undefined);
  return conversation;
}

export async function listSandboxConversations() {
  const rows = await db.conversation.findMany({
    where: { channel: "SANDBOX" },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    include: { customer: { select: { name: true, phone: true } } },
  });
  return rows.map((c) => ({ id: c.id, name: c.customer?.name ?? "Sandbox customer", phone: c.customer?.phone ?? null }));
}

/** Staff typing as the customer: the exact pipeline a WhatsApp message takes after its webhook. */
export async function sandboxCustomerSays(conversationId: string, text: string) {
  const conv = await db.conversation.findUnique({ where: { id: conversationId }, select: { channel: true, externalThreadId: true } });
  if (!conv || conv.channel !== "SANDBOX") throw new Error("not a sandbox conversation");
  return ingestInbound({
    channel: "SANDBOX",
    externalId: `sandbox.in.${randomUUID()}`,
    from: conv.externalThreadId,
    kind: "TEXT",
    text,
    timestamp: new Date().toISOString(),
  });
}
