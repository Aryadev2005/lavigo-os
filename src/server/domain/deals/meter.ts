/**
 * Guardrail meter geometry (INB-8). PURE (client-safe): positions from role-visible values only.
 * For STAFF, `floor` is null and the scale ignores it, so no marker position reveals the floor.
 */
import { inr } from "../../money";

export type Meter = {
  /** Track zones, % from the left: red below `redTo`, amber until `greenFrom`, green after. */
  redTo: number;
  greenFrom: number;
  offer: { pct: number; label: string };
  asked: { pct: number; label: string } | null;
  /** Staff limit marker (both roles: it's the staff's own limit). */
  limit: { pct: number; label: string } | null;
  /** OWNER only. */
  floor: { pct: number; label: string } | null;
};

/** Meter from role-visible values only. `floor` must be null for STAFF. */
export function buildMeter(v: { offer: number; asked: number | null; staffLimit: number; autoOffer: number; listPrice: number; floor: number | null }): Meter {
  const points = [v.offer, v.staffLimit, v.autoOffer, v.listPrice, ...(v.asked != null ? [v.asked] : []), ...(v.floor != null ? [v.floor] : [])];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const pad = Math.max(50_000, Math.round((max - min) * 0.25)); // ≥ ₹500 either side
  const lo = min - pad;
  const hi = max + pad;
  const pos = (x: number) => Math.round(Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100)) * 10) / 10;
  const red = v.floor ?? v.staffLimit; // staff: "red" is below their own limit
  return {
    redTo: pos(red),
    greenFrom: pos(Math.max(red, v.autoOffer)),
    offer: { pct: pos(v.offer), label: `Offer ${inr(v.offer)}` },
    asked: v.asked != null ? { pct: pos(v.asked), label: `Asked ${inr(v.asked)}` } : null,
    limit: v.floor != null && v.staffLimit === v.floor ? null : { pct: pos(v.staffLimit), label: `staff limit ${inr(v.staffLimit)}` },
    floor: v.floor != null ? { pct: pos(v.floor), label: `floor ${inr(v.floor)}` } : null,
  };
}
