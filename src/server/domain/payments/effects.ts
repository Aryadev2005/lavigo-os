/**
 * After-commit side effects of a captured payment (PAY-2 "then, async"). Each step is
 * best-effort and idempotent; a failure here never un-applies the payment.
 */
import { db } from "../../db";
import { logger } from "../../logger";
import { inr } from "../../money";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import type { ApplyOutcome } from ".";
import { onPaymentCaptured } from "./hooks";

export async function afterPaymentCaptured(r: { bookingId: string; paymentId: string; outcome: ApplyOutcome; amount: number }) {
  const steps: [string, () => Promise<unknown>][] = [
    [
      "invoice.render",
      () => enqueue("invoice.render", { bookingId: r.bookingId, paymentId: r.paymentId }, { jobId: `invoice-render-${r.paymentId}` }),
    ],
    [
      "activity",
      async () => {
        const b = await db.booking.findUniqueOrThrow({
          where: { id: r.bookingId },
          select: { code: true, pax: true, customer: { select: { name: true } }, departure: { select: { code: true } }, customTitle: true },
        });
        const what = b.departure?.code ?? b.customTitle ?? "custom trip";
        const flag = r.outcome === "over_capacity" ? " · ⚠ seats gone, owner to resolve" : "";
        const activity = await db.activityEvent.create({
          data: {
            type: "payment.received",
            icon: r.outcome === "over_capacity" ? "⚠️" : "💸",
            text: `${inr(r.amount)} received from ${b.customer.name} · ${b.code} (${b.pax} on ${what})${flag}`,
            actorType: "CUSTOMER",
            entityType: "Booking",
            entityId: r.bookingId,
          },
        });
        await publish({ type: "activity.created", payload: { activityId: activity.id, text: activity.text, icon: activity.icon } });
      },
    ],
    ["sse", () => publish({ type: "booking.updated", payload: { bookingId: r.bookingId } })],
    ["hook", () => onPaymentCaptured(r.bookingId, { paymentId: r.paymentId, amount: r.amount, outcome: r.outcome })],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      logger.error({ err, step: name, bookingId: r.bookingId }, "post-payment step failed");
    }
  }
}
