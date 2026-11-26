/**
 * Redis connections.
 * - `redis` is the shared command connection (rate limits, locks, publish).
 * - `createRedis()` makes a dedicated connection (BullMQ workers, pub/sub subscribers).
 */
import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

export function createRedis(opts: RedisOptions = {}): Redis {
  const client = new Redis(env.REDIS_URL, {
    // Required by BullMQ for blocking connections; harmless elsewhere.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
  client.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));
  return client;
}

const globalForRedis = globalThis as unknown as { __lavigoRedis?: Redis };

export function getRedis(): Redis {
  globalForRedis.__lavigoRedis ??= createRedis({ maxRetriesPerRequest: 2 });
  return globalForRedis.__lavigoRedis;
}

/** Lazy shared connection: nothing connects until first use. */
export const redis: Redis = new Proxy({} as Redis, {
  get(_t, prop) {
    const client = getRedis();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
