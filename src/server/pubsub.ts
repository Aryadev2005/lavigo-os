/**
 * Server → browser realtime events over Redis pub/sub (channel `events`).
 * The SSE route subscribes; anything in web or worker can publish.
 */
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { createRedis, redis } from "./redis";

export const EVENTS_CHANNEL = "events";

export type AppEvent =
  | { type: "message.created"; payload: { conversationId: string; messageId: string } }
  | { type: "message.updated"; payload: { conversationId: string; messageId: string } }
  | { type: "conversation.updated"; payload: { conversationId: string } }
  | { type: "approval.created"; payload: { approvalId: string } }
  | { type: "approval.decided"; payload: { approvalId: string } }
  | { type: "payment.received"; payload: { bookingId: string; amount: number } }
  | { type: "booking.updated"; payload: { bookingId: string } }
  | { type: "rfq.updated"; payload: { rfqId: string } }
  | { type: "settings.updated"; payload: Record<string, never> }
  | { type: "activity.created"; payload: { activityId: string; text: string; icon: string } }
  /** audience: only sessions with that role show it (default everyone). */
  | { type: "toast"; payload: { text: string; icon?: string; audience?: "OWNER" | "STAFF" } };

export async function publish(event: AppEvent): Promise<void> {
  await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
}

/** Subscribe with a dedicated connection. Returns an unsubscribe/cleanup function. */
export async function subscribe(handler: (event: AppEvent) => void): Promise<() => Promise<void>> {
  const sub: Redis = createRedis();
  sub.on("message", (_channel, raw) => {
    try {
      handler(JSON.parse(raw) as AppEvent);
    } catch (err) {
      logger.warn({ err }, "dropping malformed pubsub event");
    }
  });
  await sub.subscribe(EVENTS_CHANNEL);
  return async () => {
    await sub.unsubscribe(EVENTS_CHANNEL).catch(() => undefined);
    sub.disconnect();
  };
}
