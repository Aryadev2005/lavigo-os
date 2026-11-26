/**
 * Reminder planner (PAY-6). PURE: given open bookings, the rules and today's IST date, decide which
 * rule fires for which booking TODAY. A rule fires only on the exact day anchor + offsetDays, so the
 * daily job plus the ReminderLog(booking, rule, date) unique key make reminders exactly-once.
 */
import type { BookingStatus, ReminderAction, ReminderAnchor } from "@prisma/client";
import { addDays, daysBetween } from "../../time";
import { advanceAmount } from "../payments/amounts";

export type PlannerBooking = {
  id: string;
  status: BookingStatus;
  totalAmount: number;
  paidAmount: number;
  balanceDueDate: Date | null; // calendar date (IST)
  travelDate: Date | null; // departure start or custom start (IST)
};

export type PlannerRule = {
  id: string;
  key: string;
  anchor: ReminderAnchor;
  offsetDays: number;
  action: ReminderAction;
  enabled: boolean;
};

export type PlannedReminder = {
  bookingId: string;
  ruleId: string;
  ruleKey: string;
  action: ReminderAction;
  scheduledFor: Date;
};

/** Days past the balance due date (0 or negative = not late). */
export function daysLate(balanceDueDate: Date | null, today: Date): number {
  return balanceDueDate ? daysBetween(balanceDueDate, today) : 0;
}

export function isOpen(b: Pick<PlannerBooking, "status" | "totalAmount" | "paidAmount">): boolean {
  return (b.status === "HELD" || b.status === "CONFIRMED") && b.paidAmount < b.totalAmount;
}

/** Seat release only touches bookings that never secured their seats: still HELD, or advance not fully paid. */
export function advanceUnpaid(b: PlannerBooking, advancePctBps: number): boolean {
  return b.status === "HELD" || b.paidAmount < advanceAmount(b.totalAmount, advancePctBps);
}

export function planReminders(
  bookings: readonly PlannerBooking[],
  rules: readonly PlannerRule[],
  today: Date,
  opts: { advancePctBps: number },
): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const active = rules.filter((r) => r.enabled);
  for (const b of bookings) {
    if (!isOpen(b)) continue; // paid in full, cancelled or completed: never reminded
    for (const r of active) {
      const anchor = r.anchor === "DUE_DATE" ? b.balanceDueDate : b.travelDate;
      if (!anchor) continue;
      if (addDays(anchor, r.offsetDays).getTime() !== today.getTime()) continue;
      if (r.action === "RELEASE_SEATS" && !advanceUnpaid(b, opts.advancePctBps)) continue;
      out.push({ bookingId: b.id, ruleId: r.id, ruleKey: r.key, action: r.action, scheduledFor: today });
    }
  }
  return out;
}
