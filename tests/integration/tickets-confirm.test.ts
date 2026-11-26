/**
 * Confirm booking (TKT-7) against a real DB: the plan row lock makes a double submit book once,
 * with exactly one TICKETS expense of ticket × pax. Queue, pub/sub and storage are faked.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })), enqueueReplacingFinished: vi.fn(async () => ({ id: "job" })), closeQueues: vi.fn() }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));
vi.mock("@/server/storage/s3", () => ({ getStorage: () => ({ mode: "fake", put: vi.fn(async () => undefined), get: vi.fn(), presignGet: vi.fn() }) }));

const { confirmBooking, saveOption, savePlan, TicketError } = await import("@/server/domain/tickets");
const { db } = await import("@/server/db");
const { rupees } = await import("@/server/money");
const { istDateStringOf } = await import("@/server/time");
const { makeCustomer, makeDeparture, makeOwner } = await import("./fixtures");

let actor: { id: string; role: "OWNER" };
beforeAll(async () => {
  actor = { id: (await makeOwner()).id, role: "OWNER" };
});
afterAll(() => db.$disconnect());

const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

async function booking(departureId: string, pax: number) {
  const c = await makeCustomer();
  return db.booking.create({
    data: {
      code: `T-${randomBytes(4).toString("hex")}`,
      status: "CONFIRMED",
      source: "WHATSAPP",
      customerId: c.id,
      departureId,
      pax,
      pricePerPax: rupees(13_999),
      totalAmount: rupees(13_999) * pax,
      costTotalPlanned: rupees(10_900) * pax,
      travellers: { create: Array.from({ length: pax }, (_, i) => ({ fullName: `${c.name} ${i + 1}`, isLead: i === 0, age: 30 + i, gender: i % 2 ? "M" : "F" })) },
    },
  });
}

/** A departure with bookings of 4, 3 and 7 travellers (→ tickets of 6, 1+4 and 3) and a bus option. */
async function bookedReadyPlan(extras: { perPax: number; note: string } | null = null) {
  const dep = await makeDeparture({ daysOut: 30 });
  for (const n of [4, 3, 7]) await booking(dep.id, n);
  const { id: planId } = await savePlan(
    null,
    { label: "Nepal · group", departureId: dep.id, bookingId: null, origin: "Ranchi", destination: "Raxaul", travelDate: istDateStringOf(dep.startDate), budgetPerPax: rupees(2_600), note: null },
    actor,
  );
  // A bus, so no IRCTC window applies whatever the ARP setting.
  const { id: optionId } = await saveOption(planId, null, { mode: "BUS", title: "AC bus", details: "", ticketPerPax: rupees(1_960), extrasPerPax: extras?.perPax ?? 0, extrasNote: extras?.note ?? null, tags: [], disqualified: false, disqualifiedReason: null }, actor);
  return { dep, planId, optionId };
}

const input = (planId: string, optionId: string, n: number) => ({
  planId,
  optionId,
  tickets: Array.from({ length: n }, (_, i) => ({ pnr: `24561300${i}0`, file: { name: `t${i}.pdf`, bytes: PDF } })),
});

describe("confirmBooking", () => {
  it("a double submit books once: one TICKETS expense of ticket × pax", async () => {
    const { dep, planId, optionId } = await bookedReadyPlan();
    // 7 → 6 + 1; then 4 joins the 1 (5); then 3 needs a new ticket → 3 tickets for 14.
    const results = await Promise.allSettled([confirmBooking(input(planId, optionId, 3), actor), confirmBooking(input(planId, optionId, 3), actor)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(TicketError);
    expect((failed[0]!.reason as InstanceType<typeof TicketError>).code).toBe("ALREADY_BOOKED");

    // And a third, later submit (e.g. a resubmitted form) is refused too.
    await expect(confirmBooking(input(planId, optionId, 3), actor)).rejects.toMatchObject({ code: "ALREADY_BOOKED" });

    const expenses = await db.expense.findMany({ where: { departureId: dep.id, category: "TICKETS" } });
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.amount).toBe(rupees(1_960) * 14);
    const groups = await db.ticketGroup.findMany({ where: { planId }, orderBy: { idx: "asc" } });
    expect(groups.map((g) => (g.passengers as unknown[]).length)).toEqual([6, 5, 3]);
    expect(await db.document.count({ where: { kind: "TICKET", departureId: dep.id } })).toBe(4); // ticket 2 covers two bookings
    expect((await db.travelPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe("BOOKED");
  });

  it("new travellers on a booked plan get their own tickets and their own expense", async () => {
    const { dep, planId, optionId } = await bookedReadyPlan();
    await confirmBooking(input(planId, optionId, 3), actor);
    await booking(dep.id, 2);
    const r = await confirmBooking(input(planId, optionId, 1), actor);
    expect(r.pax).toBe(2);
    const amounts = (await db.expense.findMany({ where: { departureId: dep.id, category: "TICKETS" }, orderBy: { createdAt: "asc" } })).map((e) => e.amount);
    expect(amounts).toEqual([rupees(1_960) * 14, rupees(1_960) * 2]);
  });

  it("hidden extras become a second expense (extras × pax); a double submit still makes one of each", async () => {
    const { dep, planId, optionId } = await bookedReadyPlan({ perPax: rupees(450), note: "Shared cab NJP → Gangtok" });
    const results = await Promise.allSettled([confirmBooking(input(planId, optionId, 3), actor), confirmBooking(input(planId, optionId, 3), actor)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const expenses = await db.expense.findMany({ where: { departureId: dep.id } });
    const byCategory = Object.fromEntries(expenses.map((e) => [e.category, e.amount]));
    expect(expenses).toHaveLength(2);
    expect(byCategory).toEqual({ TICKETS: rupees(1_960) * 14, TRANSPORT: rupees(450) * 14 });
    const extras = expenses.find((e) => e.category === "TRANSPORT")!;
    expect(extras.description).toBe("Hidden extras: Shared cab NJP → Gangtok · 14 × ₹450");
    const auditRow = await db.auditLog.findFirstOrThrow({ where: { entityId: planId, action: "travel_plan.book" } });
    expect(auditRow.after).toMatchObject({ extrasExpenseId: extras.id, extrasAmount: rupees(450) * 14 });
  });

  it("rejects a non-PDF upload and books nothing", async () => {
    const { dep, planId, optionId } = await bookedReadyPlan();
    const bad = input(planId, optionId, 3);
    bad.tickets[1]!.file = { name: "x.pdf", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
    await expect(confirmBooking(bad, actor)).rejects.toMatchObject({ code: "INVALID" });
    expect(await db.expense.count({ where: { departureId: dep.id } })).toBe(0);
    expect(await db.ticketGroup.count({ where: { planId } })).toBe(0);
  });
});
