/** WhatsApp Cloud API webhook (INB-1). GET = subscription verify; POST = verify HMAC, persist, enqueue, 200. */
import { ingestMetaWebhook, verifySubscription } from "@/server/channels/webhook";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 3_000_000;

export function GET(req: Request) {
  return verifySubscription(new URL(req.url));
}

export async function POST(req: Request) {
  const raw = await req.text(); // raw bytes as sent: never re-serialise before verifying
  if (raw.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  try {
    const r = await ingestMetaWebhook("WHATSAPP", raw, req.headers);
    if (r.status !== 200) return Response.json({ error: r.reason }, { status: r.status });
    return Response.json({ ok: true, events: r.events.length });
  } catch (err) {
    logger.error({ err }, "whatsapp webhook ingest failed");
    return Response.json({ error: "temporary failure" }, { status: 503 }); // Meta retries
  }
}
