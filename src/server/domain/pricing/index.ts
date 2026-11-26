/**
 * Pricing engine (SRS §4.3, PRC-1 … PRC-6). PURE: no DB, no clock, no I/O.
 *
 * Every price the server writes (quotes, bookings, approvals) is re-derived here:
 * a client-sent price is only `requestedPricePerPax`, an input.
 *
 * Definitions (SRS §1.2), all integer paise:
 *   F (floor)       = ceil to ₹10 of C / (1 − m)
 *   A (auto offer)  = list − best single eligible offer (or the sum, if settings.stackOffers)
 *   L (staff limit) = max(F, A − s)      s = settings.soloDiscountPerPax
 *   suggestedCounter = smallest price ≥ F ending in settings.charmEnding
 */
import type { OfferKind, Role } from "@prisma/client";
import { BPS_DENOMINATOR, type Bps, type Paise, toBps } from "../../money";
import { daysBetween } from "../../time";

export type PricingSettings = {
  floorMarginBps: Bps;
  soloDiscountPerPax: Paise;
  escalateGroupSizeAtLeast: number;
  charmEnding: number; // 0–99 rupees, e.g. 99 → ₹…99
  stackOffers?: boolean; // default false (PRC-3, open question Q6)
};

export type PricingOffer = {
  id?: string;
  kind: OfferKind;
  name: string;
  amountPerPax: Paise;
  minPax?: number | null;
  minDaysBeforeTravel?: number | null;
  enabled?: boolean;
  departureId?: string | null;
};

export type PricingDeparture = {
  id?: string;
  pricePerPax: Paise;
  costPerPax: Paise;
  startDate: Date; // calendar date (IST)
};

export type PriceInput = {
  departure: PricingDeparture;
  pax: number;
  isRepeatCustomer: boolean;
  today: Date; // calendar date (IST), from todayIST()
  settings: PricingSettings;
  offers: readonly PricingOffer[];
  requestedPricePerPax?: Paise | null;
};

export type Decision =
  | "ACCEPT_AUTO" // r ≥ A: quote A (never charge more than asked)
  | "ACCEPT_WITHIN_AUTONOMY" // L ≤ r < A
  | "NEEDS_APPROVAL" // F ≤ r < L
  | "BELOW_FLOOR" // r < F
  | "LARGE_GROUP"; // pax ≥ escalateGroupSizeAtLeast: always escalates (PRC-6)

export type AppliedOffer = { kind: OfferKind; name: string; amountPerPax: Paise };

export type PriceResult = {
  pax: number;
  listPrice: Paise;
  costPerPax: Paise;
  eligibleOffers: AppliedOffer[];
  appliedOffers: AppliedOffer[];
  autoOffer: Paise; // A
  floor: Paise; // F
  staffLimit: Paise; // L
  suggestedCounter: Paise;
  counterPlus100: Paise; // the owner's "Counter" button (+₹100)
  requestedPricePerPax: Paise | null;
  /** The per-person price the decision implies: A for ACCEPT_AUTO, else the requested price. */
  quotePricePerPax: Paise;
  decision: Decision;
  /** Decision from the price bands alone, ignoring the large-group rule. */
  priceBand: Exclude<Decision, "LARGE_GROUP">;
  isLargeGroup: boolean;
  daysToDeparture: number;
  marginBpsAt: (pricePerPax: Paise) => Bps;
};

const RUPEE: Paise = 100;
const TEN_RUPEES: Paise = 10 * RUPEE;
const HUNDRED_RUPEES: Paise = 100 * RUPEE;

function assertPositiveInt(n: number, label: string) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`${label} must be a positive integer, got ${n}`);
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** F = ceil to ₹10 of C / (1 − m). Integer-only (PRC-4). */
export function floorPrice(costPerPax: Paise, floorMarginBps: Bps): Paise {
  if (floorMarginBps < 0 || floorMarginBps >= BPS_DENOMINATOR) throw new RangeError("floorMarginBps must be in [0, 10000)");
  // C × 10000 / (10000 − m), rounded up to a multiple of ₹10.
  return ceilDiv(costPerPax * BPS_DENOMINATOR, (BPS_DENOMINATOR - floorMarginBps) * TEN_RUPEES) * TEN_RUPEES;
}

/** Smallest price ≥ min whose rupee amount ends in `charmEnding` (two digits, e.g. 99). */
export function charmAtLeast(min: Paise, charmEnding: number): Paise {
  if (!Number.isInteger(charmEnding) || charmEnding < 0 || charmEnding > 99) throw new RangeError("charmEnding must be 0–99");
  let candidate = Math.floor(min / HUNDRED_RUPEES) * HUNDRED_RUPEES + charmEnding * RUPEE;
  if (candidate < min) candidate += HUNDRED_RUPEES;
  return candidate;
}

/** Margin at a price, in basis points of that price. */
export function marginBps(pricePerPax: Paise, costPerPax: Paise): Bps {
  return toBps(pricePerPax - costPerPax, pricePerPax);
}

export function isOfferEligible(
  offer: PricingOffer,
  ctx: { pax: number; daysToDeparture: number; isRepeatCustomer: boolean; departureId?: string },
): boolean {
  if (offer.enabled === false) return false;
  if (offer.amountPerPax <= 0) return false;
  if (offer.departureId && ctx.departureId && offer.departureId !== ctx.departureId) return false;
  if (offer.departureId && !ctx.departureId) return false;
  if (offer.minPax != null && ctx.pax < offer.minPax) return false;
  if (offer.minDaysBeforeTravel != null && ctx.daysToDeparture < offer.minDaysBeforeTravel) return false;
  if (offer.kind === "REPEAT_TRAVELLER" && !ctx.isRepeatCustomer) return false;
  return true;
}

function bandFor(r: Paise, A: Paise, L: Paise, F: Paise): PriceResult["priceBand"] {
  if (r < F) return "BELOW_FLOOR"; // floor wins even if a misconfigured list price puts A below F
  if (r >= A) return "ACCEPT_AUTO";
  if (r >= L) return "ACCEPT_WITHIN_AUTONOMY";
  return "NEEDS_APPROVAL";
}

export function evaluatePrice(input: PriceInput): PriceResult {
  const { departure, pax, settings } = input;
  assertPositiveInt(pax, "pax");
  assertPositiveInt(departure.pricePerPax, "pricePerPax");
  if (!Number.isSafeInteger(departure.costPerPax) || departure.costPerPax < 0) throw new RangeError("costPerPax must be ≥ 0");
  if (!Number.isSafeInteger(settings.soloDiscountPerPax) || settings.soloDiscountPerPax < 0) {
    throw new RangeError("soloDiscountPerPax must be ≥ 0");
  }
  const requested = input.requestedPricePerPax ?? null;
  if (requested !== null) assertPositiveInt(requested, "requestedPricePerPax");

  const listPrice = departure.pricePerPax;
  const daysToDeparture = daysBetween(input.today, departure.startDate);

  const eligibleOffers: AppliedOffer[] = input.offers
    .filter((o) =>
      isOfferEligible(o, { pax, daysToDeparture, isRepeatCustomer: input.isRepeatCustomer, departureId: departure.id }),
    )
    .map((o) => ({ kind: o.kind, name: o.name, amountPerPax: o.amountPerPax }))
    // Largest first; ties broken by name so the result is deterministic.
    .sort((a, b) => b.amountPerPax - a.amountPerPax || a.name.localeCompare(b.name));

  const appliedOffers = settings.stackOffers ? eligibleOffers : eligibleOffers.slice(0, 1);
  const discount = appliedOffers.reduce((s, o) => s + o.amountPerPax, 0);
  const autoOffer = Math.max(RUPEE, listPrice - discount);

  const floor = floorPrice(departure.costPerPax, settings.floorMarginBps);
  const staffLimit = Math.max(floor, autoOffer - settings.soloDiscountPerPax);
  const suggestedCounter = charmAtLeast(floor, settings.charmEnding);
  const counterPlus100 = suggestedCounter + HUNDRED_RUPEES;

  const r = requested ?? autoOffer;
  const priceBand = bandFor(r, autoOffer, staffLimit, floor);
  const isLargeGroup = pax >= settings.escalateGroupSizeAtLeast;
  const decision: Decision = isLargeGroup ? "LARGE_GROUP" : priceBand;
  const quotePricePerPax = priceBand === "ACCEPT_AUTO" ? autoOffer : r;

  const cost = departure.costPerPax;
  return {
    pax,
    listPrice,
    costPerPax: cost,
    eligibleOffers,
    appliedOffers,
    autoOffer,
    floor,
    staffLimit,
    suggestedCounter,
    counterPlus100,
    requestedPricePerPax: requested,
    quotePricePerPax,
    decision,
    priceBand,
    isLargeGroup,
    daysToDeparture,
    marginBpsAt: (p: Paise) => marginBps(p, cost),
  };
}

// ───────────────────────────── authorisation of a price ─────────────────────────────

export type CanQuoteReason =
  | "AT_OR_ABOVE_STAFF_LIMIT"
  | "OWNER_APPROVED"
  | "OWNER_AT_OR_ABOVE_FLOOR"
  | "OWNER_BELOW_FLOOR_CONFIRMED"
  | "BELOW_STAFF_LIMIT"
  | "BELOW_APPROVED_PRICE"
  | "LARGE_GROUP_NEEDS_APPROVAL"
  | "BELOW_FLOOR"
  | "BELOW_FLOOR_NEEDS_CONFIRMATION"
  | "INVALID_PRICE";

export type CanQuoteResult = {
  ok: boolean;
  reason: CanQuoteReason;
  /** The caller must write an AuditLog row (below L, or owner below F: AUTH-5, PRC-5). */
  audit: null | "quote.below_limit" | "quote.below_floor";
};

/**
 * May `role` quote `price` per person given an engine result?
 * - STAFF: price ≥ L, or ≥ an owner-approved price. Never below F on their own; large groups need approval.
 * - OWNER: price ≥ F; below F only with `confirmBelowFloor` (second confirmation, audited).
 * `approvedPrice` must come from an APPROVED/COUNTERED Approval row loaded on the server.
 */
export function canQuote(
  result: Pick<PriceResult, "floor" | "staffLimit" | "isLargeGroup">,
  price: Paise,
  role: Role,
  opts: { approvedPrice?: Paise | null; confirmBelowFloor?: boolean } = {},
): CanQuoteResult {
  if (!Number.isSafeInteger(price) || price <= 0) return { ok: false, reason: "INVALID_PRICE", audit: null };
  const { floor, staffLimit, isLargeGroup } = result;
  const approved = opts.approvedPrice ?? null;

  if (role === "OWNER") {
    if (price >= floor) {
      return { ok: true, reason: "OWNER_AT_OR_ABOVE_FLOOR", audit: price < staffLimit ? "quote.below_limit" : null };
    }
    return opts.confirmBelowFloor
      ? { ok: true, reason: "OWNER_BELOW_FLOOR_CONFIRMED", audit: "quote.below_floor" }
      : { ok: false, reason: "BELOW_FLOOR_NEEDS_CONFIRMATION", audit: null };
  }

  // STAFF (and, in v2, the AI): an owner approval is the only way past L, F or a large group.
  if (approved !== null) {
    if (price >= approved) {
      const below = price < floor ? "quote.below_floor" : price < staffLimit ? "quote.below_limit" : null;
      return { ok: true, reason: "OWNER_APPROVED", audit: below };
    }
    return { ok: false, reason: "BELOW_APPROVED_PRICE", audit: null };
  }
  if (isLargeGroup) return { ok: false, reason: "LARGE_GROUP_NEEDS_APPROVAL", audit: null };
  if (price < floor) return { ok: false, reason: "BELOW_FLOOR", audit: null };
  if (price < staffLimit) return { ok: false, reason: "BELOW_STAFF_LIMIT", audit: null };
  return { ok: true, reason: "AT_OR_ABOVE_STAFF_LIMIT", audit: null };
}

// ───────────────────────────── role-filtered view ─────────────────────────────

type CommonView = {
  pax: number;
  listPrice: Paise;
  appliedOffers: AppliedOffer[];
  eligibleOffers: AppliedOffer[];
  autoOffer: Paise;
  staffLimit: Paise;
  suggestedCounter: Paise;
  counterPlus100: Paise;
  requestedPricePerPax: Paise | null;
  quotePricePerPax: Paise;
  decision: Decision;
  priceBand: PriceResult["priceBand"];
  isLargeGroup: boolean;
  daysToDeparture: number;
};

export type StaffPriceView = CommonView & { role: "STAFF" };
export type OwnerPriceView = CommonView & {
  role: "OWNER";
  floor: Paise;
  costPerPax: Paise;
  marginBpsAtQuote: Bps;
  marginBpsAtSuggested: Bps;
  marginBpsAtStaffLimit: Bps;
};

/**
 * Serializable view for RSC props / action responses. STAFF never receives floor, cost or margin
 * (CLAUDE.md). v2's AI agent reuses the STAFF view.
 */
export function forRole(result: PriceResult, role: "STAFF"): StaffPriceView;
export function forRole(result: PriceResult, role: "OWNER"): OwnerPriceView;
export function forRole(result: PriceResult, role: Role): StaffPriceView | OwnerPriceView;
export function forRole(result: PriceResult, role: Role): StaffPriceView | OwnerPriceView {
  const common: CommonView = {
    pax: result.pax,
    listPrice: result.listPrice,
    appliedOffers: result.appliedOffers.map((o) => ({ ...o })),
    eligibleOffers: result.eligibleOffers.map((o) => ({ ...o })),
    autoOffer: result.autoOffer,
    staffLimit: result.staffLimit,
    suggestedCounter: result.suggestedCounter,
    counterPlus100: result.counterPlus100,
    requestedPricePerPax: result.requestedPricePerPax,
    quotePricePerPax: result.quotePricePerPax,
    decision: result.decision,
    priceBand: result.priceBand,
    isLargeGroup: result.isLargeGroup,
    daysToDeparture: result.daysToDeparture,
  };
  if (role !== "OWNER") return { ...common, role: "STAFF" };
  return {
    ...common,
    role: "OWNER",
    floor: result.floor,
    costPerPax: result.costPerPax,
    marginBpsAtQuote: result.marginBpsAt(result.quotePricePerPax),
    marginBpsAtSuggested: result.marginBpsAt(result.suggestedCounter),
    marginBpsAtStaffLimit: result.marginBpsAt(result.staffLimit),
  };
}
