/**
 * Bookings (SRS §4.5). Creation re-derives the price on the server (PRC-2, PRC-5):
 * the price passed in is only a request; pricing.canQuote decides whether this actor may use it.
 */
import type { Booking, BookingSource, Role } from "@prisma/client";
import { audit } from "../../audit";
import { db, type Tx } from "../../db";
import { logger } from "../../logger";
import { enqueue } from "../../queue";
import { addDays, todayIST } from "../../time";
import { holdSeats, lockBooking, releaseHold } from "../inventory";
import { canQuote, evaluatePrice, floorPrice, type CanQuoteResult, type PriceResult } from "../pricing";
import { getSettings } from "../settings";

export type Actor = { id: string; role: Role };

/** Long-running transactions here take row locks; give them room under contention. */
export const TX_OPTS = { maxWait: 15_000, timeout: 20_000 } as const;

export class PriceNotAllowed extends Error {
  readonly code = "PRICE_NOT_ALLOWED";
  constructor(readonly check: CanQuoteResult) {
    super(`Price not allowed: ${check.reason}`);
    this.name = "PriceNotAllowed";
  }
}

export class BookingStateError extends Error {
  readonly code = "BOOKING_STATE";
  constructor(message: string) {
    super(message);
    this.name = "BookingStateError";
  }
}

// ───────────────────────────── codes (BKG-3) ─────────────────────────────

/** Next booking code from the Postgres sequence: collision-free under concurrency. */
export async function nextBookingCode(client: Tx | typeof db = db): Promise<string> {
  const rows = await client.$queryRaw<{ n: bigint }[]>`SELECT nextval('booking_code_seq') AS n`;
  return `LVG-${rows[0]!.n.toString()}`;
}

// ───────────────────────────── pricing context ─────────────────────────────

/** PRC-3: a repeat traveller has a CONFIRMED or COMPLETED booking on an earlier departure. */
export async function isRepeatCustomer(client: Tx | typeof db, customerId: string, before: Date): Promise<boolean> {
  const n = await client.booking.count({
    where: {
      customerId,
      status: { in: ["CONFIRMED", "COMPLETED"] },
      OR: [{ departure: { startDate: { lt: before } } }, { kind: "CUSTOM", customStartDate: { lt: before } }],
    },
  });
  return n > 0;
}

/** Load everything evaluatePrice needs for a departure, from the DB (never from the client). */
export async function evaluateForDeparture(
  client: Tx | typeof db,
  input: { departureId: string; customerId?: string | null; pax: number; requestedPricePerPax?: number | null; now?: Date },
): Promise<{ result: PriceResult; departure: { id: string; startDate: Date; costPerPax: number; code: string } }> {
  const departure = await client.departure.findUniqueOrThrow({ where: { id: input.departureId } });
  const [settings, offers, repeat] = await Promise.all([
    getSettings(client),
    client.offer.findMany({ where: { enabled: true, OR: [{ departureId: null }, { departureId: departure.id }] } }),
    input.customerId ? isRepeatCustomer(client, input.customerId, departure.startDate) : Promise.resolve(false),
  ]);
  const result = evaluatePrice({
    departure: { id: departure.id, pricePerPax: departure.pricePerPax, costPerPax: departure.costPerPax, startDate: departure.startDate },
    pax: input.pax,
    isRepeatCustomer: repeat,
    today: todayIST(input.now),
    settings,
    offers,
    requestedPricePerPax: input.requestedPricePerPax ?? null,
  });
  return { result, departure };
}

/** An APPROVED/COUNTERED approval for exactly this departure + pax: the owner's price. */
async function approvedPriceFor(
  client: Tx | typeof db,
  approvalId: string | undefined,
  match: { departureId: string | null; pax: number },
): Promise<number | null> {
  if (!approvalId) return null;
  const a = await client.approval.findUnique({ where: { id: approvalId } });
  if (!a || (a.status !== "APPROVED" && a.status !== "COUNTERED") || a.decidedPricePerPax == null) return null;
  if (a.departureId !== match.departureId || (a.pax != null && a.pax !== match.pax)) return null;
  return a.decidedPricePerPax;
}

// ───────────────────────────── create (BKG-2) ─────────────────────────────

export type TravellerInput = {
  fullName: string;
  age?: number | null;
  gender?: "M" | "F" | "O" | null;
  phone?: string | null;
  isLead?: boolean;
  idType?: string | null;
  berthPref?: string | null;
};

export type CreateBookingInput = {
  customerId: string;
  pax: number;
  /** Requested per-person price in paise. Re-validated on the server. */
  pricePerPax: number;
  source: BookingSource;
  departureId?: string;
  custom?: { title: string; startDate: Date; costTotalPlanned: number };
  conversationId?: string | null;
  quoteId?: string | null;
  approvalId?: string;
  confirmBelowFloor?: boolean;
  travellers?: TravellerInput[];
  notes?: string | null;
  /** IP for the audit log. */
  ip?: string | null;
};

export type CreateBookingResult = { booking: Booking; check: CanQuoteResult };

/**
 * Create a HELD booking: validate the price for this actor, lock the departure, hold seats,
 * take a code from the sequence, insert, audit. Hold expiry is scheduled after commit.
 */
export async function createBooking(
  input: CreateBookingInput,
  actor: Actor,
  opts: { now?: Date; scheduleExpiry?: boolean } = {},
): Promise<CreateBookingResult> {
  const now = opts.now ?? new Date();
  if (!Number.isSafeInteger(input.pax) || input.pax <= 0) throw new RangeError("pax must be a positive integer");
  if (!input.departureId === !input.custom) throw new RangeError("Pass exactly one of departureId or custom");
  if (input.travellers && input.travellers.length > input.pax) throw new RangeError("More travellers than pax");

  const created = await db.$transaction(async (tx) => {
    const settings = await getSettings(tx);
    let check: CanQuoteResult;
    let costTotalPlanned: number;
    let startDate: Date;

    if (input.departureId) {
      const { result, departure } = await evaluateForDeparture(tx, {
        departureId: input.departureId,
        customerId: input.customerId,
        pax: input.pax,
        requestedPricePerPax: input.pricePerPax,
        now,
      });
      const approvedPrice = await approvedPriceFor(tx, input.approvalId, { departureId: departure.id, pax: input.pax });
      check = canQuote(result, input.pricePerPax, actor.role, { approvedPrice, confirmBelowFloor: input.confirmBelowFloor });
      if (!check.ok) throw new PriceNotAllowed(check);
      await holdSeats(tx, { departureId: departure.id, pax: input.pax });
      costTotalPlanned = departure.costPerPax * input.pax;
      startDate = departure.startDate;
    } else {
      // Custom trip: no list price or offers. Staff may not go below the floor on the planned cost.
      const custom = input.custom!;
      const costPerPax = Math.ceil(custom.costTotalPlanned / input.pax);
      const floor = floorPrice(costPerPax, settings.floorMarginBps);
      const approvedPrice = await approvedPriceFor(tx, input.approvalId, { departureId: null, pax: input.pax });
      check = canQuote(
        { floor, staffLimit: floor, isLargeGroup: input.pax >= settings.escalateGroupSizeAtLeast },
        input.pricePerPax,
        actor.role,
        { approvedPrice, confirmBelowFloor: input.confirmBelowFloor },
      );
      if (!check.ok) throw new PriceNotAllowed(check);
      costTotalPlanned = custom.costTotalPlanned;
      startDate = custom.startDate;
    }

    const code = await nextBookingCode(tx);
    const booking = await tx.booking.create({
      data: {
        code,
        kind: input.departureId ? "FIXED" : "CUSTOM",
        status: "HELD",
        source: input.source,
        customerId: input.customerId,
        departureId: input.departureId ?? null,
        customTitle: input.custom?.title ?? null,
        customStartDate: input.custom?.startDate ?? null,
        quoteId: input.quoteId ?? null,
        conversationId: input.conversationId ?? null,
        pax: input.pax,
        pricePerPax: input.pricePerPax,
        totalAmount: input.pricePerPax * input.pax,
        costTotalPlanned,
        balanceDueDate: addDays(startDate, -settings.balanceDueDaysBeforeTravel),
        holdExpiresAt: new Date(now.getTime() + settings.quoteValidityHours * 3_600_000),
        createdById: actor.id,
        notes: input.notes ?? null,
        travellers: input.travellers?.length
          ? { create: input.travellers.map((t, i) => ({ ...t, isLead: t.isLead ?? i === 0 })) }
          : undefined,
      },
    });

    await audit(
      { userId: actor.id, action: "booking.create", entityType: "Booking", entityId: booking.id, after: { code, pax: input.pax, pricePerPax: input.pricePerPax, reason: check.reason }, ip: input.ip },
      tx,
    );
    if (check.audit) {
      await audit(
        { userId: actor.id, action: check.audit, entityType: "Booking", entityId: booking.id, after: { pricePerPax: input.pricePerPax, reason: check.reason }, ip: input.ip },
        tx,
      );
    }
    return { booking, check };
  }, TX_OPTS);

  if (opts.scheduleExpiry !== false) await scheduleHoldExpiry(created.booking);
  return created;
}

// ───────────────────────────── hold expiry (BKG-4) ─────────────────────────────

/** Delayed `hold.expire` job at holdExpiresAt. jobId makes re-scheduling idempotent. */
export async function scheduleHoldExpiry(booking: Pick<Booking, "id" | "holdExpiresAt">): Promise<void> {
  if (!booking.holdExpiresAt) return;
  try {
    await enqueue(
      "hold.expire",
      { bookingId: booking.id },
      { jobId: `hold-expire-${booking.id}`, delay: Math.max(0, booking.holdExpiresAt.getTime() - Date.now()) },
    );
  } catch (err) {
    // The booking stands; a missed expiry only keeps seats held longer. Logged for ops.
    logger.error({ err, bookingId: booking.id }, "could not schedule hold expiry");
  }
}

export type ExpireOutcome = "expired" | "not_held" | "paid" | "not_due";

/** hold.expire job body: re-checks inside a transaction and cancels only if still HELD and unpaid. */
export async function expireHold(bookingId: string, now: Date = new Date()): Promise<ExpireOutcome> {
  return db.$transaction(async (tx) => {
    if (!(await lockBooking(tx, bookingId))) return "not_held";
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (b.status !== "HELD") return "not_held";
    if (b.paidAmount > 0) return "paid";
    if (!b.holdExpiresAt || b.holdExpiresAt > now) return "not_due";
    await releaseHold(tx, bookingId, "Hold expired: no advance received", now);
    return "expired";
  }, TX_OPTS);
}

// ───────────────────────────── state changes ─────────────────────────────

/** HELD → CONFIRMED inside the caller's transaction (payment applied, or owner confirms). */
export async function confirmBookingInTx(tx: Tx, booking: Booking, settings: { balanceDueDaysBeforeTravel: number }) {
  const start = booking.departureId
    ? (await tx.departure.findUniqueOrThrow({ where: { id: booking.departureId }, select: { startDate: true } })).startDate
    : booking.customStartDate;
  return tx.booking.update({
    where: { id: booking.id },
    data: {
      status: "CONFIRMED",
      holdExpiresAt: null,
      cancelledAt: null,
      cancelReason: null,
      balanceDueDate: start ? addDays(start, -settings.balanceDueDaysBeforeTravel) : booking.balanceDueDate,
    },
  });
}

/** BKG-7: cancel (releases seats, since seats are derived). Refunds are recorded manually in v1. */
export async function cancelBooking(bookingId: string, reason: string, actor: Actor, opts: { ip?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.$transaction(async (tx) => {
    if (!(await lockBooking(tx, bookingId))) throw new BookingStateError("Booking not found");
    const before = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
    if (before.status === "CANCELLED" || before.status === "COMPLETED") {
      throw new BookingStateError(`A ${before.status.toLowerCase()} booking can't be cancelled`);
    }
    const after = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason, holdExpiresAt: null },
    });
    await audit(
      {
        userId: actor.id,
        action: "booking.cancel",
        entityType: "Booking",
        entityId: bookingId,
        before: { status: before.status, paidAmount: before.paidAmount },
        after: { status: after.status, reason },
        ip: opts.ip,
      },
      tx,
    );
    return after;
  }, TX_OPTS);
}

/** BKG-8: add travellers; the total can't exceed pax. */
export async function addTravellers(bookingId: string, travellers: TravellerInput[], actor: Actor) {
  if (travellers.length === 0) return [];
  return db.$transaction(async (tx) => {
    if (!(await lockBooking(tx, bookingId))) throw new BookingStateError("Booking not found");
    const b = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { _count: { select: { travellers: true } } } });
    if (b._count.travellers + travellers.length > b.pax) {
      throw new BookingStateError(`Booking ${b.code} is for ${b.pax} travellers; ${b._count.travellers} already added`);
    }
    const hasLead = b._count.travellers > 0;
    const rows = [];
    for (const [i, t] of travellers.entries()) {
      rows.push(
        await tx.traveller.create({ data: { ...t, bookingId, isLead: t.isLead ?? (!hasLead && i === 0) } }),
      );
    }
    await audit({ userId: actor.id, action: "booking.travellers_add", entityType: "Booking", entityId: bookingId, after: { added: rows.length } }, tx);
    return rows;
  }, TX_OPTS);
}
