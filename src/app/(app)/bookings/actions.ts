"use server";
/**
 * Bookings screen mutations (BKG-2, BKG-5 … BKG-8, PAY-5). Every action: requireUser → zod →
 * domain → audit (in the domain) → revalidate. Prices are re-derived on the server; what the
 * browser sends is only a request.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { clientIp } from "@/server/auth";
import { db } from "@/server/db";
import { addTravellers, BookingStateError, cancelBooking, createBooking, evaluateForDeparture, PriceNotAllowed } from "@/server/domain/bookings";
import { searchCustomers, type CustomerHit } from "@/server/domain/bookings/queries";
import { queuePaymentLink } from "@/server/domain/dues";
import { SeatsUnavailable, DepartureNotBookable } from "@/server/domain/inventory";
import { recordManualPayment } from "@/server/domain/payments";
import { canQuote, floorPrice, forRole, type CanQuoteReason, type OwnerPriceView, type StaffPriceView } from "@/server/domain/pricing";
import { getSettings } from "@/server/domain/settings";
import { logger } from "@/server/logger";
import { inr, paiseFromRupeeInput } from "@/server/money";
import { enqueue, enqueueReplacingFinished } from "@/server/queue";
import { requireUser } from "@/server/rbac";
import { dateOnly } from "@/server/time";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function ip() {
  return clientIp(await headers());
}

function revalidateBookings() {
  revalidatePath("/bookings");
  revalidatePath("/dues");
  revalidatePath("/today");
}

const rupeeString = z.string().max(20);
const id = z.string().min(1).max(64);

// ───────────────────────────── customers ─────────────────────────────

export async function searchCustomersAction(q: string): Promise<CustomerHit[]> {
  await requireUser();
  return searchCustomers(z.string().max(80).parse(q));
}

/** "+91 98350 11223", "9835011223" → "+919835011223". Null if it isn't a plausible number. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// ───────────────────────────── live price check (PRC-2, BKG-2) ─────────────────────────────

const priceInput = z.object({
  departureId: id.optional(),
  customCostTotal: rupeeString.optional(),
  customerId: id.optional(),
  pax: z.number().int().min(1).max(200),
  pricePerPax: rupeeString,
});

export type PriceCheck = {
  ok: boolean;
  reason: CanQuoteReason | "INVALID_INPUT";
  message: string;
  needsConfirmBelowFloor: boolean;
  view: StaffPriceView | OwnerPriceView | null;
  /** price × pax in paise, computed here so the browser never does money arithmetic. */
  totalAmount: number | null;
};

const REASON_COPY: Partial<Record<CanQuoteReason, string>> = {
  AT_OR_ABOVE_STAFF_LIMIT: "Within your limit",
  OWNER_AT_OR_ABOVE_FLOOR: "Above your floor",
  BELOW_STAFF_LIMIT: "Below what staff can offer alone: ask the owner to approve this price",
  BELOW_FLOOR: "Below what staff can offer alone: ask the owner to approve this price",
  LARGE_GROUP_NEEDS_APPROVAL: "Large group: the owner approves the price",
  BELOW_FLOOR_NEEDS_CONFIRMATION: "Below your minimum margin. Tick the box to confirm you want to sell at a loss-making price",
  OWNER_BELOW_FLOOR_CONFIRMED: "Below your minimum margin (confirmed, will be audited)",
  INVALID_PRICE: "Enter a price per person",
};

export async function checkPriceAction(raw: z.input<typeof priceInput> & { confirmBelowFloor?: boolean }): Promise<PriceCheck> {
  const user = await requireUser();
  const parsed = priceInput.safeParse(raw);
  const price = parsed.success ? paiseFromRupeeInput(parsed.data.pricePerPax) : null;
  if (!parsed.success || price === null || price <= 0) {
    return { ok: false, reason: "INVALID_INPUT", message: "Enter a price per person", needsConfirmBelowFloor: false, view: null, totalAmount: null };
  }
  const input = parsed.data;
  const settings = await getSettings();

  if (input.departureId) {
    const { result } = await evaluateForDeparture(db, {
      departureId: input.departureId,
      customerId: input.customerId,
      pax: input.pax,
      requestedPricePerPax: price,
    });
    const check = canQuote(result, price, user.role, { confirmBelowFloor: raw.confirmBelowFloor });
    return {
      ok: check.ok,
      reason: check.reason,
      message: REASON_COPY[check.reason] ?? check.reason,
      needsConfirmBelowFloor: user.role === "OWNER" && price < result.floor,
      view: forRole(result, user.role),
      totalAmount: price * input.pax,
    };
  }

  const cost = paiseFromRupeeInput(input.customCostTotal ?? "");
  if (cost === null) return { ok: false, reason: "INVALID_INPUT", message: "Enter the planned cost", needsConfirmBelowFloor: false, view: null, totalAmount: null };
  const floor = floorPrice(Math.ceil(cost / input.pax), settings.floorMarginBps);
  const check = canQuote(
    { floor, staffLimit: floor, isLargeGroup: input.pax >= settings.escalateGroupSizeAtLeast },
    price,
    user.role,
    { confirmBelowFloor: raw.confirmBelowFloor },
  );
  return {
    ok: check.ok,
    reason: check.reason,
    message: REASON_COPY[check.reason] ?? check.reason,
    needsConfirmBelowFloor: user.role === "OWNER" && price < floor,
    view: null,
    totalAmount: price * input.pax,
  };
}

// ───────────────────────────── create (BKG-2) ─────────────────────────────

const createInput = z
  .object({
    customer: z.union([
      z.object({ id }),
      z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(20).optional() }),
    ]),
    source: z.enum(["WALK_IN", "PHONE", "WEBSITE", "WHATSAPP", "INSTAGRAM"]),
    departureId: id.optional(),
    custom: z
      .object({ title: z.string().trim().min(3).max(120), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), costTotal: rupeeString })
      .optional(),
    pax: z.number().int().min(1).max(200),
    pricePerPax: rupeeString,
    confirmBelowFloor: z.boolean().optional(),
    travellers: z.array(z.object({ fullName: z.string().trim().min(2).max(120), age: z.number().int().min(0).max(120).nullable().optional() })).max(200).default([]),
    advance: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("manual"), amount: rupeeString, method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CARD"]) }),
      z.object({ kind: z.literal("link") }),
    ]),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => !!v.departureId !== !!v.custom, "Pick a departure or describe a custom trip");

export type CreateBookingInputUI = z.input<typeof createInput>;

export async function createBookingAction(raw: CreateBookingInputUI): Promise<ActionResult<{ code: string; note?: string }>> {
  const user = await requireUser();
  const parsed = createInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const v = parsed.data;
  const price = paiseFromRupeeInput(v.pricePerPax);
  if (price === null || price <= 0) return { ok: false, error: "Enter a valid price per person" };
  const requestIp = await ip();

  // Customer: existing id, an existing phone, or a new row.
  let customerId: string;
  if ("id" in v.customer) {
    customerId = (await db.customer.findUniqueOrThrow({ where: { id: v.customer.id }, select: { id: true } })).id;
  } else {
    const phone = v.customer.phone ? normalizePhone(v.customer.phone) : null;
    if (v.customer.phone && !phone) return { ok: false, error: "That phone number doesn't look right" };
    const existing = phone ? await db.customer.findUnique({ where: { phone } }) : null;
    customerId = existing?.id ?? (await db.customer.create({ data: { name: v.customer.name, phone } })).id;
  }

  let custom: { title: string; startDate: Date; costTotalPlanned: number } | undefined;
  if (v.custom) {
    const cost = paiseFromRupeeInput(v.custom.costTotal);
    if (cost === null) return { ok: false, error: "Enter the planned cost of the custom trip" };
    custom = { title: v.custom.title, startDate: dateOnly(v.custom.startDate), costTotalPlanned: cost };
  }

  let booking;
  try {
    ({ booking } = await createBooking(
      {
        customerId,
        pax: v.pax,
        pricePerPax: price,
        source: v.source,
        departureId: v.departureId,
        custom,
        confirmBelowFloor: user.role === "OWNER" ? v.confirmBelowFloor : false,
        travellers: v.travellers.map((t) => ({ fullName: t.fullName, age: t.age ?? null })),
        notes: v.notes,
        ip: requestIp,
      },
      { id: user.id, role: user.role },
    ));
  } catch (err) {
    if (err instanceof PriceNotAllowed) return { ok: false, error: REASON_COPY[err.check.reason] ?? "Price not allowed" };
    if (err instanceof SeatsUnavailable) return { ok: false, error: `Only ${err.available} seat${err.available === 1 ? "" : "s"} left on this departure` };
    if (err instanceof DepartureNotBookable || err instanceof RangeError) return { ok: false, error: err.message };
    logger.error({ err }, "create booking failed");
    return { ok: false, error: "Couldn't create the booking. Try again." };
  }

  let note: string | undefined;
  if (v.advance.kind === "manual") {
    const amount = paiseFromRupeeInput(v.advance.amount);
    if (amount && amount > 0) {
      await recordManualPayment(
        { bookingId: booking.id, amount: Math.min(amount, booking.totalAmount), method: v.advance.method, note: "Advance at booking", ip: requestIp },
        { id: user.id, role: user.role },
      );
      note = `${inr(amount)} advance recorded`;
    }
  } else if (v.advance.kind === "link") {
    await queuePaymentLink(booking.id, "ADVANCE", { id: user.id, role: user.role }, { send: true, reason: "new_booking" });
    note = "Advance link is on its way";
  }
  revalidateBookings();
  return { ok: true, code: booking.code, note };
}

// ───────────────────────────── drawer actions ─────────────────────────────

export async function sendLinkAction(bookingId: string, purpose: "BALANCE" | "ADVANCE" = "BALANCE"): Promise<ActionResult> {
  const user = await requireUser();
  const b = await db.booking.findUnique({ where: { id: id.parse(bookingId) }, select: { status: true, totalAmount: true, paidAmount: true } });
  if (!b || b.status === "CANCELLED") return { ok: false, error: "Booking not found" };
  if (b.paidAmount >= b.totalAmount) return { ok: false, error: "Nothing left to collect" };
  await queuePaymentLink(bookingId, purpose, { id: user.id, role: user.role }, { send: true, reason: "manual" });
  return { ok: true };
}

export async function renderDocumentAction(bookingId: string, kind: "invoice" | "itinerary"): Promise<ActionResult> {
  await requireUser();
  const b = await db.booking.findUnique({ where: { id: id.parse(bookingId) }, select: { id: true, departureId: true } });
  if (!b) return { ok: false, error: "Booking not found" };
  if (kind === "itinerary" && !b.departureId) return { ok: false, error: "Custom trips don't have a standard itinerary yet" };
  // Pending job → deduped; finished job → replaced, so "generate again" works.
  await enqueueReplacingFinished("invoice.render", { bookingId: b.id, kind, departureId: b.departureId ?? undefined }, `doc-${kind}-${b.id}`);
  return { ok: true };
}

const paymentInput = z.object({
  bookingId: id,
  amount: rupeeString,
  method: z.enum(["CASH", "BANK_TRANSFER", "UPI", "CARD", "OTHER"]),
  note: z.string().max(300).optional(),
});

export async function recordPaymentAction(raw: z.input<typeof paymentInput>): Promise<ActionResult<{ outcome: string }>> {
  const user = await requireUser();
  const parsed = paymentInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the payment details" };
  const amount = paiseFromRupeeInput(parsed.data.amount);
  if (amount === null || amount <= 0) return { ok: false, error: "Enter the amount received" };
  const b = await db.booking.findUnique({ where: { id: parsed.data.bookingId }, select: { status: true, totalAmount: true, paidAmount: true } });
  if (!b || b.status === "CANCELLED") return { ok: false, error: "Booking not found or cancelled" };
  if (amount > b.totalAmount - b.paidAmount) return { ok: false, error: `That's more than the ${inr(b.totalAmount - b.paidAmount)} still owed` };
  const r = await recordManualPayment(
    { bookingId: parsed.data.bookingId, amount, method: parsed.data.method, note: parsed.data.note, ip: await ip() },
    { id: user.id, role: user.role },
  );
  await enqueue("invoice.render", { bookingId: r.bookingId, paymentId: r.paymentId }, { jobId: `invoice-render-${r.paymentId}` });
  revalidateBookings();
  return { ok: true, outcome: r.outcome };
}

export async function cancelBookingAction(bookingId: string, reason: string): Promise<ActionResult> {
  const user = await requireUser("OWNER");
  const r = z.string().trim().min(3, "Give a reason").max(300).safeParse(reason);
  if (!r.success) return { ok: false, error: r.error.issues[0]!.message };
  try {
    await cancelBooking(id.parse(bookingId), r.data, { id: user.id, role: user.role }, { ip: await ip() });
  } catch (err) {
    if (err instanceof BookingStateError) return { ok: false, error: err.message };
    throw err;
  }
  revalidateBookings();
  return { ok: true };
}

const travellerInput = z.object({
  fullName: z.string().trim().min(2).max(120),
  age: z.number().int().min(0).max(120).nullable().optional(),
  gender: z.enum(["M", "F", "O"]).nullable().optional(),
  idType: z.string().max(40).nullable().optional(),
});

export async function addTravellerAction(bookingId: string, raw: z.input<typeof travellerInput>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = travellerInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter the traveller's full name" };
  try {
    await addTravellers(id.parse(bookingId), [parsed.data], { id: user.id, role: user.role });
  } catch (err) {
    if (err instanceof BookingStateError) return { ok: false, error: err.message };
    throw err;
  }
  revalidatePath("/bookings");
  return { ok: true };
}
