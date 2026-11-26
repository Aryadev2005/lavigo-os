/**
 * Supplier replies against a real DB (SUP-4, SUP-6, SUP-7): chatter, re-quotes, stated totals,
 * undo decline. Queue and pub/sub are mocked; the parser and compare are the real ones.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })), enqueueReplacingFinished: vi.fn(async () => ({ id: "job" })), closeQueues: vi.fn() }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { bookQuote, confirmQuote, createRfq, handleSupplierReply, undoDecline } = await import("@/server/domain/suppliers");
const { getRfqView } = await import("@/server/domain/suppliers/queries");
const { db } = await import("@/server/db");
const { rupees } = await import("@/server/money");
const { istDateStringOf } = await import("@/server/time");
const { makeDeparture, makeOwner } = await import("./fixtures");

let actor: { id: string; role: "OWNER" };
beforeAll(async () => {
  actor = { id: (await makeOwner()).id, role: "OWNER" };
});
afterAll(() => db.$disconnect());

const phone = () => `+9196${String(parseInt(randomBytes(4).toString("hex"), 16)).padStart(8, "0").slice(-8)}`;

/** A 10-room × 3-night RFQ to one supplier, already sent. */
async function rfqWithSupplier() {
  const dep = await makeDeparture({ daysOut: 40 });
  const supplier = await db.supplier.create({ data: { name: `Hotel ${randomBytes(3).toString("hex")}`, type: "HOTEL", destinations: ["Nepal"], phone: phone() } });
  const rfq = await createRfq(
    { destination: "Nepal", departureId: dep.id, checkIn: istDateStringOf(dep.startDate), nights: 3, rooms: 10, category: "COMFORT", mealPlan: "MAP", baselineRatePerRoomNight: rupees(2_500), supplierIds: [supplier.id] },
    actor,
  );
  const recipient = await db.rfqRecipient.update({ where: { id: rfq.recipients[0]!.id }, data: { status: "SENT", sentAt: new Date(Date.now() - 60_000) } });
  const conv = await db.conversation.create({ data: { channel: "WHATSAPP", externalThreadId: supplier.phone!, supplierId: supplier.id, status: "ACTIVE", lastInboundAt: new Date() } });
  const reply = async (text: string) => {
    const m = await db.message.create({ data: { conversationId: conv.id, direction: "INBOUND", author: "SUPPLIER", kind: "TEXT", body: text, status: "DELIVERED", externalId: `wamid.test.${randomBytes(6).toString("hex")}` } });
    return handleSupplierReply({ messageId: m.id, supplierId: supplier.id });
  };
  return { rfq, recipient, supplier, reply };
}

describe("supplier replies", () => {
  it("chatter creates no quote and leaves the recipient waiting; it shows as the latest message", async () => {
    const t = await rfqWithSupplier();
    const r = await t.reply("Sorry for the delay, will send rates by evening");
    expect(r.outcome).toBe("chatter");
    expect(await db.supplierQuote.count({ where: { recipientId: t.recipient.id } })).toBe(0);
    expect((await db.rfqRecipient.findUniqueOrThrow({ where: { id: t.recipient.id } })).status).toBe("SENT");
    const view = (await getRfqView(t.rfq.id))!;
    expect(view.rows[0]!.latest?.text).toBe("Sorry for the delay, will send rates by evening");
  });

  it("a second quote replaces the first (kept as REJECTED) and best uses the newer one", async () => {
    const t = await rfqWithSupplier();
    await t.reply("2600 per room night");
    await t.reply("Revised: 2450 per room night");
    const quotes = await db.supplierQuote.findMany({ where: { recipientId: t.recipient.id }, orderBy: { createdAt: "asc" } });
    expect(quotes.map((q) => [q.ratePerRoomNight, q.status])).toEqual([
      [rupees(2_600), "REJECTED"],
      [rupees(2_450), "RECEIVED"],
    ]);
    const view = (await getRfqView(t.rfq.id))!;
    expect(view.best?.rate).toBe(rupees(2_450));
    expect(view.rows[0]!.updated).toBe(true);
    expect(view.savings?.total).toBe(rupees(50 * 30));
  });

  it("a total that doesn't add up is ignored: needs check, and the booked amount is rate × rooms × nights", async () => {
    const t = await rfqWithSupplier();
    const r = await t.reply("2150 per room, total 21500 for 10 rooms");
    expect(r.outcome).toBe("needs check");
    const q = await db.supplierQuote.findFirstOrThrow({ where: { recipientId: t.recipient.id } });
    expect(q.ratePerRoomNight).toBe(rupees(2_150));
    expect(q.totalAmount).toBe(rupees(64_500));
    await expect(bookQuote(q.id, actor)).rejects.toThrow(/Confirm the rate/);
    await confirmQuote(q.id, rupees(2_150), actor);
    const { expenseId } = await bookQuote(q.id, actor);
    expect((await db.expense.findUniqueOrThrow({ where: { id: expenseId } })).amount).toBe(rupees(64_500));
  });

  it("a clear decline can be undone (audited), back to waiting", async () => {
    const t = await rfqWithSupplier();
    expect((await t.reply("Fully booked on those dates")).outcome).toBe("declined");
    await undoDecline(t.recipient.id, actor);
    expect((await db.rfqRecipient.findUniqueOrThrow({ where: { id: t.recipient.id } })).status).toBe("SENT");
    expect(await db.auditLog.count({ where: { entityId: t.recipient.id, action: "rfq_recipient.undo_decline" } })).toBe(1);
  });
});
