/**
 * Run a scheduled job once: `make job name=reminders` (→ `pnpm job reminders`).
 * Enqueues onto the named queue (same stack-scoped prefix as the worker); the worker runs it.
 */
import { closeQueues, enqueue, QUEUES, type QueueName } from "../src/server/queue";

const ALIASES: Record<string, QueueName> = {
  reminders: "reminders.daily",
  followups: "followups.scan",
  nudges: "rfq.nudge",
  tickets: "tickets.windowReminders",
  prune: "maintenance.prune",
  sweep: "webhooks.sweep",
};

async function main() {
  const arg = process.argv[2];
  const name = (arg && (ALIASES[arg] ?? arg)) as QueueName | undefined;
  if (!name || !QUEUES.includes(name)) {
    console.error(`Usage: pnpm job <name>\n  aliases: ${Object.keys(ALIASES).join(", ")}\n  queues:  ${QUEUES.join(", ")}`);
    process.exit(2);
  }
  const job = await enqueue(name, { manual: true, at: new Date().toISOString() });
  console.log(`Enqueued ${name} (job ${job.id}). Watch it with: make logs s=worker`);
  await closeQueues();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
