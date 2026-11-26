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
  "payment.createLink",
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
  "webhooks.sweep",
  "approval.expire",
  "notify.owner",
  "booking.confirm",
  "voucher.send",
] as const;

export type QueueName = (typeof QUEUES)[number];

/**
 * Key prefix scoped to environment and stack, so a worker from another stack or mode sharing the
 * same Redis (a parallel worktree, a prod-image smoke test, the test suite) can never consume
 * these jobs. BullMQ forbids ':' in queue names, not in the prefix.
 */
export function queuePrefix(): string {
  return `lavigo:${process.env.NODE_ENV ?? "development"}:${process.env.COMPOSE_PROJECT_NAME || "default"}`;
}

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
    q = new Queue(name, { connection: trackedConnection(), prefix: queuePrefix(), defaultJobOptions: DEFAULT_JOB_OPTS });
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

/**
 * Enqueue with a fixed jobId, replacing a FINISHED (completed/failed) job of the same id.
 * Plain `jobId` dedupe would silently drop a legitimate retry (e.g. a webhook redelivered after
 * its job exhausted its attempts). Waiting/active/delayed jobs are left alone: that's the dedupe.
 */
export async function enqueueReplacingFinished<T extends object>(name: QueueName, data: T, jobId: string, opts: JobsOptions = {}) {
  const q = getQueue(name);
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.remove();
  }
  return q.add(name, data, { ...opts, jobId });
}

export function createWorker<T = unknown, R = unknown>(
  name: QueueName,
  processor: Processor<T, R>,
  opts: Omit<WorkerOptions, "connection" | "prefix"> = {},
): Worker<T, R> {
  const worker = new Worker<T, R>(name, processor, {
    connection: trackedConnection(),
    prefix: queuePrefix(),
    concurrency: 1,
    ...opts,
  });
  worker.on("failed", (job, err) =>
    logger.error({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"),
  );
  worker.on("error", (err) => logger.error({ queue: name, err: err.message }, "worker error"));
  return worker;
}

/** Cron jobs, in IST (system design §8). Registered by the worker at boot; upserts are idempotent. */
export const REPEATABLES: { queue: QueueName; pattern: string }[] = [
  { queue: "reminders.daily", pattern: "0 10 * * *" },
  { queue: "webhooks.sweep", pattern: "*/5 * * * *" },
  { queue: "followups.scan", pattern: "0 * * * *" },
  { queue: "rfq.nudge", pattern: "*/15 * * * *" },
];

export async function registerRepeatables(): Promise<void> {
  for (const r of REPEATABLES) {
    await getQueue(r.queue).upsertJobScheduler(`cron:${r.queue}`, { pattern: r.pattern, tz: "Asia/Kolkata" }, { name: r.queue, data: {} });
  }
}

/** Close queues, then every Redis connection handed to BullMQ (call after closing workers). */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await Promise.all([...connections].map((c) => c.quit().catch(() => c.disconnect())));
  connections.clear();
}
