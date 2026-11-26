/**
 * "Waiting for a reply": THE definition, used by the Today KPI, Today's Needs-you, the inbox
 * (pill + Needs-you tab) and the sidebar badge. Derived, never stored:
 *
 *   a customer conversation (not a supplier thread, not CLOSED) whose customer wrote last, i.e. no
 *   OUTBOUND message (any kind, including automatic system ones) that wasn't BLOCKED or FAILED
 *   was created after lastInboundAt.
 *
 * Callers narrow it by age (Needs-you: > 30 min) or by set (today's enquiries, a page of rows).
 */
import { Prisma } from "@prisma/client";
import { db } from "../../db";

export type WaitingRow = { id: string; name: string; lastInboundAt: Date };

export async function waitingConversations(
  opts: { olderThan?: Date; ids?: readonly string[] } = {},
): Promise<WaitingRow[]> {
  if (opts.ids && opts.ids.length === 0) return [];
  return db.$queryRaw<WaitingRow[]>`
    SELECT c.id, cu.name, c."lastInboundAt"
    FROM "Conversation" c
    JOIN "Customer" cu ON cu.id = c."customerId"
    WHERE c."supplierId" IS NULL
      AND c."lastInboundAt" IS NOT NULL
      AND c.status <> 'CLOSED'
      ${opts.olderThan ? Prisma.sql`AND c."lastInboundAt" < ${opts.olderThan}` : Prisma.empty}
      ${opts.ids ? Prisma.sql`AND c.id IN (${Prisma.join(opts.ids)})` : Prisma.empty}
      AND NOT EXISTS (
        SELECT 1 FROM "Message" m
        WHERE m."conversationId" = c.id AND m.direction = 'OUTBOUND'
          AND m.status NOT IN ('BLOCKED', 'FAILED')
          AND m."createdAt" > c."lastInboundAt"
      )
    ORDER BY c."lastInboundAt" ASC`;
}

export async function waitingIds(ids?: readonly string[]): Promise<Set<string>> {
  return new Set((await waitingConversations({ ids })).map((r) => r.id));
}
