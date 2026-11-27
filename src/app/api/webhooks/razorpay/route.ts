/** Razorpay webhook (PAY-2). Verify HMAC on the RAW body, persist, enqueue, 200. Nothing slow here. */
import { logger } from "@/server/logger";
import { ingestRazorpayWebhook } from "@/server/payments/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;

export async function POST(req: Request) {
  // Refuse an oversized body before reading it (Caddy also caps requests at 22 MB).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  const raw = await req.text(); // raw bytes as sent: never re-serialise before verifying
  if (raw.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  try {
    const r = await ingestRazorpayWebhook(raw, req.headers);
    if (r.status !== 200) return Response.json({ error: r.reason }, { status: r.status });
    return Response.json({ ok: true, duplicate: r.duplicate });
  } catch (err) {
    // 5xx makes Razorpay retry; the WebhookEvent unique key keeps the retry idempotent.
    logger.error({ err }, "razorpay webhook ingest failed");
    return Response.json({ error: "temporary failure" }, { status: 503 });
  }
}
