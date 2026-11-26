/** PAY-6: the reminders job is idempotent: running it twice (or concurrently) sends nothing twice. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/queue", () => ({ enqueue: vi.fn(), enqueueReplacingFinished: vi.fn(), closeQueues: vi.fn() }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { createBooking, evaluateForDeparture } = await import("@/server/domain/bookings");
const { runReminders } = await import("@/server/domain/dues");
const { db } = await import("@/server/db");
const { addDays, todayIST } = await import("@/server/time");
const { ensureSettings, makeCustomer, makeDeparture, makeOwner } = await import("./fixtures");

beforeAll(async () => {
  await ensureSettings();
  for (const [key, offsetDays, action, templateName] of [
    ["before_7d", -7, "SEND_REMINDER", "payment_reminder"],
    ["late_7d", 7, "FLAG_OWNER", null],
  ] as const) {
    await db.reminderRule.upsert({
      where: { key },
      update: {},
      create: { key, name: key, description: key, anchor: "DUE_DATE", offsetDays, action, templateName, enabled: true },
    });
  }
  await db.messageTemplate.upsert({
    where: { name: "payment_reminder" },
    update: { metaStatus: "APPROVED" },
    create: {
      name: "payment_reminder",
      category: "UTILITY",
      purpose: "PAYMENT_REMINDER",
      bodyPreview: "Hi {{1}}, your balance of {{2}} for {{3}} is due on {{4}}. Pay here: {{5}}",
      variables: ["name", "amount", "trip", "due_date", "pay_link"],
      metaStatus: "APPROVED",
    },
  });
});
afterAll(() => db.$disconnect());

async function confirmedBookingDueIn(days: number) {
  const owner = await makeOwner();
  const customer = await makeCustomer();
  const dep = await makeDeparture({ daysOut: 40 });
  const { result } = await evaluateForDeparture(db, { departureId: dep.id, pax: 2 });
  const { booking } = await createBooking(
    { customerId: customer.id, departureId: dep.id, pax: 2, pricePerPax: result.autoOffer, source: "PHONE" },
    { id: owner.id, role: owner.role },
    { scheduleExpiry: false },
  );
  return db.booking.update({
    where: { id: booking.id },
    data: { status: "CONFIRMED", paidAmount: 500_000, balanceDueDate: addDays(todayIST(), days) },
  });
}

describe("runReminders (PAY-6)", () => {
  it("writes one ReminderLog and one message per booking/rule/day, however often it runs", async () => {
    const dueSoon = await confirmedBookingDueIn(7); // before_7d fires today
    const late = await confirmedBookingDueIn(-7); // late_7d (flag owner) fires today

    await runReminders();
    await Promise.all([runReminders(), runReminders()]); // a manual run racing the scheduled one

    const logs = await db.reminderLog.findMany({ where: { bookingId: { in: [dueSoon.id, late.id] } }, include: { rule: true } });
    expect(logs.map((l) => `${l.bookingId === dueSoon.id ? "dueSoon" : "late"}:${l.rule.key}:${l.status}`).sort()).toEqual([
      "dueSoon:before_7d:SENT",
      "late:late_7d:SENT",
    ]);

    const reminderMessages = await db.message.count({
      where: { conversation: { customerId: dueSoon.customerId }, kind: "TEMPLATE", direction: "OUTBOUND" },
    });
    expect(reminderMessages).toBe(1);
    expect(await db.paymentLink.count({ where: { bookingId: dueSoon.id, purpose: "BALANCE" } })).toBe(1);
    expect(await db.activityEvent.count({ where: { entityId: late.id, type: "reminder.flagged" } })).toBe(1);
  });
});
