/** Queue → processor map. Queues without a processor yet are no-ops (later phases). */
import type { Processor } from "bullmq";
import { expireHold } from "@/server/domain/bookings";
import { applyPaymentEvent, createLink } from "@/server/domain/payments";
import { afterPaymentCaptured } from "@/server/domain/payments/effects";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { normalizeRazorpayEvent } from "@/server/payments/razorpay";
import { renderPaymentDocuments } from "@/server/pdf/render";
import type { QueueName } from "@/server/queue";

/** payment.apply: load the persisted WebhookEvent, normalise, apply exactly once, then side effects. */
async function paymentApply(data: { webhookEventId: string }) {
  const ev = await db.webhookEvent.update({
    where: { id: data.webhookEventId },
    data: { attempts: { increment: 1 } },
  });
  if (ev.processedAt) return { skipped: "already processed" };

  const normalized = normalizeRazorpayEvent(ev.payload);
  if (!normalized) {
    await db.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date(), error: null } });
    return { skipped: "ignored event type" };
  }
  const result = await applyPaymentEvent({ ...normalized, webhookEventId: ev.id });
  if (result.status === "applied") await afterPaymentCaptured(result);
  if (result.status === "unmatched") logger.warn({ webhookEventId: ev.id, reason: result.reason }, "payment unmatched");
  return result;
}

export const PROCESSORS: Partial<Record<QueueName, Processor>> = {
  "payment.apply": async (job) => {
    try {
      return await paymentApply(job.data as { webhookEventId: string });
    } catch (err) {
      await db.webhookEvent
        .update({ where: { id: (job.data as { webhookEventId: string }).webhookEventId }, data: { error: String(err).slice(0, 500) } })
        .catch(() => undefined);
      throw err;
    }
  },
  "payment.createLink": async (job) => {
    const d = job.data as { bookingId: string; purpose: "ADVANCE" | "BALANCE" | "FULL" };
    return createLink(d.bookingId, d.purpose);
  },
  "invoice.render": async (job) => renderPaymentDocuments(job.data as { bookingId: string; paymentId?: string }),
  "hold.expire": async (job) => {
    const outcome = await expireHold((job.data as { bookingId: string }).bookingId);
    logger.info({ bookingId: (job.data as { bookingId: string }).bookingId, outcome }, "hold.expire");
    return { outcome };
  },
};
