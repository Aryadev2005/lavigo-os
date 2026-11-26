/** Queue → processor map. Queues without a processor yet are no-ops (later phases). */
import type { Processor, WorkerOptions } from "bullmq";
import { deliverMessage } from "@/server/channels/outbound";
import type { InboundEventPayload } from "@/server/channels/types";
import { applyStatus, ingestInbound, storeInboundMedia } from "@/server/domain/conversations/ingest";
import { expireHold } from "@/server/domain/bookings";
import { createQuoteLink, expireApproval, notifyOwnersOfApproval, scanFollowUps } from "@/server/domain/deals";
import { sendBookingConfirmation, sendInvoiceToChat } from "@/server/domain/deals/confirmations";
import * as suppliers from "@/server/domain/suppliers";
import { renderAndSendVoucher } from "@/server/domain/suppliers/voucher-job";
import { createAndSendLink, runReminders } from "@/server/domain/dues";
import { env } from "@/server/env";
import { applyPaymentEvent } from "@/server/domain/payments";
import { afterPaymentCaptured } from "@/server/domain/payments/effects";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { normalizeRazorpayEvent } from "@/server/payments/razorpay";
import { beginWebhookAttempt, markWebhookError, markWebhookProcessed, sweepWebhooks } from "@/server/webhook-events";
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

/** A status can arrive before our send stored the provider id; retry briefly, then give up quietly. */
const UNKNOWN_STATUS_GRACE_MS = 2 * 60_000;

/** inbound.process: one WhatsApp/Instagram message or status, from its persisted WebhookEvent. */
async function inboundProcess(data: { webhookEventId: string }) {
  const ev = await beginWebhookAttempt(data.webhookEventId);
  if (ev.processedAt) return { skipped: "already processed" };
  const item = ev.payload as unknown as InboundEventPayload;

  if (item.type === "status") {
    const r = await applyStatus(item.status);
    if (r === "unknown" && Date.now() - ev.receivedAt.getTime() < UNKNOWN_STATUS_GRACE_MS) {
      throw new Error("status for a message we haven't recorded yet");
    }
    await markWebhookProcessed(ev.id);
    return { status: r };
  }

  const outcome = await ingestInbound(item.message);
  // Media is fetched after the message is saved; a retry re-ingests (deduped) and retries the download.
  if (item.message.media) await storeInboundMedia(outcome.messageId);
  await markWebhookProcessed(ev.id);
  return outcome;
}

/** Queue-specific worker settings (system design §8). Others: concurrency 1. */
export const WORKER_OPTIONS: Partial<Record<QueueName, Omit<WorkerOptions, "connection" | "prefix">>> = {
  "inbound.process": { concurrency: 10 },
  // Global limiter: at most 10 provider sends per second across all workers.
  "outbound.send": { concurrency: 5, limiter: { max: 10, duration: 1000 } },
  "payment.apply": { concurrency: 5 },
  "hold.expire": { concurrency: 5 },
  "invoice.render": { concurrency: 2 },
};

export const PROCESSORS: Partial<Record<QueueName, Processor>> = {
  "inbound.process": async (job) => {
    const d = job.data as { webhookEventId: string };
    try {
      return await inboundProcess(d);
    } catch (err) {
      await markWebhookError(d.webhookEventId, err);
      throw err;
    }
  },
  "outbound.send": async (job) => {
    const attempts = job.opts.attempts ?? 1;
    return deliverMessage((job.data as { messageId: string }).messageId, { finalAttempt: job.attemptsMade + 1 >= attempts });
  },
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
  // From a quote (deal desk): hold seats → booking → link card. From Dues: create (or reuse) a link and,
  // unless send=false, send it with the payment_reminder template.
  "payment.createLink": async (job) => {
    const d = job.data as
      | { quoteId: string; purpose: "ADVANCE" | "FULL"; requestedById: string }
      | { bookingId: string; purpose: "ADVANCE" | "BALANCE" | "FULL"; send?: boolean; requestedById?: string | null };
    return "quoteId" in d ? createQuoteLink(d) : createAndSendLink(d);
  },
  // All PDFs: invoice + receipt after a payment, or { kind: "invoice" | "itinerary" } on demand from the drawer.
  "invoice.render": async (job) => {
    const d = job.data as { bookingId: string; paymentId?: string; kind?: "invoice" | "itinerary"; departureId?: string };
    const result =
      d.kind === "itinerary" && d.departureId
        ? { itineraryDocumentId: (await renderItinerary(d.departureId, d.bookingId)).id }
        : await renderPaymentDocuments(d);
    // DESK-6: the invoice follows the confirmation into the customer's chat (once).
    if (d.paymentId && "invoiceDocumentId" in result) {
      await sendInvoiceToChat(d.bookingId, result.invoiceDocumentId).catch((err) => logger.error({ err, bookingId: d.bookingId }, "invoice to chat failed"));
    }
    await publish({ type: "booking.updated", payload: { bookingId: d.bookingId } }).catch(() => undefined);
    return result;
  },
  "reminders.daily": async () => runReminders(),
  "webhooks.sweep": async () => sweepWebhooks(),
  "followups.scan": async () => scanFollowUps(),
  "approval.expire": async (job) => ({ outcome: await expireApproval((job.data as { approvalId: string }).approvalId) }),
  "booking.confirm": async (job) => ({ outcome: await sendBookingConfirmation((job.data as { bookingId: string }).bookingId) }),
  "rfq.send": async (job) => ({ outcome: await suppliers.sendToRecipient(job.data.recipientId, job.data.kind, job.data.quoteId) }),
  "rfq.parseReply": async (job) => suppliers.handleSupplierReply(job.data as { messageId: string; supplierId: string }),
  "rfq.nudge": async () => suppliers.scanNudges(),
  "voucher.send": async (job) => renderAndSendVoucher((job.data as { bookingId: string }).bookingId),
  "notify.owner": async (job) => notifyOwnersOfApproval((job.data as { approvalId: string }).approvalId, env.APP_URL),
  "hold.expire": async (job) => {
    const outcome = await expireHold((job.data as { bookingId: string }).bookingId);
    logger.info({ bookingId: (job.data as { bookingId: string }).bookingId, outcome }, "hold.expire");
    return { outcome };
  },
};
