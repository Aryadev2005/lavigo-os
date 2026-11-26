import { describe, expect, it } from "vitest";
import { inr, rupees } from "@/server/money";
import { dateOnly, istDateString } from "@/server/time";

// Phase 0: proves the test pipeline runs. Real tests arrive with real logic (system design §13).
describe("sanity", () => {
  it("formats paise as rupees", () => {
    expect(inr(rupees(13_999))).toBe("₹13,999");
  });

  it("reads calendar days in Asia/Kolkata", () => {
    expect(istDateString(new Date("2026-11-27T19:00:00Z"))).toBe("2026-11-28");
    expect(dateOnly("2026-11-28").toISOString()).toBe("2026-11-28T00:00:00.000Z");
  });
});
