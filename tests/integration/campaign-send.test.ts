/**
 * Fill seats (DEP-3, DEP-4) against a real DB: sending the same campaign twice (a rerun of the job,
 * and a second "Send to N people") never creates a duplicate recipient or message, and people
 * without marketing opt-in are never messaged. Queue and pub/sub are faked.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/queue", () => ({ enqueue: vi.fn(async () => ({ id: "job" })), enqueueReplacingFinished: vi.fn(async () => ({ id: "job" })), closeQueues: vi.fn() }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { createCampaign, sendCampaign, attributeBooking, CampaignError } = await import("@/server/domain/departures/campaigns");
const { db } = await import("@/server/db");
const { rupees } = await import("@/server/money");
const { makeCustomer, makeDeparture, makeOwner } = await import("./fixtures");

let actor: { id: string; role: "OWNER" };
beforeAll(async () => {
  actor = { id: (await makeOwner()).id, role: "OWNER" };
  // Parallel-safe: INSERT … ON CONFLICT DO NOTHING, never find-then-create.
  await db.messageTemplate.createMany({
    data: [
      {
        name: "seat_fill_offer",
        category: "MARKETING",
        purpose: "CAMPAIGN",
        bodyPreview: "Hi {{1}}! {{2}} on {{3}}: only {{4}} seats left. Since you travelled with us before, here's {{5}} off till {{6}}. Book in 2 minutes: {{7}}",
        variables: ["name", "trip", "date", "seats_left", "discount", "valid_until", "link"],
        metaStatus: "APPROVED",
      },
    ],
    skipDuplicates: true,
  });
});
afterAll(() => db.$disconnect());

async function booking(customerId: string, departureId: string, status: "CONFIRMED" | "COMPLETED" = "COMPLETED") {
  return db.booking.create({
    data: { code: `C-${randomBytes(4).toString("hex")}`, status, source: "WHATSAPP", customerId, departureId, pax: 2, pricePerPax: rupees(13_999), totalAmount: rupees(27_998), costTotalPlanned: rupees(21_800) },
  });
}

describe("Fill seats campaign", () => {
  it("sending the same campaign twice creates no duplicate recipients or messages", async () => {
    const past = await makeDeparture({ daysOut: -60 });
    const dep = await makeDeparture({ daysOut: 30 });
    const opted = await Promise.all([1, 2, 3].map(() => makeCustomer()));
    const notOpted = await makeCustomer();
    for (const c of opted) await db.customer.update({ where: { id: c.id }, data: { marketingOptIn: true, marketingOptInAt: new Date() } });
    for (const c of [...opted, notOpted]) await booking(c.id, past.id);
    // The first opted-in customer also sits on this departure's waitlist: still one recipient.
    await db.waitlistEntry.create({ data: { customerId: opted[0]!.id, departureId: dep.id, pax: 2 } });

    const ids = new Set([...opted, notOpted].map((c) => c.id));
    const mine = <T extends { customerId: string }>(xs: T[]) => xs.filter((x) => ids.has(x.customerId));
    const opts = { discountPerPax: rupees(500), validUntil: new Date(Date.now() + 3 * 86_400_000) };

    const campaign = await createCampaign(dep.id, opts, actor);
    // The job running twice (a retry, or two workers) …
    await Promise.all([sendCampaign(campaign.id, { paceMs: 0 }), sendCampaign(campaign.id, { paceMs: 0 })]);
    await sendCampaign(campaign.id, { paceMs: 0 });
    // … and the owner pressing "Send to N people" again for the same departure.
    await expect(createCampaign(dep.id, opts, actor)).rejects.toBeInstanceOf(CampaignError);

    const recipients = mine(await db.campaignRecipient.findMany({ where: { campaign: { departureId: dep.id } } }));
    expect(recipients.filter((r) => r.status === "SENT").map((r) => r.customerId).sort()).toEqual(opted.map((c) => c.id).sort());
    expect(recipients.find((r) => r.customerId === notOpted.id)?.status).toBe("SKIPPED_NO_OPTIN");
    expect(recipients).toHaveLength(4);
    expect(recipients.find((r) => r.customerId === opted[0]!.id)?.reason).toBe("WAITLIST");

    const messages = await db.message.findMany({ where: { conversation: { customerId: { in: [...ids] } }, direction: "OUTBOUND" }, select: { conversation: { select: { customerId: true } }, kind: true, body: true } });
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((m) => m.conversation.customerId)).size).toBe(3);
    expect(messages.every((m) => m.kind === "TEMPLATE" && m.body.includes("₹500 off"))).toBe(true);
    expect(messages.some((m) => m.conversation.customerId === notOpted.id)).toBe(false);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("SENT");

    // DEP-4: a recipient books within 7 days → credited once, however often the job runs.
    const b = await booking(opted[1]!.id, dep.id, "CONFIRMED");
    await Promise.all([attributeBooking(b.id), attributeBooking(b.id)]);
    expect(await db.campaignRecipient.count({ where: { convertedBookingId: b.id } })).toBe(1);
  });
});
