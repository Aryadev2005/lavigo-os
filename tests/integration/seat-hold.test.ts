import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBooking, evaluateForDeparture, expireHold } from "@/server/domain/bookings";
import { holdSeats, SeatsUnavailable, seatsTaken } from "@/server/domain/inventory";
import { db } from "@/server/db";
import { ensureSettings, makeCustomer, makeDeparture, makeOwner } from "./fixtures";

let owner: { id: string; role: "OWNER" | "STAFF" };
let customerId: string;

beforeAll(async () => {
  await ensureSettings();
  const o = await makeOwner();
  owner = { id: o.id, role: o.role };
  customerId = (await makeCustomer()).id;
});
afterAll(() => db.$disconnect());

async function book(departureId: string, pax: number) {
  const { result } = await evaluateForDeparture(db, { departureId, pax });
  return createBooking({ customerId, departureId, pax, pricePerPax: result.autoOffer, source: "PHONE" }, owner, { scheduleExpiry: false });
}

describe("seat holds (BKG-4, system design §5.3)", () => {
  it("10 concurrent holds for the last 6 seats: exactly one succeeds", async () => {
    const dep = await makeDeparture({ seatsTotal: 20 });
    await book(dep.id, 14); // 6 left

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(dep.id, 6)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const f of failed) expect(f.reason).toBeInstanceOf(SeatsUnavailable);
    expect(await seatsTaken(dep.id)).toBe(20);
    expect(await db.booking.count({ where: { departureId: dep.id, status: "HELD" } })).toBe(2);
  });

  it("concurrent small holds never oversell", async () => {
    const dep = await makeDeparture({ seatsTotal: 7 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(dep.id, 2)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await seatsTaken(dep.id)).toBe(6);
  });

  it("holdSeats refuses more than what's left and closed departures", async () => {
    const dep = await makeDeparture({ seatsTotal: 4 });
    await expect(db.$transaction((tx) => holdSeats(tx, { departureId: dep.id, pax: 5 }))).rejects.toBeInstanceOf(SeatsUnavailable);
    await db.departure.update({ where: { id: dep.id }, data: { status: "CLOSED" } });
    await expect(db.$transaction((tx) => holdSeats(tx, { departureId: dep.id, pax: 1 }))).rejects.toThrow(/closed/);
  });

  it("an expired hold releases its seats; a paid or not-yet-due hold does not", async () => {
    const dep = await makeDeparture({ seatsTotal: 10 });
    const { booking } = await book(dep.id, 4);
    expect(await expireHold(booking.id, new Date())).toBe("not_due");
    const later = new Date(booking.holdExpiresAt!.getTime() + 1000);
    expect(await expireHold(booking.id, later)).toBe("expired");
    expect(await seatsTaken(dep.id)).toBe(0);
    expect(await expireHold(booking.id, later)).toBe("not_held");

    const { booking: paid } = await book(dep.id, 2);
    await db.booking.update({ where: { id: paid.id }, data: { paidAmount: 100 } });
    expect(await expireHold(paid.id, later)).toBe("paid");
    expect(await seatsTaken(dep.id)).toBe(2);
  });

  it("booking codes come from the sequence and are unique under concurrency", async () => {
    const dep = await makeDeparture({ seatsTotal: 40 });
    const made = await Promise.all(Array.from({ length: 8 }, () => book(dep.id, 1)));
    const codes = made.map((m) => m.booking.code);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^LVG-\d{5,}$/);
  });
});
