/**
 * Worker process: BullMQ consumers + repeatable jobs (docs/03-system-design.md §8).
 * Phase 0: every queue is registered with a no-op processor; real jobs land in src/worker/jobs/*.
 */

import { rm, writeFile } from "node:fs/promises";
import type { Worker } from "bullmq";
import { assertEnv } from "@/server/env";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { closeQueues, createWorker, QUEUES } from "@/server/queue";
import { getRedis } from "@/server/redis";

const READY_FILE = "/tmp/worker.ready";

async function main() {
  const env = assertEnv();
  logger.info({ providers: env.providers, tz: process.env.TZ }, "worker starting");

  await db.$queryRaw`SELECT 1`;
  await getRedis().ping();

  const workers: Worker[] = QUEUES.map((name) =>
    createWorker(name, async (job) => {
      logger.info({ queue: name, jobId: job.id }, "no-op job (phase 0)");
      return { ok: true, noop: true };
    }),
  );
  await Promise.all(workers.map((w) => w.waitUntilReady()));
  await writeFile(READY_FILE, String(Date.now())).catch(() => undefined);
  logger.info({ queues: QUEUES.length }, "worker ready");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down");
    const timer = setTimeout(() => {
      logger.error("graceful shutdown timed out");
      process.exit(1);
    }, 25_000);
    try {
      await Promise.all(workers.map((w) => w.close()));
      await closeQueues();
      await db.$disconnect();
      getRedis().disconnect();
      await rm(READY_FILE, { force: true });
    } finally {
      clearTimeout(timer);
      logger.info("worker stopped");
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
