/**
 * Deal desk guardrails (DESK-1 … DESK-5, PRC-2, PRC-5, AUTH-5). Real DB. SRS worked example:
 * cost ₹10,900, list ₹13,999, floor 17% → F ₹13,140; group offer ₹500 for 6+ → A = L = ₹13,499;
 * suggested counter ₹13,199.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })), enqueueReplacingFinished: vi.fn(async () => ({ id: "job" })), closeQueues: vi.fn() }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { askOwner, DealError, decideApproval, previewQuote, sendPaymentLink, sendQuote } = await import("@/server/domain/deals");
const { enqueueReplacingFinished } = await import("@/server/queue");
const { db } = await import("@/server/db");
const { rupees } = await import("@/server/money");
const { ensureSettings, makeCustomer, makeDeparture, makeOwner } = await import("./fixtures");

type Actor = { id: string; role: "OWNER" | "STAFF" };
let owner: Actor;
let staff: Actor;

beforeAll(async () => {
  await ensureSettings();
  const o = await makeOwner();
  owner = { id: o.id, role: "OWNER" };
  const s = await db.user.create({ data: { email: `staff-${o.id}@test.local`, name: "Staff", role: "STAFF", passwordHash: "x" } });
  staff = { id: s.id, role: "STAFF" };
});
afterAll(() => db.$disconnect());

/** A sandbox chat where the customer just wrote (24h window open), on a fresh NP departure. */
async function deal() {
  const customer = await makeCustomer();
  const dep = await makeDeparture({ daysOut: 25 });
  const conv = await db.conversation.create({
    data: { channel: "SANDBOX", externalThreadId: `sbx-${customer.id}`, customerId: customer.id, status: "ACTIVE", lastInboundAt: new Date() },
  });
  return { conversationId: conv.id, code: dep.code, departureId: dep.id };
}

async function rejection(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DealError);
  return err as InstanceType<typeof DealError>;
}

describe("sendQuote guardrails", () => {
  it("(a) STAFF at ₹12,500 × 6 is rejected and writes no Quote", async () => {
    const d = await deal();
    const err = await rejection(sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(12_500) }, staff));
    expect(err.code).toBe("PRICE_NOT_ALLOWED");
    expect(err.reason).toBe("BELOW_FLOOR");
    // Even with the owner-only flag forged in: staff can never confirm below the floor.
    await rejection(sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(9_000), confirmBelowFloor: true }, staff));
    expect(await db.quote.count({ where: { conversationId: d.conversationId } })).toBe(0);
  });

  it("(b) STAFF at ₹13,499 × 6 (the group offer) is sent", async () => {
    const d = await deal();
    const q = await sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_499) }, staff);
    expect(q.pricePerPax).toBe(rupees(13_499));
    expect(q.totalAmount).toBe(rupees(80_994));
    const row = await db.quote.findUniqueOrThrow({ where: { id: q.quoteId } });
    expect(row.status).toBe("SENT");
    const card = await db.message.findUniqueOrThrow({ where: { id: q.messageId } });
    expect(card.kind).toBe("QUOTE");
    expect((await db.conversation.findUniqueOrThrow({ where: { id: d.conversationId } })).status).toBe("QUOTED");
  });

  it("(c) askOwner stores the engine's suggestion (₹13,199), never the client's", async () => {
    const d = await deal();
    const forged = { conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_500), suggestedPricePerPax: rupees(9_000) };
    const r = await askOwner(forged as Parameters<typeof askOwner>[0], staff);
    const a = await db.approval.findUniqueOrThrow({ where: { id: r.approvalId } });
    expect(a.kind).toBe("BELOW_FLOOR");
    expect(a.status).toBe("PENDING");
    expect(a.requestedPricePerPax).toBe(rupees(12_500));
    expect(a.suggestedPricePerPax).toBe(rupees(13_199));
    expect((await db.conversation.findUniqueOrThrow({ where: { id: d.conversationId } })).status).toBe("AWAITING_OWNER");
  });

  it("(d) after the owner approves ₹13,199, staff may send ₹13,199 but still not ₹13,000", async () => {
    const d = await deal();
    const { approvalId } = await askOwner({ conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_500) }, staff);
    const decided = await decideApproval({ approvalId, action: "APPROVE" }, owner);
    expect(decided.status).toBe("APPROVED");
    // DESK-4: the approved quote went out automatically, linked to the approval.
    const auto = await db.quote.findFirstOrThrow({ where: { conversationId: d.conversationId, approvalId } });
    expect(auto.pricePerPax).toBe(rupees(13_199));
    expect(await db.auditLog.count({ where: { entityId: approvalId, action: "approval.approve" } })).toBe(1);

    const ok = await sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_199) }, staff);
    expect(ok.pricePerPax).toBe(rupees(13_199));
    const err = await rejection(sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_000) }, staff));
    expect(err.reason).toBe("BELOW_APPROVED_PRICE");
    // The approval is for 6 travellers only.
    await rejection(sendQuote({ conversationId: d.conversationId, code: d.code, pax: 7, pricePerPax: rupees(13_199) }, staff));
  });

  it("(e) OWNER below the floor needs the second confirmation, and it's audit-logged", async () => {
    const d = await deal();
    const err = await rejection(sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_000) }, owner));
    expect(err.reason).toBe("BELOW_FLOOR_NEEDS_CONFIRMATION");
    expect(await db.quote.count({ where: { conversationId: d.conversationId } })).toBe(0);

    const q = await sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_000), confirmBelowFloor: true }, owner);
    expect(q.pricePerPax).toBe(rupees(13_000));
    const log = await db.auditLog.findFirstOrThrow({ where: { entityType: "Quote", entityId: q.quoteId } });
    expect(log.action).toBe("quote.below_floor");
    expect(log.userId).toBe(owner.id);
  });

  it("(f) STAFF cannot decide an approval", async () => {
    const d = await deal();
    const { approvalId } = await askOwner({ conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_500) }, staff);
    const err = await rejection(decideApproval({ approvalId, action: "APPROVE" }, staff));
    expect(err.code).toBe("FORBIDDEN");
    expect((await db.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe("PENDING");
    expect(await db.quote.count({ where: { conversationId: d.conversationId } })).toBe(0);
  });

  it("(f2) a second askOwner expires the earlier PENDING request (kept, never deleted)", async () => {
    const d = await deal();
    const first = await askOwner({ conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_500) }, staff);
    const second = await askOwner({ conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_800) }, staff);
    expect(second.approvalId).not.toBe(first.approvalId);
    const rows = await db.approval.findMany({ where: { conversationId: d.conversationId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [first.approvalId, "EXPIRED"],
      [second.approvalId, "PENDING"],
    ]);
    // The expired one can no longer be decided.
    const err = await rejection(decideApproval({ approvalId: first.approvalId, action: "APPROVE" }, owner));
    expect(err.code).toBe("APPROVAL_NOT_PENDING");
  });

  it("(g) sendPaymentLink on an expired quote is rejected and nothing is queued", async () => {
    const d = await deal();
    const q = await sendQuote({ conversationId: d.conversationId, code: d.code, pax: 6, pricePerPax: rupees(13_499) }, staff);
    await db.quote.update({ where: { id: q.quoteId }, data: { validUntil: new Date(Date.now() - 60_000) } });
    vi.mocked(enqueueReplacingFinished).mockClear();
    const err = await rejection(sendPaymentLink({ quoteId: q.quoteId }, staff));
    expect(err.code).toBe("QUOTE_NOT_VALID");
    expect(enqueueReplacingFinished).not.toHaveBeenCalled();
    expect(await db.booking.count({ where: { quoteId: q.quoteId } })).toBe(0);
  });

  it("(h) a STAFF preview carries no floor, cost or margin", async () => {
    const d = await deal();
    const input = { conversationId: d.conversationId, code: d.code, pax: 6, requestedPricePerPax: rupees(12_500) };
    const staffView = await previewQuote(input, staff);
    expect(staffView.price.decision).toBe("BELOW_FLOOR");
    expect(staffView.askOwner.suggestedPricePerPax).toBe(rupees(13_199));

    const keys: string[] = [];
    const values: unknown[] = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return void values.push(v);
      for (const [k, x] of Object.entries(v)) {
        keys.push(k);
        walk(x);
      }
    };
    walk(JSON.parse(JSON.stringify(staffView)));
    expect(keys.filter((k) => /floor|cost|margin/i.test(k))).toEqual([]);
    for (const secret of [10_900, 13_140, rupees(10_900), rupees(13_140)]) expect(values).not.toContain(secret);

    // Sanity: the same preview for the owner does carry them.
    const ownerView = await previewQuote(input, owner);
    expect(ownerView.price.role === "OWNER" && ownerView.price.floor).toBe(rupees(13_140));
  });
});
