/**
 * Razorpay webhook ingestion (system design §5.2). Does the minimum in the request:
 * verify HMAC on the RAW body → INSERT WebhookEvent ON CONFLICT DO NOTHING → enqueue → 200.
 */
import { createHash } from "node:crypto";
import { logger } from "../logger";
import { persistAndEnqueue } from "../webhook-events";
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

  // If this throws, the route answers 503, Razorpay retries, and the duplicate path (or the sweeper)
  // enqueues again.
  const r = await persistAndEnqueue("RAZORPAY", externalId, rawBody);
  return { status: 200, webhookEventId: r.webhookEventId, duplicate: r.duplicate };
}

/** Kept here for existing imports; the implementation is provider-agnostic. */
export { MAX_WEBHOOK_ATTEMPTS, SWEEP_MIN_AGE_MS, sweepWebhooks } from "../webhook-events";
