/** PAY-6: each reminder rule fires on exactly one day; paid-in-full bookings are never chased. */
import { describe, expect, it } from "vitest";
import { planReminders, type PlannerBooking, type PlannerRule } from "@/server/domain/dues/planner";
import { addDays, dateOnly } from "@/server/time";

const DUE = dateOnly("2026-12-06");
const TRAVEL = dateOnly("2026-12-21");
const ADVANCE_BPS = 2500;

const RULES: PlannerRule[] = [
  { id: "r1", key: "before_7d", anchor: "DUE_DATE", offsetDays: -7, action: "SEND_REMINDER", enabled: true },
  { id: "r2", key: "on_due", anchor: "DUE_DATE", offsetDays: 0, action: "SEND_REMINDER", enabled: true },
  { id: "r3", key: "late_3d", anchor: "DUE_DATE", offsetDays: 3, action: "SEND_REMINDER", enabled: true },
  { id: "r4", key: "late_7d", anchor: "DUE_DATE", offsetDays: 7, action: "FLAG_OWNER", enabled: true },
  { id: "r5", key: "seat_release", anchor: "TRAVEL_DATE", offsetDays: -10, action: "RELEASE_SEATS", enabled: true },
];

const booking = (over: Partial<PlannerBooking> = {}): PlannerBooking => ({
  id: "b1",
  status: "CONFIRMED",
  totalAmount: 2_799_800,
  paidAmount: 700_000,
  balanceDueDate: DUE,
  travelDate: TRAVEL,
  ...over,
});

const keysOn = (day: Date, b: PlannerBooking = booking(), rules = RULES) =>
  planReminders([b], rules, day, { advancePctBps: ADVANCE_BPS }).map((p) => p.ruleKey);

describe("planReminders", () => {
  const cases: [string, Date][] = [
    ["before_7d", addDays(DUE, -7)],
    ["on_due", DUE],
    ["late_3d", addDays(DUE, 3)],
    ["late_7d", addDays(DUE, 7)],
  ];

  it.each(cases)("%s fires on its day, not the day before or after", (key, day) => {
    expect(keysOn(day)).toContain(key);
    expect(keysOn(addDays(day, -1))).not.toContain(key);
    expect(keysOn(addDays(day, 1))).not.toContain(key);
  });

  it("returns the booking, rule, action and date it planned", () => {
    expect(planReminders([booking()], RULES, addDays(DUE, 7), { advancePctBps: ADVANCE_BPS })).toEqual([
      { bookingId: "b1", ruleId: "r4", ruleKey: "late_7d", action: "FLAG_OWNER", scheduledFor: addDays(DUE, 7) },
    ]);
  });

  it("seat_release fires 10 days before travel only while the advance is unpaid", () => {
    const day = addDays(TRAVEL, -10);
    const unpaid = booking({ status: "HELD", paidAmount: 0 });
    expect(keysOn(day, unpaid)).toEqual(["seat_release"]);
    expect(keysOn(addDays(day, -1), unpaid)).toEqual([]);
    expect(keysOn(addDays(day, 1), unpaid)).toEqual([]);
    // Advance (25%) paid: seats are secured, never released.
    expect(keysOn(day, booking({ paidAmount: 700_000 }))).not.toContain("seat_release");
  });

  it("never reminds a booking paid in full, on any rule's day", () => {
    const paid = booking({ paidAmount: 2_799_800 });
    for (let d = -20; d <= 20; d++) expect(keysOn(addDays(DUE, d), paid)).toEqual([]);
    const overpaid = booking({ paidAmount: 2_900_000 });
    expect(keysOn(DUE, overpaid)).toEqual([]);
  });

  it("never reminds cancelled or completed bookings", () => {
    expect(keysOn(DUE, booking({ status: "CANCELLED" }))).toEqual([]);
    expect(keysOn(DUE, booking({ status: "COMPLETED" }))).toEqual([]);
  });

  it("skips disabled rules", () => {
    const rules = RULES.map((r) => (r.key === "on_due" ? { ...r, enabled: false } : r));
    expect(keysOn(DUE, booking(), rules)).toEqual([]);
  });
});
