/**
 * Razorpay webhook ingestion (system design §5.2). Does the minimum in the request:
 * verify HMAC on the RAW body → INSERT WebhookEvent ON CONFLICT DO NOTHING → enqueue → 200.
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "../db";
import { logger } from "../logger";
import { enqueueReplacingFinished } from "../queue";
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

  // jobId dedupes a still-pending job; a finished job for an unprocessed event is replaced.
  await enqueueReplacingFinished("payment.apply", { webhookEventId }, `payment-apply-${webhookEventId}`);
  return { status: 200, webhookEventId, duplicate };
}
