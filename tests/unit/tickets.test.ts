/** Tickets desk pure core (TKT-3, TKT-4, TKT-5, TKT-6). */
import { describe, expect, it } from "vitest";
import { fareAlert, irctcPassengerText, landed, pnrSplit, rankOptions, windowOpensAt, windowReminderTimes, type BookingParty } from "@/server/domain/tickets/core";
import { rupees } from "@/server/money";
import { dateOnly, istDateTime } from "@/server/time";

// The Goa seed plan (demo TK.goa): 4 travellers, ₹9,500 budget per person.
const GOA = [
  { title: "IndiGo · Ranchi → Mumbai → Goa (GOI)", ticketPerPax: rupees(7_850), extrasPerPax: 0, disqualified: false },
  { title: "Air India Express · Ranchi → Bengaluru → Goa (GOX)", ticketPerPax: rupees(8_400), extrasPerPax: rupees(600), disqualified: false },
  { title: "IndiGo · Ranchi → Delhi → Goa (GOI)", ticketPerPax: rupees(7_300), extrasPerPax: rupees(1_650), disqualified: false },
  { title: "Train 3AC · Ranchi → Madgaon", ticketPerPax: rupees(2_450), extrasPerPax: rupees(4_800), disqualified: true },
];

describe("rankOptions (TKT-3)", () => {
  const r = rankOptions(GOA, rupees(9_500), 4);

  it("ranks by landed cost and picks IndiGo via Mumbai as best", () => {
    expect(r.ranked.map((o) => o.landed)).toEqual([rupees(7_250), rupees(7_850), rupees(8_950), rupees(9_000)]);
    expect(r.best?.title).toBe("IndiGo · Ranchi → Mumbai → Goa (GOI)");
  });

  it("the Delhi midnight flight has the cheapest flight ticket but is not best", () => {
    const delhi = r.ranked.find((o) => o.title.includes("Delhi"))!;
    expect(Math.min(...GOA.filter((o) => !o.disqualified).map((o) => o.ticketPerPax))).toBe(delhi.ticketPerPax);
    expect(r.best).not.toBe(delhi);
  });

  it("the train is cheapest landed but disqualified", () => {
    expect(r.ranked[0]!.title).toContain("Train");
    expect(r.best?.title).not.toContain("Train");
  });

  it("extra profit = (9,500 − 7,850) × 4 = 6,600; vs budget per option", () => {
    expect(r.extraProfit).toBe(rupees(6_600));
    expect(r.ranked.find((o) => o.title.includes("Bengaluru"))!.vsBudget).toBe(rupees(500));
    expect(landed(GOA[2]!)).toBe(rupees(8_950));
  });

  it("no best when every option is disqualified", () => {
    const all = rankOptions(GOA.map((o) => ({ ...o, disqualified: true })), rupees(9_500), 4);
    expect(all.best).toBeNull();
    expect(all.extraProfit).toBe(0);
  });
});

describe("pnrSplit (TKT-6)", () => {
  const party = (id: string, n: number): BookingParty => ({
    bookingId: id,
    label: `${id}'s family`,
    passengers: Array.from({ length: n }, (_, k) => ({ bookingId: id, travellerId: `${id}-${k}`, fullName: `${id} ${k + 1}`, age: 30, gender: "F", berthPref: null })),
  });
  const sizes = [4, 3, 6, 2, 7, 1];
  const parties = sizes.map((n, i) => party(`B${i}`, n));
  const groups = pnrSplit(parties);
  const ticketsOf = (id: string) => groups.flatMap((g, i) => (g.passengers.some((p) => p.bookingId === id) ? [i] : []));

  it("puts everyone on a ticket and no ticket has more than 6", () => {
    expect(groups.reduce((n, g) => n + g.passengers.length, 0)).toBe(23);
    for (const g of groups) expect(g.passengers.length).toBeLessThanOrEqual(6);
    expect(groups).toHaveLength(4);
  });

  it("keeps every booking of 6 or fewer whole", () => {
    sizes.forEach((n, i) => {
      if (n <= 6) expect(ticketsOf(`B${i}`)).toHaveLength(1);
    });
  });

  it("splits the 7 into 6 + 1 on consecutive tickets", () => {
    const t = ticketsOf("B4");
    expect(t).toHaveLength(2);
    expect(t[1]! - t[0]!).toBe(1);
    expect(t.map((i) => groups[i]!.passengers.filter((p) => p.bookingId === "B4").length)).toEqual([6, 1]);
    expect(groups[t[0]!]!.label).toBe("B4's family (1 of 2)");
  });

  it("is stable: same input, same plan; equal sizes keep input order", () => {
    expect(pnrSplit(parties)).toEqual(groups);
    const tie = pnrSplit([party("X", 3), party("Y", 3), party("Z", 3)]);
    expect(tie.map((g) => g.label)).toEqual(["X's family + Y's family", "Z's family"]);
  });

  it("IRCTC text lists name, age, gender and berth", () => {
    const text = irctcPassengerText({ label: "Riya Sinha's family", passengers: [{ bookingId: "b", travellerId: "t", fullName: "Riya Sinha", age: 34, gender: "F", berthPref: "LB" }] }, 1);
    expect(text).toBe("Ticket 1 · Riya Sinha's family · 1 passenger\n1. Riya Sinha, 34, Female, Lower");
  });
});

describe("windowOpensAt (TKT-5)", () => {
  it("9 Jan 2027 with ARP 60 opens 10 Nov 2026 at 08:00 IST", () => {
    const at = windowOpensAt(dateOnly("2027-01-09"), 60);
    expect(at).toEqual(istDateTime("2026-11-10", "08:00"));
    expect(at.toISOString()).toBe("2026-11-10T02:30:00.000Z");
  });

  it("reminds at T−1 21:00 and T 07:45 IST", () => {
    const times = windowReminderTimes(istDateTime("2026-11-10", "08:00"));
    expect(times.map((t) => t.at)).toEqual([istDateTime("2026-11-09", "21:00"), istDateTime("2026-11-10", "07:45")]);
  });
});

describe("fareAlert (TKT-4)", () => {
  const now = new Date("2026-11-27T06:00:00Z");
  const snap = (daysAgo: number, r: number) => ({ farePerPax: rupees(r), capturedAt: new Date(now.getTime() - daysAgo * 86_400_000) });

  it("alerts at a 5% rise within 14 days", () => {
    expect(fareAlert([snap(13, 7_000), snap(0, 7_350)], now)).toMatchObject({ rise: rupees(350), riseBps: 500 });
  });

  it("no alert just under 5%", () => {
    expect(fareAlert([snap(13, 7_000), snap(0, 7_349)], now)).toBeNull();
  });

  it("ignores snapshots older than 14 days and needs two in the window", () => {
    expect(fareAlert([snap(20, 6_000), snap(0, 7_000)], now)).toBeNull();
    expect(fareAlert([snap(20, 6_000), snap(10, 7_000), snap(0, 7_100)], now)).toBeNull();
  });

  it("the Goa trend (₹7,120 → ₹7,850) alerts", () => {
    const trend = [7_120, 7_120, 7_240, 7_240, 7_380, 7_310, 7_450, 7_520, 7_520, 7_690, 7_690, 7_780, 7_850, 7_850];
    const a = fareAlert(trend.map((r, i) => snap(13 - i, r)), now);
    expect(a?.rise).toBe(rupees(730));
  });
});
