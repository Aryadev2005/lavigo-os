/**
 * Compare & rank supplier quotes (SUP-6, DFD 6.5). PURE: money in paise, percentages in bps.
 *
 * Best = the lowest rate among quotes that aren't declines and are trustworthy: confirmed by staff
 * (manual or one-click confirmed) or parsed at high confidence. "Needs check" quotes never win
 * until someone confirms them.
 */
import { toBps } from "../../money";

export const HIGH_CONFIDENCE_BPS = 8_000;

export type CompareRow = {
  id: string;
  /** Paise per room-night; null when the supplier declined or hasn't quoted. */
  ratePerRoomNight: number | null;
  declined: boolean;
  /** null = typed by staff (MANUAL). */
  confidenceBps: number | null;
};

export const isTrusted = (r: Pick<CompareRow, "confidenceBps">) => r.confidenceBps === null || r.confidenceBps >= HIGH_CONFIDENCE_BPS;

export function bestRow<T extends CompareRow>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.declined || r.ratePerRoomNight === null || !isTrusted(r)) continue;
    if (!best || r.ratePerRoomNight < best.ratePerRoomNight!) best = r;
  }
  return best;
}

export type Savings = { perRoomNight: number; total: number; pctBps: number };

/** (baseline − best) × rooms × nights, and how much cheaper in bps. null when there's nothing saved. */
export function savings(baseline: number | null, best: number | null, rooms: number, nights: number): Savings | null {
  if (baseline === null || best === null || baseline <= 0 || best >= baseline) return null;
  const perRoomNight = baseline - best;
  return { perRoomNight, total: perRoomNight * rooms * nights, pctBps: toBps(perRoomNight, baseline) };
}
