/**
 * Provider-agnostic webhook persistence and recovery (system design §5.2, §8).
 *
 *   persistAndEnqueue: INSERT WebhookEvent ON CONFLICT DO NOTHING → enqueue the processing job
 *   (jobId = event id). A duplicate whose processedAt is still null is enqueued again: that's how a
 *   delivery whose enqueue failed recovers when the provider retries.
 *
 *   sweepWebhooks (webhooks.sweep, every 5 min): re-enqueue events persisted but never processed;
 *   after MAX_WEBHOOK_ATTEMPTS it stops and tells the owner once.
 */
import { randomUUID } from "node:crypto";
import type { WebhookProvider } from "@prisma/client";
import { db } from "./db";
import { logger } from "./logger";
import { publish } from "./pubsub";
import { enqueueReplacingFinished, type QueueName } from "./queue";

/** Which job processes each provider's events. */
export const PROCESSING_QUEUE: Partial<Record<WebhookProvider, QueueName>> = {
  RAZORPAY: "payment.apply",
  WHATSAPP: "inbound.process",
  INSTAGRAM: "inbound.process",
};

export const SWEEP_MIN_AGE_MS = 2 * 60_000;
export const MAX_WEBHOOK_ATTEMPTS = 10;
const GAVE_UP = "[gave up]";

export function enqueueWebhookJob(provider: WebhookProvider, webhookEventId: string) {
  const queue = PROCESSING_QUEUE[provider];
  if (!queue) throw new Error(`No processing queue for ${provider} webhooks`);
  return enqueueReplacingFinished(queue, { webhookEventId }, webhookEventId);
}

export type PersistResult = { webhookEventId: string; duplicate: boolean; enqueued: boolean };

/**
 * Persist one provider event (payload must be a JSON string) and enqueue its processing job.
 * Throws if the enqueue fails: the caller answers 5xx so the provider retries.
 */
export async function persistAndEnqueue(provider: WebhookProvider, externalId: string, payloadJson: string): Promise<PersistResult> {
  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "WebhookEvent" (id, provider, "externalId", payload, "receivedAt", attempts)
    VALUES (${randomUUID()}, ${provider}::"WebhookProvider", ${externalId}, ${payloadJson}::jsonb, now(), 0)
    ON CONFLICT (provider, "externalId") DO NOTHING
    RETURNING id`;

  if (inserted[0]) {
    await enqueueWebhookJob(provider, inserted[0].id);
    return { webhookEventId: inserted[0].id, duplicate: false, enqueued: true };
  }
  const existing = await db.webhookEvent.findUniqueOrThrow({
    where: { provider_externalId: { provider, externalId } },
    select: { id: true, processedAt: true },
  });
  // Already handled: a true no-op. Not yet handled (e.g. enqueue failed last time): enqueue again.
  if (existing.processedAt) return { webhookEventId: existing.id, duplicate: true, enqueued: false };
  await enqueueWebhookJob(provider, existing.id);
  return { webhookEventId: existing.id, duplicate: true, enqueued: true };
}

/** Start of a processing attempt: count it, and tell the caller whether there's anything left to do. */
export async function beginWebhookAttempt(webhookEventId: string) {
  return db.webhookEvent.update({ where: { id: webhookEventId }, data: { attempts: { increment: 1 } } });
}

export async function markWebhookProcessed(webhookEventId: string) {
  await db.webhookEvent.update({ where: { id: webhookEventId }, data: { processedAt: new Date(), error: null } });
}

export async function markWebhookError(webhookEventId: string, err: unknown) {
  await db.webhookEvent.update({ where: { id: webhookEventId }, data: { error: String(err).slice(0, 500) } }).catch(() => undefined);
}

const PROVIDER_LABEL: Record<WebhookProvider, string> = {
  RAZORPAY: "Razorpay payment",
  WHATSAPP: "WhatsApp message",
  INSTAGRAM: "Instagram message",
  EMAIL: "email",
};

export async function sweepWebhooks(now: Date = new Date()) {
  const stale = await db.webhookEvent.findMany({
    where: {
      provider: { in: Object.keys(PROCESSING_QUEUE) as WebhookProvider[] },
      processedAt: null,
      receivedAt: { lt: new Date(now.getTime() - SWEEP_MIN_AGE_MS) },
      OR: [{ error: null }, { NOT: { error: { startsWith: GAVE_UP } } }],
    },
    orderBy: { receivedAt: "asc" },
    take: 200,
    select: { id: true, provider: true, attempts: true, error: true, externalId: true },
  });

  let requeued = 0;
  let gaveUp = 0;
  for (const ev of stale) {
    if (ev.attempts < MAX_WEBHOOK_ATTEMPTS) {
      await enqueueWebhookJob(ev.provider, ev.id);
      requeued += 1;
      continue;
    }
    gaveUp += 1;
    const { count } = await db.webhookEvent.updateMany({
      where: { id: ev.id, processedAt: null },
      data: { error: `${GAVE_UP} ${ev.error ?? ""}`.trim().slice(0, 1000) },
    });
    if (count === 0) continue;
    logger.error({ webhookEventId: ev.id, provider: ev.provider, attempts: ev.attempts }, "webhook gave up after max attempts");
    const activity = await db.activityEvent.create({
      data: {
        type: "webhook.failed",
        icon: "⚠️",
        text: `A ${PROVIDER_LABEL[ev.provider]} notification failed ${ev.attempts} times and needs checking (event ${ev.externalId.slice(0, 24)})`,
        actorType: "SYSTEM",
        entityType: "WebhookEvent",
        entityId: ev.id,
      },
    });
    await publish({ type: "activity.created", payload: { activityId: activity.id, text: activity.text, icon: activity.icon } }).catch(() => undefined);
  }
  if (requeued || gaveUp) logger.info({ requeued, gaveUp }, "webhooks.sweep");
  return { requeued, gaveUp };
}
