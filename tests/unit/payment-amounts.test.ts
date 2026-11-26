import { describe, expect, it } from "vitest";
import { linkAmount } from "@/server/domain/payments";
import { gstInclusiveBreakup } from "@/server/domain/payments/gst";
import { rupees } from "@/server/money";

describe("advance link amount (PAY-1)", () => {
  it("is total × advance %, rounded half-up to the rupee", () => {
    // 6 × ₹13,499 = ₹80,994 × 25% = ₹20,248.50 → ₹20,249
    expect(linkAmount({ totalAmount: rupees(80_994), paidAmount: 0 }, "ADVANCE", 2500)).toBe(rupees(20_249));
    // ₹10,001 × 25% = ₹2,500.25 → ₹2,500
    expect(linkAmount({ totalAmount: rupees(10_001), paidAmount: 0 }, "ADVANCE", 2500)).toBe(rupees(2_500));
  });

  it("never asks for more than is owed; balance is what remains", () => {
    expect(linkAmount({ totalAmount: rupees(10_000), paidAmount: rupees(9_000) }, "ADVANCE", 2500)).toBe(rupees(1_000));
    expect(linkAmount({ totalAmount: rupees(80_994), paidAmount: rupees(20_249) }, "BALANCE", 2500)).toBe(rupees(60_745));
  });
});

describe("GST-inclusive breakup (PAY-8)", () => {
  it("splits 5% inclusive into taxable + CGST + SGST that add up exactly", () => {
    const b = gstInclusiveBreakup(rupees(80_994), 500);
    expect(b.taxableValue).toBe(7_713_714); // 8,099,400 / 1.05 = 7,713,714.29 → 7,713,714
    expect(b.cgst + b.sgst).toBe(rupees(80_994) - b.taxableValue);
    expect(Math.abs(b.cgst - b.sgst)).toBeLessThanOrEqual(1);
    expect(b.igst).toBe(0);
  });

  it("uses IGST for inter-state and handles a zero rate", () => {
    expect(gstInclusiveBreakup(rupees(10_500), 500, { interState: true })).toMatchObject({ taxableValue: rupees(10_000), igst: rupees(500), cgst: 0, sgst: 0 });
    expect(gstInclusiveBreakup(rupees(10_500), 0)).toMatchObject({ taxableValue: rupees(10_500), cgst: 0, sgst: 0 });
  });
});
