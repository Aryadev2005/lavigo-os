/** Profit cost basis (PRF-2): actual bills once they're the whole story, else planned. */
import { describe, expect, it } from "vitest";
import { costBasis } from "@/server/domain/profit";
import { rupees } from "@/server/money";

describe("costBasis", () => {
  it("planned when nothing is billed", () => {
    expect(costBasis(rupees(228_900), null, false)).toEqual({ cost: rupees(228_900), basis: "planned", billed: 0 });
  });
  it("stays planned while only part is billed on an upcoming trip (Nepal: tickets only)", () => {
    expect(costBasis(rupees(228_900), rupees(41_160), false)).toEqual({ cost: rupees(228_900), basis: "planned", billed: rupees(41_160) });
  });
  it("actual once bills reach the plan, even before travel (Goa)", () => {
    expect(costBasis(rupees(78_100), rupees(78_100), false).basis).toBe("actual");
    expect(costBasis(rupees(78_100), rupees(80_000), false).cost).toBe(rupees(80_000));
  });
  it("actual after the trip, even when it came in under plan", () => {
    expect(costBasis(rupees(34_500), rupees(30_000), true)).toEqual({ cost: rupees(30_000), basis: "actual", billed: rupees(30_000) });
  });
});
