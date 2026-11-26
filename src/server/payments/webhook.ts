/**
 * Razorpay webhook ingestion (system design §5.2). Does the minimum in the request:
 * verify HMAC on the RAW body → INSERT WebhookEvent ON CONFLICT DO NOTHING → enqueue → 200.
 */
import { createHash, randomUUID } from "node:crypto";
import type { WebhookProvider } from "@prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import { publish } from "../pubsub";
import { enqueueReplacingFinished, type QueueName } from "../queue";
import { verifyWebhookSignature, webhookSecret } from "./razorpay";

export type IngestResult =
  | { status: 401; reason: "bad_signature" }
  | { status: 400; reason: "bad_json" }
  | { status: 200; webhookEventId: string; duplicate: boolean };

export async function ingestRazorpayWebhook(rawBody: string, headers: Headers): Promise<IngestResult> {
  if (!verifyWebhookSignature(rawBody, headers.get("x-razorpay-signature"), webhookSecret())) {
    logger.warn("razorpay webhook rejected: bad signature");
    return { status: 401, reason: "bad_signature" };
  }

  try {
    JSON.parse(rawBody); // must be valid JSON before it goes into the jsonb column
  } catch {
    return { status: 400, reason: "bad_json" };
  }

  // Razorpay sends a unique event id header; fall back to a body hash so retries still dedupe.
  const externalId = headers.get("x-razorpay-event-id") ?? `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;

  const inserted = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "WebhookEvent" (id, provider, "externalId", payload, "receivedAt", attempts)
    VALUES (${randomUUID()}, 'RAZORPAY', ${externalId}, ${rawBody}::jsonb, now(), 0)
    ON CONFLICT (provider, "externalId") DO NOTHING
    RETURNING id`;

  let webhookEventId: string;
  let duplicate = false;
  if (inserted[0]) {
    webhookEventId = inserted[0].id;
  } else {
    duplicate = true;
    const existing = await db.webhookEvent.findUniqueOrThrow({
      where: { provider_externalId: { provider: "RAZORPAY", externalId } },
      select: { id: true, processedAt: true },
    });
    webhookEventId = existing.id;
    // Already handled: a true no-op. Not yet handled (e.g. enqueue failed last time): enqueue again below.
    if (existing.processedAt) return { status: 200, webhookEventId, duplicate };
  }

  // jobId = event id: dedupes a still-pending job; a finished job for an unprocessed event is replaced.
  // If this throws, the route answers 503, Razorpay retries, and the duplicate branch above (or the
  // sweeper below) enqueues again.
  await enqueueWebhookJob("RAZORPAY", webhookEventId);
  return { status: 200, webhookEventId, duplicate };
}

// ───────────────────────────── recovery sweeper ─────────────────────────────

/** Which job processes each provider's events. P3 adds META → inbound.process. */
const PROCESSING_QUEUE: Partial<Record<WebhookProvider, QueueName>> = { RAZORPAY: "payment.apply" };

export const SWEEP_MIN_AGE_MS = 2 * 60_000;
export const MAX_WEBHOOK_ATTEMPTS = 10;
const GAVE_UP = "[gave up]";

function enqueueWebhookJob(provider: WebhookProvider, webhookEventId: string) {
  const queue = PROCESSING_QUEUE[provider];
  if (!queue) throw new Error(`No processing queue for ${provider} webhooks`);
  return enqueueReplacingFinished(queue, { webhookEventId }, webhookEventId);
}

/**
 * webhooks.sweep (every 5 min): re-enqueue events persisted but never processed (enqueue failed,
 * Redis blipped, job exhausted its retries). After MAX_WEBHOOK_ATTEMPTS processing attempts it
 * stops, logs an error and tells the owner via the activity feed, once.
 */
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
        text: `A ${ev.provider === "RAZORPAY" ? "Razorpay payment" : ev.provider} notification failed ${ev.attempts} times and needs checking (event ${ev.externalId.slice(0, 24)})`,
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
