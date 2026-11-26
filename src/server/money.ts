/**
 * Money is integer PAISE (₹1 = 100). Percentages are integer BASIS POINTS (1% = 100).
 * Never use floats for money; format only at the edge with inr().
 */

export type Paise = number;
export type Bps = number;

export const PAISE_PER_RUPEE = 100;
export const BPS_DENOMINATOR = 10_000;

export function assertPaise(value: number, label = "amount"): asserts value is Paise {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer number of paise, got ${value}`);
}

/** Whole rupees → paise. Accepts integers only (₹13,999 → 1_399_900). */
export function rupees(r: number): Paise {
  if (!Number.isSafeInteger(r)) throw new TypeError(`rupees() takes whole rupees, got ${r}`);
  return r * PAISE_PER_RUPEE;
}

/** Integer division rounding half away from zero (banker's rounding is not used for INR). */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError("division by zero");
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** amount × bps / 10000, rounded to the nearest paisa. */
export function applyBps(amount: Paise, bps: Bps): Paise {
  assertPaise(amount);
  if (!Number.isSafeInteger(bps)) throw new TypeError(`bps must be an integer, got ${bps}`);
  return divRound(amount * bps, BPS_DENOMINATOR);
}

/** part / whole as basis points, rounded (e.g. margin). */
export function toBps(part: Paise, whole: Paise): Bps {
  if (whole === 0) return 0;
  return divRound(part * BPS_DENOMINATOR, whole);
}

/** Round UP to the next multiple of `step` paise (ceil10 rupees = ceilTo(x, 1000)). */
export function ceilTo(amount: Paise, step: Paise): Paise {
  assertPaise(amount);
  if (step <= 0) throw new RangeError("step must be positive");
  return Math.ceil(amount / step) * step;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce((s, v) => s + v, 0);
}

const inrWhole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0, minimumFractionDigits: 0 });
const inrExact = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/**
 * Format paise as Indian rupees: inr(1_399_900) → "₹13,999".
 * Shows paise only when present or when `exact` is set.
 */
export function inr(amount: Paise, opts: { exact?: boolean } = {}): string {
  assertPaise(amount);
  const sign = amount < 0 ? "−" : "";
  const abs = Math.abs(amount);
  const hasPaise = abs % PAISE_PER_RUPEE !== 0;
  const body =
    opts.exact || hasPaise ? inrExact.format(abs / PAISE_PER_RUPEE) : inrWhole.format(abs / PAISE_PER_RUPEE);
  return `${sign}₹${body}`;
}

/** Compact lakh format for charts: 490000_00 → "4.9L". */
export function inrLakh(amount: Paise, digits = 1): string {
  assertPaise(amount);
  return `${(amount / PAISE_PER_RUPEE / 100_000).toFixed(digits)}L`;
}

/** Format basis points as a percent string: 2140 → "21.4%". */
export function pct(bps: Bps, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}
