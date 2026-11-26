/** Pure payment amount rules (PAY-1), shared by payments, dues and the reminder planner. */
import { divRound } from "../../money";

/** Round half up to the whole rupee. */
export function roundToRupee(paise: number): number {
  return divRound(paise, 100) * 100;
}

/** The advance that locks seats: total × advancePct, rounded half-up to the rupee. */
export function advanceAmount(totalAmount: number, advancePctBps: number): number {
  return roundToRupee(divRound(totalAmount * advancePctBps, 10_000));
}

/**
 * ADVANCE = advanceAmount (capped at what's still owed). BALANCE / FULL = whatever is still owed.
 */
export function linkAmount(
  booking: { totalAmount: number; paidAmount: number },
  purpose: "ADVANCE" | "BALANCE" | "FULL",
  advancePctBps: number,
): number {
  const owed = booking.totalAmount - booking.paidAmount;
  if (purpose === "ADVANCE") return Math.min(owed, advanceAmount(booking.totalAmount, advancePctBps));
  return owed;
}
