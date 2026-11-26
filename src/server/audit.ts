/**
 * AuditLog writer (AUTH-5): rule changes, approvals, manual payments, cancellations,
 * below-limit quotes. Pass the transaction client when auditing inside a transaction.
 */
import type { Prisma } from "@prisma/client";
import { db, type Tx } from "./db";

export type AuditAction =
  | "auth.login"
  | "auth.login_locked"
  | "rules.update"
  | "approval.approve"
  | "approval.counter"
  | "approval.decline"
  | "quote.below_limit"
  | "quote.below_floor"
  | "booking.create"
  | "booking.cancel"
  | "payment.manual"
  | "user.invite"
  | "user.deactivate"
  | (string & {});

export type AuditEntry = {
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  ip?: string | null;
};

export async function audit(entry: AuditEntry, client: Tx | typeof db = db): Promise<void> {
  await client.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
      ip: entry.ip ?? null,
    },
  });
}
