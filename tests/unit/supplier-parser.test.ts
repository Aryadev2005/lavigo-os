/** SUP-4 / design §6.2: rule-based supplier-reply parser. Amounts in paise. */
import { describe, expect, it } from "vitest";
import { HIGH_CONFIDENCE, parseSupplierReply } from "@/server/domain/suppliers/parser";
import { rupees } from "@/server/money";

const ctx = { rooms: 10, nights: 3 };

type Case = {
  text: string;
  rate: number | null;
  level: "high" | "medium" | "low";
  mealPlan?: "CP" | "MAP" | null;
  decline?: boolean;
  candidates?: number[];
  total?: number;
};

const CASES: Case[] = [
  { text: "2150 per room, breakfast incl.", rate: 2150, level: "high", mealPlan: "CP" },
  { text: "Rs.2,600/- per night MAP", rate: 2600, level: "high", mealPlan: "MAP" },
  { text: "₹2.4k pn incl lachung night", rate: 2400, level: "high" },
  { text: "total 64500 for 10 rooms 3 nights", rate: 2150, level: "medium", total: 64_500 },
  { text: "rate 2380, cab extra 1500", rate: 2380, level: "low", candidates: [2380, 1500] },
  { text: "sorry fully booked those dates", rate: null, level: "low", decline: true },
  { text: "", rate: null, level: "low" },
];

describe("parseSupplierReply", () => {
  it.each(CASES)("$text", (c) => {
    const r = parseSupplierReply(c.text, ctx);
    expect(r.ratePerRoomNight).toBe(c.rate === null ? null : rupees(c.rate));
    expect(r.level).toBe(c.level);
    expect(r.isDecline).toBe(c.decline ?? false);
    // Anything below high is flagged "needs check".
    expect(r.confidence >= HIGH_CONFIDENCE).toBe(c.level === "high");
    if (c.mealPlan !== undefined) expect(r.mealPlan).toBe(c.mealPlan);
    if (c.candidates) expect(r.candidates).toEqual(c.candidates.map(rupees));
    if (c.total) expect(r.totalIfStated).toBe(rupees(c.total));
  });

  it("keeps the inclusions text the supplier wrote", () => {
    expect(parseSupplierReply("₹2.4k pn incl lachung night", ctx).inclusions).toBe("Incl. lachung night");
  });
});
