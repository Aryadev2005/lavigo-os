import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The webhook route enqueues payment.apply; capture it instead of needing a running worker.
const enqueued: { name: string; data: unknown }[] = [];
vi.mock("@/server/queue", () => ({
  enqueue: vi.fn(async (name: string, data: unknown) => {
    enqueued.push({ name, data });
  }),
  enqueueReplacingFinished: vi.fn(async (name: string, data: unknown) => {
    enqueued.push({ name, data });
  }),
  closeQueues: vi.fn(),
}));

const { createBooking, evaluateForDeparture, expireHold } = await import("@/server/domain/bookings");
const { applyPaymentEvent, createLink, recordManualPayment } = await import("@/server/domain/payments");
const { normalizeRazorpayEvent, signWebhookBody, webhookSecret } = await import("@/server/payments/razorpay");
const { buildPaymentLinkPaid } = await import("@/server/payments/simulate");
const { ingestRazorpayWebhook } = await import("@/server/payments/webhook");
const { seatsTaken } = await import("@/server/domain/inventory");
const { db } = await import("@/server/db");
const { ensureSettings, makeCustomer, makeDeparture, makeOwner } = await import("./fixtures");

let owner: { id: string; role: "OWNER" | "STAFF" };
let customerId: string;

beforeAll(async () => {
  await ensureSettings();
  const o = await makeOwner();
  owner = { id: o.id, role: o.role };
  customerId = (await makeCustomer()).id;
});
beforeEach(() => {
  enqueued.length = 0;
});
afterAll(() => db.$disconnect());

async function heldBookingWithLink(opts: { seatsTotal?: number; pax?: number } = {}) {
  const dep = await makeDeparture({ seatsTotal: opts.seatsTotal ?? 20 });
  const pax = opts.pax ?? 6;
  const { result } = await evaluateForDeparture(db, { departureId: dep.id, pax });
  const { booking } = await createBooking({ customerId, departureId: dep.id, pax, pricePerPax: result.autoOffer, source: "WHATSAPP" }, owner, {
    scheduleExpiry: false,
  });
  const link = await createLink(booking.id, "ADVANCE");
  return { dep, booking, link };
}

function headersFor(raw: string, eventId: string, signature = signWebhookBody(raw, webhookSecret())) {
  return new Headers({ "x-razorpay-signature": signature, "x-razorpay-event-id": eventId, "content-type": "application/json" });
}

/** What the payment.apply worker job does, minus BullMQ. */
async function processWebhookEvent(webhookEventId: string) {
  const ev = await db.webhookEvent.findUniqueOrThrow({ where: { id: webhookEventId } });
  if (ev.processedAt) return { status: "already" as const };
  return applyPaymentEvent({ ...normalizeRazorpayEvent(ev.payload)!, webhookEventId });
}

describe("Razorpay webhook → payment (PAY-1, PAY-2, PAY-3)", () => {
  it("advance link amount is 25% of the total, rounded half-up to the rupee, and is reused while open", async () => {
    const { booking, link } = await heldBookingWithLink(); // 6 × ₹13,499 = ₹80,994
    expect(booking.totalAmount).toBe(8_099_400);
    expect(link.amount).toBe(2_024_900); // ₹20,248.50 → ₹20,249
    expect(link.shortUrl).toMatch(/\/dev\/pay\/plink_fake_/);
    const again = await createLink(booking.id, "ADVANCE");
    expect(again).toMatchObject({ reused: true, providerLinkId: link.providerLinkId });
  });

  it("rejects a bad signature before touching the database", async () => {
    const { booking, link } = await heldBookingWithLink();
    const built = buildPaymentLinkPaid({ providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount });
    const r = await ingestRazorpayWebhook(built.rawBody, headersFor(built.rawBody, built.eventId, "00".repeat(32)));
    expect(r.status).toBe(401);
    expect(await db.webhookEvent.count({ where: { externalId: built.eventId } })).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("the same event delivered twice creates one WebhookEvent and one Payment", async () => {
    const { booking, link } = await heldBookingWithLink();
    const built = buildPaymentLinkPaid({ providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount });

    const [a, b] = await Promise.all([
      ingestRazorpayWebhook(built.rawBody, headersFor(built.rawBody, built.eventId)),
      ingestRazorpayWebhook(built.rawBody, headersFor(built.rawBody, built.eventId)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await db.webhookEvent.count({ where: { externalId: built.eventId } })).toBe(1);
    const id = (a as { webhookEventId: string }).webhookEventId;
    expect((b as { webhookEventId: string }).webhookEventId).toBe(id);
    expect(enqueued.every((e) => e.name === "payment.apply")).toBe(true);

    // Even if the job runs twice (BullMQ retry), concurrently:
    const runs = await Promise.all([processWebhookEvent(id), processWebhookEvent(id)]);
    expect(runs.filter((r) => r.status === "applied")).toHaveLength(1);
    expect(await db.payment.count({ where: { bookingId: booking.id } })).toBe(1);

    // A third, late delivery after processing is a no-op that doesn't even enqueue.
    enqueued.length = 0;
    const late = await ingestRazorpayWebhook(built.rawBody, headersFor(built.rawBody, built.eventId));
    expect(late).toMatchObject({ status: 200, duplicate: true });
    expect(enqueued).toHaveLength(0);
  });

  it("two different events for the same payment id create one Payment", async () => {
    const { booking, link } = await heldBookingWithLink();
    const common = { providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount };
    const paid = buildPaymentLinkPaid(common, { paymentId: "pay_same_1" });
    const captured = buildPaymentLinkPaid(common, { paymentId: "pay_same_1", event: "payment.captured" });

    const ids = [];
    for (const e of [paid, captured]) {
      const r = await ingestRazorpayWebhook(e.rawBody, headersFor(e.rawBody, e.eventId));
      ids.push((r as { webhookEventId: string }).webhookEventId);
    }
    expect(new Set(ids).size).toBe(2);
    const results = await Promise.all(ids.map(processWebhookEvent));
    expect(results.map((r) => r.status).sort()).toEqual(["applied", "duplicate"]);

    const payments = await db.payment.findMany({ where: { bookingId: booking.id } });
    expect(payments).toHaveLength(1);
    const after = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.paidAmount).toBe(link.amount);
    expect(await db.webhookEvent.count({ where: { id: { in: ids }, processedAt: null } })).toBe(0);
  });

  it("sets paidAmount, CONFIRMED, link PAID; a later balance payment adds up", async () => {
    const { booking, link } = await heldBookingWithLink();
    const advance = buildPaymentLinkPaid({ providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount });
    const r = await applyPaymentEvent(normalizeRazorpayEvent(JSON.parse(advance.rawBody))!);
    expect(r).toMatchObject({ status: "applied", outcome: "confirmed", amount: 2_024_900 });

    let b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b).toMatchObject({ status: "CONFIRMED", paidAmount: 2_024_900, holdExpiresAt: null });
    expect((await db.paymentLink.findUniqueOrThrow({ where: { id: link.linkId } })).status).toBe("PAID");

    const balance = await createLink(booking.id, "BALANCE");
    expect(balance.amount).toBe(8_099_400 - 2_024_900);
    const bal = buildPaymentLinkPaid({ providerLinkId: balance.providerLinkId, bookingCode: booking.code, amount: balance.amount });
    expect(await applyPaymentEvent(normalizeRazorpayEvent(JSON.parse(bal.rawBody))!)).toMatchObject({ outcome: "paid" });
    b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.paidAmount).toBe(b.totalAmount);
  });

  it("payment for an expired hold re-holds the seats when they're still free", async () => {
    const { dep, booking, link } = await heldBookingWithLink({ seatsTotal: 10, pax: 6 });
    expect(await expireHold(booking.id, new Date(booking.holdExpiresAt!.getTime() + 1))).toBe("expired");
    expect(await seatsTaken(dep.id)).toBe(0);

    const e = buildPaymentLinkPaid({ providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount });
    expect(await applyPaymentEvent(normalizeRazorpayEvent(JSON.parse(e.rawBody))!)).toMatchObject({ outcome: "reheld" });
    const b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b).toMatchObject({ status: "CONFIRMED", paidAmount: link.amount, cancelledAt: null, cancelReason: null });
    expect(await seatsTaken(dep.id)).toBe(6);
  });

  it("payment for an expired hold whose seats were sold is kept, confirmed and flagged for the owner", async () => {
    const { dep, booking, link } = await heldBookingWithLink({ seatsTotal: 10, pax: 6 });
    await expireHold(booking.id, new Date(booking.holdExpiresAt!.getTime() + 1));
    const { result } = await evaluateForDeparture(db, { departureId: dep.id, pax: 8 });
    await createBooking({ customerId, departureId: dep.id, pax: 8, pricePerPax: result.autoOffer, source: "PHONE" }, owner, { scheduleExpiry: false });

    const e = buildPaymentLinkPaid({ providerLinkId: link.providerLinkId, bookingCode: booking.code, amount: link.amount });
    expect(await applyPaymentEvent(normalizeRazorpayEvent(JSON.parse(e.rawBody))!)).toMatchObject({ outcome: "over_capacity" });
    const b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.status).toBe("CONFIRMED");
    expect(b.paidAmount).toBe(link.amount);
    expect(b.notes).toMatch(/OVER CAPACITY/);
    expect(await db.approval.count({ where: { departureId: dep.id, status: "PENDING", summary: { contains: booking.code } } })).toBe(1);
  });

  it("an event for an unknown booking is recorded as unmatched, not applied", async () => {
    const e = buildPaymentLinkPaid({ providerLinkId: "plink_unknown", bookingCode: "LVG-1", amount: 100_000 });
    const r = await ingestRazorpayWebhook(e.rawBody, headersFor(e.rawBody, e.eventId));
    const out = await processWebhookEvent((r as { webhookEventId: string }).webhookEventId);
    expect(out.status).toBe("unmatched");
    const ev = await db.webhookEvent.findUniqueOrThrow({ where: { id: (r as { webhookEventId: string }).webhookEventId } });
    expect(ev.processedAt).not.toBeNull();
    expect(ev.error).toMatch(/No booking/);
  });

  it("a manual payment is applied in the same transaction shape and audited", async () => {
    const { booking } = await heldBookingWithLink();
    const r = await recordManualPayment({ bookingId: booking.id, amount: 500_000, method: "CASH", note: "Paid at office" }, owner);
    expect(r.outcome).toBe("confirmed");
    const b = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b).toMatchObject({ status: "CONFIRMED", paidAmount: 500_000 });
    expect(await db.auditLog.count({ where: { entityId: booking.id, action: "payment.manual", userId: owner.id } })).toBe(1);
  });
});

describe("server-side price validation on booking (PRC-2, PRC-5)", () => {
  it("staff can't book below L; owner below F needs confirmation and is audited", async () => {
    const dep = await makeDeparture();
    const staffUser = await db.user.create({ data: { email: `staff-${dep.id}@t.local`, name: "S", role: "STAFF", passwordHash: "x" } });
    const staff = { id: staffUser.id, role: staffUser.role };
    const base = { customerId, departureId: dep.id, pax: 6, source: "WHATSAPP" as const };

    await expect(createBooking({ ...base, pricePerPax: 1_250_000 }, staff, { scheduleExpiry: false })).rejects.toMatchObject({ code: "PRICE_NOT_ALLOWED" });
    await expect(createBooking({ ...base, pricePerPax: 1_250_000 }, owner, { scheduleExpiry: false })).rejects.toMatchObject({ code: "PRICE_NOT_ALLOWED" });
    expect(await db.booking.count({ where: { departureId: dep.id } })).toBe(0);

    const { booking } = await createBooking({ ...base, pricePerPax: 1_250_000, confirmBelowFloor: true }, owner, { scheduleExpiry: false });
    expect(await db.auditLog.count({ where: { entityId: booking.id, action: "quote.below_floor" } })).toBe(1);
  });
});
