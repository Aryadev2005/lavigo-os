/**
 * Payments & dues (SRS §4.6: PAY-4 … PAY-7) and the reminders.daily job.
 */
import type { PaymentPurpose, Prisma } from "@prisma/client";
import { audit } from "../../audit";
import { renderTemplate, sendTemplate } from "../../channels/outbound";
import { db } from "../../db";
import { logger } from "../../logger";
import { inr } from "../../money";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import { addDays, formatDate, istDateStringOf, istStartOfDay, todayIST, weekStart } from "../../time";
import type { Actor } from "../bookings";
import { createLink, NothingToCollect } from "../payments";
import { getSettings } from "../settings";
import { advanceUnpaid, daysLate, isOpen, planReminders, type PlannedReminder } from "./planner";

export { daysLate, planReminders } from "./planner";

// ───────────────────────────── shared loaders ─────────────────────────────

const openBookingInclude = {
  customer: { select: { id: true, name: true, phone: true } },
  departure: { select: { code: true, startDate: true, trip: { select: { name: true, title: true } } } },
} satisfies Prisma.BookingInclude;

type OpenBooking = Prisma.BookingGetPayload<{ include: typeof openBookingInclude }>;

async function loadOpenBookings(): Promise<OpenBooking[]> {
  const rows = await db.booking.findMany({
    where: { status: { in: ["HELD", "CONFIRMED"] } },
    include: openBookingInclude,
  });
  return rows.filter((b) => b.paidAmount < b.totalAmount);
}

export function travelDateOf(b: { departure: { startDate: Date } | null; customStartDate: Date | null }): Date | null {
  return b.departure?.startDate ?? b.customStartDate;
}

export function tripLabel(b: { departure: { startDate: Date; trip: { name: string } } | null; customTitle: string | null; customStartDate: Date | null }) {
  if (b.departure) return `${b.departure.trip.name} trip (${formatDate(b.departure.startDate)})`;
  return `${b.customTitle ?? "custom trip"}${b.customStartDate ? ` (${formatDate(b.customStartDate)})` : ""}`;
}

function firstName(name: string): string {
  return name.split(/[\s&]/)[0] || name;
}

// ───────────────────────────── board (PAY-4, PAY-5) ─────────────────────────────

export type DueRow = {
  bookingId: string;
  code: string;
  customerName: string;
  phone: string | null;
  tripName: string;
  balance: number;
  balanceDueDate: Date | null;
  daysLate: number;
  remindersSent: number;
};

export type DuesBoard = {
  aging: { notDue: number; late1to7: number; late8plus: number; collectedThisWeek: number };
  rows: DueRow[];
  lateCount: number;
};

/** Reminders actually sent per booking (automatic rules; ReminderLog SENT on SEND_REMINDER rules). */
async function reminderCounts(bookingIds: string[]): Promise<Map<string, number>> {
  if (!bookingIds.length) return new Map();
  const grouped = await db.reminderLog.groupBy({
    by: ["bookingId"],
    where: { bookingId: { in: bookingIds }, status: "SENT", rule: { action: "SEND_REMINDER" } },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.bookingId, g._count._all]));
}

export async function getDuesBoard(now: Date = new Date()): Promise<DuesBoard> {
  const today = todayIST(now);
  const open = await loadOpenBookings();
  const counts = await reminderCounts(open.map((b) => b.id));

  const rows: DueRow[] = open
    .map((b) => ({
      bookingId: b.id,
      code: b.code,
      customerName: b.customer.name,
      phone: b.customer.phone,
      tripName: b.departure ? b.departure.trip.title.split(" ·")[0]! : (b.customTitle ?? "Custom trip"),
      balance: b.totalAmount - b.paidAmount,
      balanceDueDate: b.balanceDueDate,
      daysLate: Math.max(0, daysLate(b.balanceDueDate, today)),
      remindersSent: counts.get(b.id) ?? 0,
    }))
    // Most late first; then soonest due; undated last.
    .sort(
      (a, b) =>
        b.daysLate - a.daysLate ||
        (a.balanceDueDate?.getTime() ?? Infinity) - (b.balanceDueDate?.getTime() ?? Infinity) ||
        a.code.localeCompare(b.code),
    );

  const sum = (f: (r: DueRow) => boolean) => rows.filter(f).reduce((s, r) => s + r.balance, 0);
  const collected = await db.payment.aggregate({
    where: { status: "CAPTURED", receivedAt: { gte: istStartOfDay(weekStart(today)) } },
    _sum: { amount: true },
  });

  return {
    aging: {
      notDue: sum((r) => r.daysLate === 0),
      late1to7: sum((r) => r.daysLate >= 1 && r.daysLate <= 7),
      late8plus: sum((r) => r.daysLate >= 8),
      collectedThisWeek: collected._sum.amount ?? 0,
    },
    rows,
    lateCount: rows.filter((r) => r.daysLate > 0).length,
  };
}

/** Late bookings (count + those ≥ N days late) for Today and the sidebar badge. */
export async function getLateBookings(now: Date = new Date(), minDaysLate = 1) {
  const board = await getDuesBoard(now);
  return board.rows.filter((r) => r.daysLate >= minDaysLate);
}

// ───────────────────────────── rules (PAY-6) ─────────────────────────────

export async function listReminderRules() {
  const rules = await db.reminderRule.findMany();
  const order = ["before_7d", "on_due", "late_3d", "late_7d", "seat_release"];
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return rules.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

export async function setReminderRule(key: string, enabled: boolean, actor: Actor, ip?: string | null) {
  return db.$transaction(async (tx) => {
    const before = await tx.reminderRule.findUniqueOrThrow({ where: { key } });
    const after = await tx.reminderRule.update({ where: { key }, data: { enabled } });
    await audit(
      { userId: actor.id, action: "reminders.rule_toggle", entityType: "ReminderRule", entityId: before.id, before: { enabled: before.enabled }, after: { enabled }, ip },
      tx,
    );
    return after;
  });
}

// ───────────────────────────── preview (PAY-7) ─────────────────────────────

export type ReminderPreview = { customerName: string; body: string; templateName: string } | null;

/** The payment_reminder template rendered with the most-late customer's real data. */
export async function getReminderPreview(now: Date = new Date()): Promise<ReminderPreview> {
  const [template, board] = await Promise.all([
    db.messageTemplate.findUnique({ where: { name: "payment_reminder" } }),
    getDuesBoard(now),
  ]);
  const top = board.rows[0];
  if (!template || !top) return null;
  const b = await db.booking.findUniqueOrThrow({ where: { id: top.bookingId }, include: openBookingInclude });
  const link = await db.paymentLink.findFirst({
    where: { bookingId: b.id, purpose: "BALANCE", status: "CREATED", amount: top.balance },
    orderBy: { createdAt: "desc" },
  });
  return {
    customerName: b.customer.name,
    templateName: template.name,
    body: renderTemplate(template, reminderVars(b, link?.shortUrl ?? "(UPI link added when sent)")),
  };
}

function reminderVars(b: OpenBooking, payLink: string) {
  return {
    name: firstName(b.customer.name),
    amount: inr(b.totalAmount - b.paidAmount),
    trip: tripLabel(b),
    due_date: b.balanceDueDate ? formatDate(b.balanceDueDate, "d MMM") : "before travel",
    pay_link: payLink,
    booking_code: b.code,
  };
}

// ───────────────────────────── sending a link (PAY-5) ─────────────────────────────

/** Queue: create (or reuse) a link in the worker and send it on WhatsApp. Never in the request. */
export async function queuePaymentLink(
  bookingId: string,
  purpose: PaymentPurpose,
  actor: Actor | null,
  opts: { send?: boolean; reason?: "manual" | "remind_all" | "new_booking" } = {},
) {
  const day = istDateStringOf(todayIST());
  // One job per booking/purpose/day/actor action: double-clicks collapse; tomorrow is a new send.
  const jobId = `link-${bookingId}-${purpose}-${day}-${opts.reason ?? "manual"}`;
  await enqueue(
    "payment.createLink",
    { bookingId, purpose, send: opts.send ?? true, requestedById: actor?.id ?? null },
    { jobId },
  );
  return { jobId };
}

export type SendLinkResult = { linkId: string; shortUrl: string; amount: number; reused: boolean; sent: boolean; reason?: string };

/** payment.createLink job body: create/reuse the link, then send it with the payment_reminder template. */
export async function createAndSendLink(data: {
  bookingId: string;
  purpose: PaymentPurpose;
  send?: boolean;
  requestedById?: string | null;
}): Promise<SendLinkResult> {
  const link = await createLink(data.bookingId, data.purpose);
  let sent = false;
  let reason: string | undefined;
  if (data.send !== false) {
    const b = await db.booking.findUniqueOrThrow({ where: { id: data.bookingId }, include: openBookingInclude });
    const r = await sendTemplate({ customerId: b.customerId }, "payment_reminder", reminderVars(b, link.shortUrl), {
      authorUserId: data.requestedById,
    });
    sent = r.sent;
    if (!r.sent) reason = r.reason;
    const activity = await db.activityEvent.create({
      data: {
        type: r.sent ? "payment_link.sent" : "payment_link.created",
        icon: "💬",
        text: r.sent
          ? `${data.purpose === "ADVANCE" ? "Advance" : "Balance"} link for ${inr(link.amount)} sent to ${b.customer.name} on WhatsApp`
          : `${data.purpose === "ADVANCE" ? "Advance" : "Balance"} link for ${inr(link.amount)} ready for ${b.customer.name} (${r.reason})`,
        actorType: data.requestedById ? "USER" : "SYSTEM",
        entityType: "Booking",
        entityId: b.id,
      },
    });
    await publish({ type: "activity.created", payload: { activityId: activity.id, text: activity.text, icon: activity.icon } }).catch(() => undefined);
  }
  await publish({ type: "booking.updated", payload: { bookingId: data.bookingId } }).catch(() => undefined);
  return { linkId: link.linkId, shortUrl: link.shortUrl, amount: link.amount, reused: link.reused, sent, reason };
}

/** "Remind everyone late": one queued link + message per late booking. */
export async function remindAllLate(actor: Actor, now: Date = new Date()) {
  const late = await getLateBookings(now, 1);
  for (const r of late) await queuePaymentLink(r.bookingId, "BALANCE", actor, { send: true, reason: "remind_all" });
  return { queued: late.length };
}

// ───────────────────────────── reminders.daily (PAY-6) ─────────────────────────────

export type RunRemindersResult = { planned: number; sent: number; flagged: number; released: number; skipped: number; failed: number };

/**
 * Evaluate every enabled rule for today and act on each (booking, rule, day) exactly once.
 * The ReminderLog row is CLAIMED first (unique key); a concurrent or repeated run skips it.
 */
export async function runReminders(now: Date = new Date()): Promise<RunRemindersResult> {
  const today = todayIST(now);
  const [settings, rules, open] = await Promise.all([getSettings(), db.reminderRule.findMany(), loadOpenBookings()]);
  const plan = planReminders(
    open.map((b) => ({
      id: b.id,
      status: b.status,
      totalAmount: b.totalAmount,
      paidAmount: b.paidAmount,
      balanceDueDate: b.balanceDueDate,
      travelDate: travelDateOf(b),
    })),
    rules,
    today,
    { advancePctBps: settings.advancePctBps },
  );

  const result: RunRemindersResult = { planned: plan.length, sent: 0, flagged: 0, released: 0, skipped: 0, failed: 0 };
  const byId = new Map(open.map((b) => [b.id, b]));
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  for (const p of plan) {
    const claimed = await claim(p);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }
    try {
      const outcome = await act(p, byId.get(p.bookingId)!, ruleById.get(p.ruleId)!.templateName, today);
      await db.reminderLog.update({
        where: { id: claimed },
        data: { status: outcome.status, messageId: outcome.messageId ?? null, detail: outcome.detail },
      });
      if (outcome.status === "SENT") {
        if (p.action === "SEND_REMINDER") result.sent += 1;
        if (p.action === "FLAG_OWNER") result.flagged += 1;
        if (p.action === "RELEASE_SEATS") result.released += 1;
      } else result.skipped += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, bookingId: p.bookingId, rule: p.ruleKey }, "reminder failed");
      await db.reminderLog.update({ where: { id: claimed }, data: { status: "FAILED", detail: String(err).slice(0, 300) } });
    }
  }
  logger.info(result, "reminders.daily");
  return result;
}

/** Insert the log row first. Returns its id, or null if this (booking, rule, day) already ran. */
async function claim(p: PlannedReminder): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "ReminderLog" (id, "bookingId", "ruleId", "scheduledFor", status, detail, "createdAt")
    VALUES (gen_random_uuid()::text, ${p.bookingId}, ${p.ruleId}, ${p.scheduledFor}::date, 'FAILED', 'in progress', now())
    ON CONFLICT ("bookingId", "ruleId", "scheduledFor") DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

type ActOutcome = { status: "SENT" | "SKIPPED"; messageId?: string; detail: string };

async function act(p: PlannedReminder, b: OpenBooking, templateName: string | null, today: Date): Promise<ActOutcome> {
  const balance = b.totalAmount - b.paidAmount;
  const late = Math.max(0, daysLate(b.balanceDueDate, today));

  if (p.action === "SEND_REMINDER") {
    let link;
    try {
      link = await createLink(b.id, "BALANCE");
    } catch (err) {
      if (err instanceof NothingToCollect) return { status: "SKIPPED", detail: "nothing to collect" };
      throw err;
    }
    const r = await sendTemplate({ customerId: b.customerId }, templateName ?? "payment_reminder", reminderVars(b, link.shortUrl));
    if (!r.sent) return { status: "SKIPPED", detail: r.reason };
    await activity("reminder.sent", "⏰", `Balance reminder sent to ${b.customer.name} (${inr(balance)}${late ? `, ${late} days late` : ""})`, b.id);
    return { status: "SENT", messageId: r.messageId, detail: `${templateName} · ${link.shortUrl}` };
  }

  if (p.action === "FLAG_OWNER") {
    // No flag table: Needs-you lists bookings ≥ 7 days late straight from the dues query.
    await activity("reminder.flagged", "📞", `${b.customer.name} is ${late} days late on ${inr(balance)}: call today`, b.id);
    return { status: "SENT", detail: "flagged on Today" };
  }

  // RELEASE_SEATS: re-checked under the row lock; never touches a booking that paid its advance meanwhile.
  const settings = await getSettings();
  const released = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id} FOR UPDATE`;
    const fresh = await tx.booking.findUniqueOrThrow({ where: { id: b.id } });
    const travel = travelDateOf(b);
    if (!isOpen(fresh) || !advanceUnpaid({ ...fresh, balanceDueDate: fresh.balanceDueDate, travelDate: travel }, settings.advancePctBps)) return false;
    await tx.booking.update({
      where: { id: b.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Seat release: advance unpaid before travel", holdExpiresAt: null },
    });
    await audit(
      { userId: null, action: "booking.seat_release", entityType: "Booking", entityId: b.id, before: { status: fresh.status, paidAmount: fresh.paidAmount }, after: { status: "CANCELLED" } },
      tx,
    );
    return true;
  });
  if (!released) return { status: "SKIPPED", detail: "advance paid meanwhile" };
  await activity("booking.seats_released", "🪑", `Released ${b.pax} unpaid seat${b.pax > 1 ? "s" : ""} from ${b.code} (${b.customer.name})`, b.id);
  await publish({ type: "booking.updated", payload: { bookingId: b.id } }).catch(() => undefined);
  return { status: "SENT", detail: "seats released" };
}

async function activity(type: string, icon: string, text: string, bookingId: string) {
  const a = await db.activityEvent.create({ data: { type, icon, text, actorType: "SYSTEM", entityType: "Booking", entityId: bookingId } });
  await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
}

/** For callers that want the day a rule will next fire for a booking (drawer "reminders scheduled"). */
export function nextReminderDate(balanceDueDate: Date | null, today: Date, offsets: number[]): Date | null {
  if (!balanceDueDate) return null;
  const upcoming = offsets.map((o) => addDays(balanceDueDate, o)).filter((d) => d >= today).sort((a, b) => a.getTime() - b.getTime());
  return upcoming[0] ?? null;
}
