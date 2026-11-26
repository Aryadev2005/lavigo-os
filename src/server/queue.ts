/**
 * BullMQ helpers. Queue names match docs/03-system-design.md §8.
 * Web enqueues; the worker (src/worker) consumes. Slow/external work never runs in a request.
 */
import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "./logger";
import { createRedis } from "./redis";

export const QUEUES = [
  "inbound.process",
  "outbound.send",
  "payment.apply",
  "invoice.render",
  "hold.expire",
  "reminders.daily",
  "rfq.send",
  "rfq.parseReply",
  "rfq.nudge",
  "followups.scan",
  "tickets.windowReminders",
  "campaign.send",
  "campaign.attribute",
  "maintenance.prune",
] as const;

export type QueueName = (typeof QUEUES)[number];

/** BullMQ forbids ':' in queue names; dots are fine. Prefix keeps keys tidy in a shared Redis. */
const PREFIX = "lavigo";

export const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

const globalForQueues = globalThis as unknown as { __lavigoQueues?: Map<QueueName, Queue>; __lavigoQueueConns?: Set<Redis> };
const queues = (globalForQueues.__lavigoQueues ??= new Map());
// BullMQ never closes connections it was given, so we track and close them ourselves.
const connections = (globalForQueues.__lavigoQueueConns ??= new Set());

function trackedConnection(): Redis {
  const conn = createRedis();
  connections.add(conn);
  return conn;
}

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: trackedConnection(), prefix: PREFIX, defaultJobOptions: DEFAULT_JOB_OPTS });
    queues.set(name, q);
  }
  return q;
}

/**
 * Enqueue a job. Pass `jobId` to make the enqueue idempotent (BullMQ ignores duplicates).
 */
export async function enqueue<T extends object>(name: QueueName, data: T, opts: JobsOptions = {}) {
  return getQueue(name).add(name, data, opts);
}

export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  opts: Omit<WorkerOptions, "connection" | "prefix"> = {},
): Worker<T, R> {
  const worker = new Worker<T, R>(name, processor, {
    connection: trackedConnection(),
    prefix: PREFIX,
    concurrency: 1,
    ...opts,
  });
  worker.on("failed", (job, err) =>
    logger.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"),
  );
  worker.on("error", (err) => logger.error({ queue: name, err: err.message }, "worker error"));
  return worker;
}

/** Close queues, then every Redis connection handed to BullMQ (call after closing workers). */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await Promise.all([...connections].map((c) => c.quit().catch(() => c.disconnect())));
  connections.clear();
}
