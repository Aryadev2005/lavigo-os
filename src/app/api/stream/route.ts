/**
 * Server-Sent Events (system design §9). Authenticates the session, subscribes to the Redis
 * `events` channel and forwards each AppEvent as `data: {type, payload}`. Heartbeat every 25s.
 * Shared by Today/Bookings/Dues (P2) and the inbox (P3) through src/components/use-events.ts.
 */
import { logger } from "@/server/logger";
import { subscribe } from "@/server/pubsub";
import { currentUser } from "@/server/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const encoder = new TextEncoder();
  let cleanup: (() => Promise<void>) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      send("retry: 5000\n\n");
      const unsubscribe = await subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      let cleanedUp = false;
      cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        clearInterval(heartbeat);
        await unsubscribe().catch((err: unknown) => logger.warn({ err }, "sse unsubscribe failed"));
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      req.signal.addEventListener("abort", () => void cleanup?.());
    },
    cancel() {
      void cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // don't let a proxy buffer the stream
    },
  });
}
