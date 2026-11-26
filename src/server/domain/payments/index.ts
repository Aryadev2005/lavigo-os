/**
 * Payments (SRS §4.6, system design §5.2).
 *
 * applyPaymentEvent is THE money transaction: lock booking → insert Payment (unique
 * providerPaymentId) → paidAmount += amount → HELD/expired → CONFIRMED → link PAID.
 * The same event delivered twice, or two different events for one payment, never double-count
 * (PAY-3): duplicates are detected under the booking row lock, and the unique key backs that up.
 *
 * Side effects (invoice, activity, SSE, customer confirmation) run AFTER commit: see effects.ts.
 */
import { Prisma, type PaymentMethod, type PaymentPurpose, type PaymentProvider } from "@prisma/client";
import { audit } from "../../audit";
import { db, type Tx } from "../../db";
import { getPaymentGateway, type PaymentGateway } from "../../payments/razorpay";
import { confirmBookingInTx, TX_OPTS, type Actor } from "../bookings";
import { holdSeats, lockBooking, SeatsUnavailable } from "../inventory";
import { getSettings } from "../settings";
import { linkAmount } from "./amounts";

export class NothingToCollect extends Error {
  readonly code = "NOTHING_TO_COLLECT";
  constructor(bookingCode: string) {
    super(`${bookingCode} has nothing left to collect`);
    this.name = "NothingToCollect";
  }
}

// ───────────────────────────── link amounts & creation (PAY-1) ─────────────────────────────

export { advanceAmount, linkAmount, roundToRupee } from "./amounts";

export type CreateLinkResult = { linkId: string; providerLinkId: string; shortUrl: string; amount: number; reused: boolean };

/**
 * Create (or reuse) a payment link. Calls the gateway, so run it in the worker (payment.createLink),
 * never inside a request. An open link for the same purpose and amount is reused (PAY-5).
 */
export async function createLink(
  bookingId: string,
  purpose: PaymentPurpose,
  opts: { gateway?: PaymentGateway; now?: Date } = {},
): Promise<CreateLinkResult> {
  const now = opts.now ?? new Date();
  const booking = await db.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { customer: true, departure: { include: { trip: true } } },
  });
  if (booking.status === "CANCELLED") throw new Error(`${booking.code} is cancelled`);
  const settings = await getSettings();
  const amount = linkAmount(booking, purpose, settings.advancePctBps);
  if (amount <= 0) throw new NothingToCollect(booking.code);

  const open = await db.paymentLink.findFirst({
    where: { bookingId, purpose, status: "CREATED", amount, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
  });
  if (open) return { linkId: open.id, providerLinkId: open.providerLinkId, shortUrl: open.shortUrl, amount, reused: true };

  // ADVANCE links live as long as the seat hold; other links for 3 days.
  const expiresAt =
    purpose === "ADVANCE" && booking.holdExpiresAt && booking.holdExpiresAt > now
      ? booking.holdExpiresAt
      : new Date(now.getTime() + 3 * 24 * 3_600_000);
  const what = booking.departure ? booking.departure.trip.title : (booking.customTitle ?? "Custom trip");
  const label = purpose === "ADVANCE" ? "Advance" : purpose === "BALANCE" ? "Balance" : "Payment";

  const created = await (opts.gateway ?? getPaymentGateway()).createPaymentLink({
    amount,
    bookingCode: booking.code,
    purpose,
    description: `${label} for ${what} · ${booking.code} · ${booking.pax} traveller${booking.pax > 1 ? "s" : ""}`,
    expireBy: expiresAt,
    customer: { name: booking.customer.name, phone: booking.customer.phone, email: booking.customer.email },
  });
  const link = await db.paymentLink.create({
    data: { bookingId, purpose, amount, providerLinkId: created.providerLinkId, shortUrl: created.shortUrl, expiresAt },
  });
  return { linkId: link.id, providerLinkId: link.providerLinkId, shortUrl: link.shortUrl, amount, reused: false };
}

// ───────────────────────────── applying a captured payment ─────────────────────────────

export type PaymentEvent = {
  providerPaymentId: string;
  providerLinkId?: string | null;
  bookingCode?: string | null;
  amount: number; // paise actually captured (recorded as-is, even if ≠ link amount)
  method: PaymentMethod;
  capturedAt: Date;
  webhookEventId?: string | null;
};

export type ApplyOutcome =
  | "confirmed" // HELD → CONFIRMED
  | "paid" // already CONFIRMED: paidAmount went up
  | "reheld" // hold had expired/cancelled; seats were still free → CONFIRMED
  | "over_capacity"; // hold had expired and seats are gone → CONFIRMED + flagged + owner approval

export type ApplyResult =
  | { status: "applied"; bookingId: string; paymentId: string; outcome: ApplyOutcome; amount: number }
  | { status: "duplicate"; bookingId: string | null; paymentId: string }
  | { status: "unmatched"; reason: string };

type CapturedInput = {
  amount: number;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerPaymentId: string | null;
  paymentLinkId: string | null;
  receivedAt: Date;
  recordedById?: string | null;
  note?: string | null;
};

/**
 * The shared core: the booking row MUST already be locked by the caller (lockBooking).
 * Handles the expired/cancelled-hold edge case from system design §5.2.
 */
async function applyCapturedInTx(tx: Tx, bookingId: string, input: CapturedInput) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new RangeError("amount must be positive paise");
  const settings = await getSettings(tx);
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });

  const payment = await tx.payment.create({
    data: {
      bookingId,
      amount: input.amount,
      method: input.method,
      status: "CAPTURED",
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      paymentLinkId: input.paymentLinkId,
      receivedAt: input.receivedAt,
      recordedById: input.recordedById ?? null,
      note: input.note ?? null,
    },
  });

  let outcome: ApplyOutcome;
  let notes = booking.notes;

  if (booking.status === "CANCELLED") {
    // Money arrived for a hold that expired (or was cancelled). Try to take the seats back.
    if (booking.departureId) {
      try {
        await holdSeats(tx, { departureId: booking.departureId, pax: booking.pax, excludeBookingId: booking.id, allowClosed: true });
        outcome = "reheld";
      } catch (err) {
        if (!(err instanceof SeatsUnavailable)) throw err;
        // Never auto-refund: keep the money, confirm, flag, and ask the owner to resolve.
        outcome = "over_capacity";
        notes = [notes, `[OVER CAPACITY] Payment ${input.providerPaymentId ?? payment.id} arrived after the hold was released and the seats were taken (${err.available} left, ${booking.pax} needed).`]
          .filter(Boolean)
          .join("\n");
        await tx.approval.create({
          data: {
            kind: "OTHER",
            departureId: booking.departureId,
            conversationId: booking.conversationId,
            pax: booking.pax,
            summary: `Payment received for ${booking.code} but its seats are gone: owner to resolve (extra seats, move departure, or refund).`,
          },
        });
      }
    } else {
      outcome = "reheld"; // custom trips have no seat inventory
    }
  } else if (booking.status === "HELD") {
    outcome = "confirmed";
  } else {
    outcome = "paid";
  }

  if (booking.status === "HELD" || booking.status === "CANCELLED") {
    await confirmBookingInTx(tx, booking, settings);
  }
  await tx.booking.update({
    where: { id: bookingId },
    // paidAmount is only ever written here, inside the payment transaction.
    data: { paidAmount: { increment: input.amount }, notes },
  });

  return { payment, outcome };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** PAY-2 / PAY-3: apply a verified provider payment exactly once. */
export async function applyPaymentEvent(event: PaymentEvent): Promise<ApplyResult> {
  const existing = await db.payment.findUnique({ where: { providerPaymentId: event.providerPaymentId } });
  if (existing) {
    await markWebhookProcessed(event.webhookEventId, null);
    return { status: "duplicate", bookingId: existing.bookingId, paymentId: existing.id };
  }

  // Resolve the booking: by our link id first, then by the booking code in notes / reference_id.
  const link = event.providerLinkId ? await db.paymentLink.findUnique({ where: { providerLinkId: event.providerLinkId } }) : null;
  const bookingId =
    link?.bookingId ??
    (event.bookingCode ? (await db.booking.findUnique({ where: { code: event.bookingCode }, select: { id: true } }))?.id : undefined);
  if (!bookingId) {
    const reason = `No booking for payment ${event.providerPaymentId} (link ${event.providerLinkId ?? "—"}, code ${event.bookingCode ?? "—"})`;
    await markWebhookProcessed(event.webhookEventId, reason);
    return { status: "unmatched", reason };
  }

  try {
    return await db.$transaction(async (tx) => {
      await lockBooking(tx, bookingId);
      // Re-check under the lock: a concurrent delivery of the same payment may have just committed.
      const dup = await tx.payment.findUnique({ where: { providerPaymentId: event.providerPaymentId } });
      if (dup) {
        if (event.webhookEventId) {
          await tx.webhookEvent.update({ where: { id: event.webhookEventId }, data: { processedAt: new Date(), error: null } });
        }
        return { status: "duplicate" as const, bookingId, paymentId: dup.id };
      }

      const { payment, outcome } = await applyCapturedInTx(tx, bookingId, {
        amount: event.amount,
        method: event.method,
        provider: "RAZORPAY",
        providerPaymentId: event.providerPaymentId,
        paymentLinkId: link?.id ?? null,
        receivedAt: event.capturedAt,
      });
      if (link && link.status === "CREATED") {
        await tx.paymentLink.update({ where: { id: link.id }, data: { status: "PAID" } });
      }
      if (event.webhookEventId) {
        await tx.webhookEvent.update({ where: { id: event.webhookEventId }, data: { processedAt: new Date(), error: null } });
      }
      return { status: "applied" as const, bookingId, paymentId: payment.id, outcome, amount: event.amount };
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const dup = await db.payment.findUnique({ where: { providerPaymentId: event.providerPaymentId } });
      if (dup) {
        await markWebhookProcessed(event.webhookEventId, null);
        return { status: "duplicate", bookingId: dup.bookingId, paymentId: dup.id };
      }
    }
    throw err;
  }
}

async function markWebhookProcessed(webhookEventId: string | null | undefined, error: string | null) {
  if (!webhookEventId) return;
  await db.webhookEvent.update({ where: { id: webhookEventId }, data: { processedAt: new Date(), error } });
}

// ───────────────────────────── manual payments (BKG-6) ─────────────────────────────

export type ManualPaymentInput = {
  bookingId: string;
  amount: number; // paise
  method: Extract<PaymentMethod, "CASH" | "BANK_TRANSFER" | "UPI" | "CARD" | "OTHER">;
  receivedAt?: Date;
  note?: string | null;
  ip?: string | null;
};

export async function recordManualPayment(input: ManualPaymentInput, actor: Actor) {
  return db.$transaction(async (tx) => {
    if (!(await lockBooking(tx, input.bookingId))) throw new Error("Booking not found");
    const before = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId } });
    const { payment, outcome } = await applyCapturedInTx(tx, input.bookingId, {
      amount: input.amount,
      method: input.method,
      provider: "MANUAL",
      providerPaymentId: null,
      paymentLinkId: null,
      receivedAt: input.receivedAt ?? new Date(),
      recordedById: actor.id,
      note: input.note,
    });
    await audit(
      {
        userId: actor.id,
        action: "payment.manual",
        entityType: "Booking",
        entityId: input.bookingId,
        before: { status: before.status, paidAmount: before.paidAmount },
        after: { paymentId: payment.id, amount: input.amount, method: input.method, outcome },
        ip: input.ip,
      },
      tx,
    );
    return { status: "applied" as const, bookingId: input.bookingId, paymentId: payment.id, outcome, amount: input.amount };
  }, TX_OPTS);
}
