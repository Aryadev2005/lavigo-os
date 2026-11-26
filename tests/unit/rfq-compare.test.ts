/** SUP-6: best quote and savings vs the baseline, in paise. */
import { describe, expect, it } from "vitest";
import { bestRow, bookableTotal, savings, totalMatches } from "@/server/domain/suppliers/compare";
import { rupees } from "@/server/money";

const row = (id: string, rate: number | null, opts: { declined?: boolean; confidenceBps?: number | null } = {}) => ({
  id,
  ratePerRoomNight: rate === null ? null : rupees(rate),
  declined: opts.declined ?? false,
  confidenceBps: opts.confidenceBps === undefined ? 9_000 : opts.confidenceBps,
});

describe("bestRow", () => {
  it("picks the lowest trusted rate, ignoring declines and unconfirmed low-confidence quotes", () => {
    const rows = [
      row("gangtok", 2600),
      row("declined", 1800, { declined: true }),
      row("needs-check", 1900, { confidenceBps: 4_000 }),
      row("total-only", 2000, { confidenceBps: 6_000 }),
      row("himalayan", 2150),
      row("manual", 2380, { confidenceBps: null }),
      row("silent", null),
    ];
    expect(bestRow(rows)?.id).toBe("himalayan");
  });

  it("a needs-check quote wins once staff confirm it", () => {
    expect(bestRow([row("a", 2150), row("b", 1900, { confidenceBps: 10_000 })])?.id).toBe("b");
    expect(bestRow([row("m", 2300, { confidenceBps: null }), row("x", 2500)])?.id).toBe("m");
  });

  it("is null when nothing is trustworthy", () => {
    expect(bestRow([row("d", 2000, { declined: true }), row("l", 2100, { confidenceBps: 4_000 })])).toBeNull();
  });
});

describe("savings", () => {
  it("(₹2,500 − ₹2,150) × 10 rooms × 3 nights = ₹10,500, 14% cheaper", () => {
    expect(savings(rupees(2_500), rupees(2_150), 10, 3)).toEqual({ perRoomNight: rupees(350), total: rupees(10_500), pctBps: 1_400 });
  });

  it("stays in integer paise for odd amounts", () => {
    const s = savings(rupees(2_499), rupees(2_150), 7, 2)!;
    expect(s.total).toBe(rupees(349 * 14));
    expect(Number.isInteger(s.pctBps)).toBe(true);
    expect(s.pctBps).toBe(1_397);
  });

  it("is null without a baseline, or when the best isn't cheaper", () => {
    expect(savings(null, rupees(2_150), 10, 3)).toBeNull();
    expect(savings(rupees(2_000), rupees(2_150), 10, 3)).toBeNull();
    expect(savings(rupees(2_150), null, 10, 3)).toBeNull();
  });
});

describe("stated totals", () => {
  it("match within ₹1 per room-night of rate × rooms × nights", () => {
    expect(totalMatches(rupees(64_500), rupees(2_150), 10, 3)).toBe(true);
    expect(totalMatches(rupees(64_530), rupees(2_150), 10, 3)).toBe(true); // +₹30 over 30 room-nights
    expect(totalMatches(rupees(64_531), rupees(2_150), 10, 3)).toBe(false);
    expect(totalMatches(rupees(21_500), rupees(2_150), 10, 3)).toBe(false);
  });

  it("the bookable amount is always consistent with the rate", () => {
    expect(bookableTotal({ ratePerRoomNight: rupees(2_150), totalAmount: rupees(21_500) }, 10, 3)).toBe(rupees(64_500));
    expect(bookableTotal({ ratePerRoomNight: rupees(2_150), totalAmount: rupees(64_510) }, 10, 3)).toBe(rupees(64_510));
  });
});
