import { describe, expect, it } from "vitest";
import {
  canQuote,
  charmAtLeast,
  evaluatePrice,
  floorPrice,
  forRole,
  type PriceInput,
  type PricingOffer,
  type PricingSettings,
} from "@/server/domain/pricing";
import { pct, rupees } from "@/server/money";
import { addDays, dateOnly } from "@/server/time";

const TODAY = dateOnly("2026-11-03"); // the demo's "today"

const SETTINGS: PricingSettings = {
  floorMarginBps: 1700, // m = 17%
  soloDiscountPerPax: 0, // s = 0
  escalateGroupSizeAtLeast: 15,
  charmEnding: 99,
  stackOffers: false,
};

const GROUP: PricingOffer = { kind: "GROUP", name: "Group offer", amountPerPax: rupees(500), minPax: 6 };
const EARLY: PricingOffer = { kind: "EARLY_BIRD", name: "Early-bird", amountPerPax: rupees(750), minDaysBeforeTravel: 45 };
const REPEAT: PricingOffer = { kind: "REPEAT_TRAVELLER", name: "Repeat traveller", amountPerPax: rupees(500) };
const ALL_OFFERS = [GROUP, EARLY, REPEAT];

/** NP-28N: P = 13,999, C = 10,900, 25 days out. */
function nepal(overrides: Partial<PriceInput> = {}): PriceInput {
  return {
    departure: { pricePerPax: rupees(13_999), costPerPax: rupees(10_900), startDate: addDays(TODAY, 25) },
    pax: 6,
    isRepeatCustomer: false,
    today: TODAY,
    settings: SETTINGS,
    offers: ALL_OFFERS,
    ...overrides,
  };
}

describe("SRS §4.3 worked example (Riya, 6 pax, asks ₹12,500)", () => {
  const r = evaluatePrice(nepal({ offers: [GROUP], requestedPricePerPax: rupees(12_500) }));

  it("reproduces every value in the table", () => {
    expect(r.floor).toBe(rupees(13_140)); // F
    expect(r.autoOffer).toBe(rupees(13_499)); // A
    expect(r.staffLimit).toBe(rupees(13_499)); // L
    expect(r.decision).toBe("BELOW_FLOOR");
    expect(r.suggestedCounter).toBe(rupees(13_199));
    expect(r.counterPlus100).toBe(rupees(13_299)); // owner "Counter" button
    expect(pct(r.marginBpsAt(r.suggestedCounter))).toBe("17.4%");
  });

  it("applies the group offer and nothing else", () => {
    expect(r.listPrice).toBe(rupees(13_999));
    expect(r.appliedOffers).toEqual([{ kind: "GROUP", name: "Group offer", amountPerPax: rupees(500) }]);
  });

  it("is the same with all standing offers loaded (early-bird not eligible at 25 days, not a repeat customer)", () => {
    const all = evaluatePrice(nepal({ requestedPricePerPax: rupees(12_500) }));
    expect(all.autoOffer).toBe(rupees(13_499));
    expect(all.appliedOffers.map((o) => o.kind)).toEqual(["GROUP"]);
  });
});

describe("decision bands (PRC-2)", () => {
  // s = ₹300 separates the bands: A = 13,499, L = 13,199, F = 13,140.
  const settings = { ...SETTINGS, soloDiscountPerPax: rupees(300) };
  const at = (r: number) => evaluatePrice(nepal({ settings, requestedPricePerPax: r }));
  const base = at(rupees(13_499));

  it("has the expected A, L, F", () => {
    expect([base.autoOffer, base.staffLimit, base.floor]).toEqual([rupees(13_499), rupees(13_199), rupees(13_140)]);
  });

  it.each([
    ["r = A", rupees(13_499), "ACCEPT_AUTO"],
    ["r > A", rupees(14_500), "ACCEPT_AUTO"],
    ["r = A − ₹1", rupees(13_498), "ACCEPT_WITHIN_AUTONOMY"],
    ["r = L", rupees(13_199), "ACCEPT_WITHIN_AUTONOMY"],
    ["r = L − ₹1", rupees(13_198), "NEEDS_APPROVAL"],
    ["r = F", rupees(13_140), "NEEDS_APPROVAL"],
    ["r = F − ₹1", rupees(13_139), "BELOW_FLOOR"],
    ["r = F − 1 paisa", rupees(13_140) - 1, "BELOW_FLOOR"],
  ] as const)("%s → %s", (_label, r, decision) => {
    expect(at(r).decision).toBe(decision);
  });

  it("quotes A (never more than asked) when r ≥ A, else the requested price", () => {
    expect(at(rupees(15_000)).quotePricePerPax).toBe(rupees(13_499));
    expect(at(rupees(13_300)).quotePricePerPax).toBe(rupees(13_300));
  });

  it("treats a missing requested price as A", () => {
    const r = evaluatePrice(nepal({ settings }));
    expect(r.requestedPricePerPax).toBeNull();
    expect(r.decision).toBe("ACCEPT_AUTO");
    expect(r.quotePricePerPax).toBe(rupees(13_499));
  });
});

describe("offers (PRC-3)", () => {
  it("early-bird is eligible at exactly 45 days, not at 44", () => {
    const at45 = evaluatePrice(nepal({ pax: 2, departure: { ...nepal().departure, startDate: addDays(TODAY, 45) } }));
    const at44 = evaluatePrice(nepal({ pax: 2, departure: { ...nepal().departure, startDate: addDays(TODAY, 44) } }));
    expect(at45.appliedOffers.map((o) => o.kind)).toEqual(["EARLY_BIRD"]);
    expect(at45.autoOffer).toBe(rupees(13_249));
    expect(at44.appliedOffers).toEqual([]);
    expect(at44.autoOffer).toBe(rupees(13_999));
  });

  it("repeat traveller discount only for repeat customers", () => {
    expect(evaluatePrice(nepal({ pax: 2, isRepeatCustomer: true })).autoOffer).toBe(rupees(13_499));
    expect(evaluatePrice(nepal({ pax: 2, isRepeatCustomer: false })).autoOffer).toBe(rupees(13_999));
  });

  it("group offer needs minPax", () => {
    expect(evaluatePrice(nepal({ pax: 5 })).appliedOffers).toEqual([]);
    expect(evaluatePrice(nepal({ pax: 6 })).appliedOffers.map((o) => o.kind)).toEqual(["GROUP"]);
  });

  it("applies only the single largest eligible offer by default (no stacking)", () => {
    const r = evaluatePrice(nepal({ isRepeatCustomer: true, departure: { ...nepal().departure, startDate: addDays(TODAY, 60) } }));
    expect(r.eligibleOffers.map((o) => o.kind)).toEqual(["EARLY_BIRD", "GROUP", "REPEAT_TRAVELLER"]);
    expect(r.appliedOffers.map((o) => o.kind)).toEqual(["EARLY_BIRD"]);
    expect(r.autoOffer).toBe(rupees(13_249));
  });

  it("stacks every eligible offer when settings.stackOffers is on", () => {
    const r = evaluatePrice(
      nepal({
        settings: { ...SETTINGS, stackOffers: true },
        isRepeatCustomer: true,
        departure: { ...nepal().departure, startDate: addDays(TODAY, 60) },
      }),
    );
    expect(r.autoOffer).toBe(rupees(13_999 - 750 - 500 - 500));
  });

  it("ignores disabled offers and offers for other departures", () => {
    const r = evaluatePrice(
      nepal({
        departure: { ...nepal().departure, id: "dep-np" },
        offers: [
          { ...GROUP, enabled: false },
          { ...GROUP, name: "Other trip group", departureId: "dep-other" },
          { ...GROUP, name: "This trip group", amountPerPax: rupees(300), departureId: "dep-np" },
        ],
      }),
    );
    expect(r.appliedOffers.map((o) => o.name)).toEqual(["This trip group"]);
  });
});

describe("staff discount and floor (PRC-1, PRC-4)", () => {
  it("staff discount moves L down, never below F", () => {
    expect(evaluatePrice(nepal({ settings: { ...SETTINGS, soloDiscountPerPax: rupees(200) } })).staffLimit).toBe(rupees(13_299));
    expect(evaluatePrice(nepal({ settings: { ...SETTINGS, soloDiscountPerPax: rupees(1_500) } })).staffLimit).toBe(rupees(13_140));
  });

  it("raising the floor margin to 20% gives F = 13,630", () => {
    const r = evaluatePrice(nepal({ settings: { ...SETTINGS, floorMarginBps: 2000 } }));
    expect(r.floor).toBe(rupees(13_630));
    expect(r.staffLimit).toBe(rupees(13_630)); // A = 13,499 < F, so L = F
    expect(r.suggestedCounter).toBe(rupees(13_699));
  });

  it("floor is rounded UP to ₹10 and is integer paise", () => {
    expect(floorPrice(rupees(10_900), 1700)).toBe(rupees(13_140)); // exact 13,132.53 → 13,140
    expect(floorPrice(rupees(8_300), 1700)).toBe(rupees(10_000)); // exact 10,000 stays
    expect(floorPrice(rupees(8_300) + 1, 1700)).toBe(rupees(10_010));
  });

  it("charm counter is the smallest price ≥ F ending in the charm digits", () => {
    expect(charmAtLeast(rupees(13_140), 99)).toBe(rupees(13_199));
    expect(charmAtLeast(rupees(13_199), 99)).toBe(rupees(13_199));
    expect(charmAtLeast(rupees(13_200), 99)).toBe(rupees(13_299));
    expect(charmAtLeast(rupees(13_140), 49)).toBe(rupees(13_149));
  });

  it("a requested price below F is BELOW_FLOOR even when the list price itself sits under F", () => {
    const r = evaluatePrice(
      nepal({ settings: { ...SETTINGS, floorMarginBps: 2000 }, requestedPricePerPax: rupees(13_500) }),
    );
    expect(r.autoOffer).toBe(rupees(13_499));
    expect(r.decision).toBe("BELOW_FLOOR");
  });
});

describe("large group (PRC-6)", () => {
  it("escalates at pax ≥ threshold whatever the price", () => {
    const r = evaluatePrice(nepal({ pax: 15, requestedPricePerPax: rupees(14_000) }));
    expect(r.decision).toBe("LARGE_GROUP");
    expect(r.priceBand).toBe("ACCEPT_AUTO");
    expect(evaluatePrice(nepal({ pax: 14 })).decision).toBe("ACCEPT_AUTO");
  });
});

describe("canQuote (PRC-2, PRC-5)", () => {
  const settings = { ...SETTINGS, soloDiscountPerPax: rupees(300) };
  const r = evaluatePrice(nepal({ settings })); // A 13,499 · L 13,199 · F 13,140

  it("STAFF may quote at or above L", () => {
    expect(canQuote(r, rupees(13_199), "STAFF")).toEqual({ ok: true, reason: "AT_OR_ABOVE_STAFF_LIMIT", audit: null });
    expect(canQuote(r, rupees(13_499), "STAFF").ok).toBe(true);
  });

  it("STAFF may not quote below L or below F on their own", () => {
    expect(canQuote(r, rupees(13_198), "STAFF")).toMatchObject({ ok: false, reason: "BELOW_STAFF_LIMIT" });
    expect(canQuote(r, rupees(13_000), "STAFF")).toMatchObject({ ok: false, reason: "BELOW_FLOOR" });
    expect(canQuote(r, rupees(13_000), "STAFF", { confirmBelowFloor: true })).toMatchObject({ ok: false, reason: "BELOW_FLOOR" });
  });

  it("STAFF may quote an owner-approved price (and above it), audited when below L", () => {
    const approvedPrice = rupees(13_150);
    expect(canQuote(r, rupees(13_150), "STAFF", { approvedPrice })).toEqual({ ok: true, reason: "OWNER_APPROVED", audit: "quote.below_limit" });
    expect(canQuote(r, rupees(13_149), "STAFF", { approvedPrice })).toMatchObject({ ok: false, reason: "BELOW_APPROVED_PRICE" });
    // The owner approved below the floor (with their own confirmation): staff can send exactly that.
    expect(canQuote(r, rupees(12_500), "STAFF", { approvedPrice: rupees(12_500) })).toEqual({ ok: true, reason: "OWNER_APPROVED", audit: "quote.below_floor" });
  });

  it("STAFF needs an approval for a large group even at list price", () => {
    const big = evaluatePrice(nepal({ pax: 20 }));
    expect(canQuote(big, rupees(13_999), "STAFF")).toMatchObject({ ok: false, reason: "LARGE_GROUP_NEEDS_APPROVAL" });
    expect(canQuote(big, rupees(13_400), "STAFF", { approvedPrice: rupees(13_400) }).ok).toBe(true);
    expect(canQuote(big, rupees(13_400), "OWNER").ok).toBe(true);
  });

  it("OWNER may quote down to F; between F and L it is audited", () => {
    expect(canQuote(r, rupees(13_140), "OWNER")).toEqual({ ok: true, reason: "OWNER_AT_OR_ABOVE_FLOOR", audit: "quote.below_limit" });
    expect(canQuote(r, rupees(13_499), "OWNER")).toEqual({ ok: true, reason: "OWNER_AT_OR_ABOVE_FLOOR", audit: null });
  });

  it("OWNER below F needs confirmBelowFloor, and it is audited", () => {
    expect(canQuote(r, rupees(13_139), "OWNER")).toMatchObject({ ok: false, reason: "BELOW_FLOOR_NEEDS_CONFIRMATION" });
    expect(canQuote(r, rupees(12_500), "OWNER", { confirmBelowFloor: true })).toEqual({
      ok: true,
      reason: "OWNER_BELOW_FLOOR_CONFIRMED",
      audit: "quote.below_floor",
    });
  });

  it("rejects non-integer or non-positive prices", () => {
    expect(canQuote(r, 1_319_900.5, "OWNER").reason).toBe("INVALID_PRICE");
    expect(canQuote(r, 0, "OWNER").reason).toBe("INVALID_PRICE");
  });
});

describe("forRole", () => {
  const r = evaluatePrice(nepal({ requestedPricePerPax: rupees(12_500) }));

  function allKeys(value: unknown, prefix = ""): string[] {
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([k, v]) => [`${prefix}${k}`, ...allKeys(v, `${prefix}${k}.`)]);
  }

  it("STAFF view has no cost, floor or margin anywhere, and no functions", () => {
    const view = forRole(r, "STAFF");
    const keys = allKeys(view).map((k) => k.toLowerCase());
    expect(keys.filter((k) => /cost|floor|margin/.test(k))).toEqual([]);
    expect(Object.values(view).some((v) => typeof v === "function")).toBe(false);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(view.suggestedCounter).toBe(rupees(13_199)); // staff UI offers "Ask owner" with it
  });

  it("OWNER view includes floor, cost and margins as plain numbers", () => {
    const view = forRole(r, "OWNER");
    expect(view.floor).toBe(rupees(13_140));
    expect(view.costPerPax).toBe(rupees(10_900));
    expect(pct(view.marginBpsAtSuggested)).toBe("17.4%");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
});

describe("input validation", () => {
  it("rejects bad pax and prices", () => {
    expect(() => evaluatePrice(nepal({ pax: 0 }))).toThrow(RangeError);
    expect(() => evaluatePrice(nepal({ requestedPricePerPax: 12.5 }))).toThrow(RangeError);
    expect(() => evaluatePrice(nepal({ departure: { ...nepal().departure, pricePerPax: 0 } }))).toThrow(RangeError);
  });
});
