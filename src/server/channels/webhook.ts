/**
 * Meta webhook ingestion (INB-1, INB-2): verify X-Hub-Signature-256 on the RAW body → split into
 * one WebhookEvent per message / status (unique by provider + id) → enqueue inbound.process → 200.
 * Duplicates whose processedAt is still null are re-enqueued (jobId = event id), as for payments.
 */
import { logger } from "../logger";
import { persistAndEnqueue } from "../webhook-events";
import { normalizeInstagramWebhook, type IgWebhook } from "./instagram";
import { metaAppSecret, safeEqual, verifyMetaSignature, waVerifyToken } from "./verify";
import { normalizeWhatsAppWebhook, type WaWebhook } from "./whatsapp";

export type MetaProvider = "WHATSAPP" | "INSTAGRAM";

export type MetaIngestResult =
  | { status: 401; reason: "bad_signature" }
  | { status: 400; reason: "bad_json" }
  | { status: 200; events: { webhookEventId: string; duplicate: boolean }[] };

export async function ingestMetaWebhook(provider: MetaProvider, rawBody: string, headers: Headers): Promise<MetaIngestResult> {
  if (!verifyMetaSignature(rawBody, headers.get("x-hub-signature-256"), metaAppSecret())) {
    logger.warn({ provider }, "meta webhook rejected: bad signature");
    return { status: 401, reason: "bad_signature" };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, reason: "bad_json" };
  }
  const items = provider === "WHATSAPP" ? normalizeWhatsAppWebhook(body as WaWebhook) : normalizeInstagramWebhook(body as IgWebhook);

  const events: { webhookEventId: string; duplicate: boolean }[] = [];
  // Sequential on purpose: if one enqueue throws, the route answers 5xx and Meta redelivers the
  // whole batch; already-persisted items are then re-enqueued through the duplicate path.
  for (const item of items) {
    const r = await persistAndEnqueue(provider, item.externalId, JSON.stringify(item.payload));
    events.push({ webhookEventId: r.webhookEventId, duplicate: r.duplicate });
  }
  return { status: 200, events };
}

/** GET subscription handshake: echo hub.challenge only for our verify token. */
export function verifySubscription(url: URL, token = waVerifyToken()): Response {
  const mode = url.searchParams.get("hub.mode");
  const given = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge && safeEqual(given, token)) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}
