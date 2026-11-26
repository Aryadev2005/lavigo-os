/** Queue → processor map. Queues without a processor yet are no-ops (later phases). */
import type { Processor } from "bullmq";
import { expireHold } from "@/server/domain/bookings";
import { createAndSendLink, runReminders } from "@/server/domain/dues";
import { applyPaymentEvent } from "@/server/domain/payments";
import { afterPaymentCaptured } from "@/server/domain/payments/effects";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { normalizeRazorpayEvent } from "@/server/payments/razorpay";
import { sweepWebhooks } from "@/server/payments/webhook";
import { renderItinerary, renderPaymentDocuments } from "@/server/pdf/render";
import { publish } from "@/server/pubsub";
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
  // Create (or reuse) a payment link and, unless send=false, send it with the payment_reminder template.
  "payment.createLink": async (job) =>
    createAndSendLink(job.data as { bookingId: string; purpose: "ADVANCE" | "BALANCE" | "FULL"; send?: boolean; requestedById?: string | null }),
  // All PDFs: invoice + receipt after a payment, or { kind: "invoice" | "itinerary" } on demand from the drawer.
  "invoice.render": async (job) => {
    const d = job.data as { bookingId: string; paymentId?: string; kind?: "invoice" | "itinerary"; departureId?: string };
    const result =
      d.kind === "itinerary" && d.departureId
        ? { itineraryDocumentId: (await renderItinerary(d.departureId, d.bookingId)).id }
        : await renderPaymentDocuments(d);
    await publish({ type: "booking.updated", payload: { bookingId: d.bookingId } }).catch(() => undefined);
    return result;
  },
  "reminders.daily": async () => runReminders(),
  "webhooks.sweep": async () => sweepWebhooks(),
  "hold.expire": async (job) => {
    const outcome = await expireHold((job.data as { bookingId: string }).bookingId);
    logger.info({ bookingId: (job.data as { bookingId: string }).bookingId, outcome }, "hold.expire");
    return { outcome };
  },
};
