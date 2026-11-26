/**
 * Seat inventory (BKG-4, system design §5.3).
 *
 * Seats taken are DERIVED: Σ pax of HELD + CONFIRMED + COMPLETED bookings. There is no counter
 * to drift. Every hold locks the Departure row (SELECT … FOR UPDATE) inside the caller's
 * transaction, so concurrent holds serialise and overbooking is impossible. The caller inserts
 * (or re-activates) the booking in the SAME transaction, before the lock is released at commit.
 */
import { Prisma } from "@prisma/client";
import { db, type Tx } from "../../db";

export const SEAT_HOLDING_STATUSES = ["HELD", "CONFIRMED", "COMPLETED"] as const;

export class SeatsUnavailable extends Error {
  readonly code = "SEATS_UNAVAILABLE";
  constructor(
    readonly departureId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Only ${available} seat(s) left; ${requested} requested`);
    this.name = "SeatsUnavailable";
  }
}

export class DepartureNotBookable extends Error {
  readonly code = "DEPARTURE_NOT_BOOKABLE";
  constructor(
    readonly departureId: string,
    readonly status: string,
  ) {
    super(`Departure is ${status.toLowerCase()} and can't take new holds`);
    this.name = "DepartureNotBookable";
  }
}

type Client = Tx | typeof db;

/** Seats taken on a departure, optionally ignoring one booking (used when re-holding it). */
export async function seatsTaken(departureId: string, client: Client = db, excludeBookingId?: string): Promise<number> {
  const rows = await client.$queryRaw<{ taken: bigint }[]>`
    SELECT COALESCE(SUM(pax), 0)::bigint AS taken
    FROM "Booking"
    WHERE "departureId" = ${departureId}
      AND status IN ('HELD', 'CONFIRMED', 'COMPLETED')
      ${excludeBookingId ? Prisma.sql`AND id <> ${excludeBookingId}` : Prisma.empty}`;
  return Number(rows[0]?.taken ?? 0);
}

export type HoldResult = { departureId: string; seatsTotal: number; taken: number; available: number };

/**
 * Lock the departure and check that `pax` more seats fit. Throws SeatsUnavailable otherwise.
 * MUST be called inside a transaction; the lock is held until that transaction ends.
 *
 * `allowClosed` lets a late payment re-hold seats on a departure that has since closed for sale.
 */
export async function holdSeats(
  tx: Tx,
  input: { departureId: string; pax: number; excludeBookingId?: string; allowClosed?: boolean },
): Promise<HoldResult> {
  if (!Number.isSafeInteger(input.pax) || input.pax <= 0) throw new RangeError("pax must be a positive integer");

  const locked = await tx.$queryRaw<{ id: string; seatsTotal: number; status: string }[]>`
    SELECT id, "seatsTotal", status::text AS status FROM "Departure" WHERE id = ${input.departureId} FOR UPDATE`;
  const dep = locked[0];
  if (!dep) throw new Error(`Departure ${input.departureId} not found`);
  const bookable = dep.status === "OPEN" || (input.allowClosed && dep.status === "CLOSED");
  if (!bookable) throw new DepartureNotBookable(dep.id, dep.status);

  const taken = await seatsTaken(dep.id, tx, input.excludeBookingId);
  const available = dep.seatsTotal - taken;
  if (input.pax > available) throw new SeatsUnavailable(dep.id, input.pax, Math.max(0, available));
  return { departureId: dep.id, seatsTotal: dep.seatsTotal, taken, available };
}

/**
 * Release a HELD booking's seats by cancelling it (seats are derived, so cancelling is releasing).
 * Returns false when the booking was no longer HELD (already paid, cancelled or expired).
 */
export async function releaseHold(tx: Tx, bookingId: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await tx.booking.updateMany({
    where: { id: bookingId, status: "HELD" },
    data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason, holdExpiresAt: null },
  });
  return count === 1;
}

/** Lock a booking row for the rest of the transaction. Returns false if it doesn't exist. */
export async function lockBooking(tx: Tx, bookingId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
  return rows.length === 1;
}
