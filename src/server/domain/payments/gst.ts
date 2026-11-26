/**
 * GST breakup for a GST-INCLUSIVE amount (PAY-8). Rate from AgentSettings.gstRateBps
 * (default 5%: pending CA confirmation, SRS open question Q4). PURE, integer paise.
 *
 *   taxable = total / (1 + r)      (rounded to the nearest paisa)
 *   tax     = total − taxable      (so the parts always add up exactly)
 *   intra-state (Jharkhand → Jharkhand): CGST = SGST = tax / 2; inter-state: IGST = tax
 */
import { divRound } from "../../money";

export type GstBreakup = {
  total: number;
  taxableValue: number;
  gstRateBps: number;
  cgst: number;
  sgst: number;
  igst: number;
};

export function gstInclusiveBreakup(total: number, gstRateBps: number, opts: { interState?: boolean } = {}): GstBreakup {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("total must be non-negative paise");
  if (!Number.isSafeInteger(gstRateBps) || gstRateBps < 0) throw new RangeError("gstRateBps must be ≥ 0");
  const taxableValue = divRound(total * 10_000, 10_000 + gstRateBps);
  const tax = total - taxableValue;
  if (opts.interState) return { total, taxableValue, gstRateBps, cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { total, taxableValue, gstRateBps, cgst, sgst: tax - cgst, igst: 0 };
}
