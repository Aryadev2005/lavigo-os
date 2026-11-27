/** Instagram messaging webhook (INB-2), only when FEATURE_INSTAGRAM is on. Same flow as WhatsApp. */
import { env } from "@/server/env";
import { ingestMetaWebhook, verifySubscription } from "@/server/channels/webhook";
import { logger } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 3_000_000;
const disabled = () => Response.json({ error: "instagram disabled" }, { status: 404 });

export function GET(req: Request) {
  if (!env.FEATURE_INSTAGRAM) return disabled();
  return verifySubscription(new URL(req.url));
}

export async function POST(req: Request) {
  if (!env.FEATURE_INSTAGRAM) return disabled();
  // Refuse an oversized body before reading it (Caddy also caps requests at 22 MB).
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  const raw = await req.text(); // raw bytes as sent: never re-serialise before verifying
  if (raw.length > MAX_BODY) return Response.json({ error: "too large" }, { status: 413 });
  try {
    const r = await ingestMetaWebhook("INSTAGRAM", raw, req.headers);
    if (r.status !== 200) return Response.json({ error: r.reason }, { status: r.status });
    return Response.json({ ok: true, events: r.events.length });
  } catch (err) {
    logger.error({ err }, "instagram webhook ingest failed");
    return Response.json({ error: "temporary failure" }, { status: 503 });
  }
}
