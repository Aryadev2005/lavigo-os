/** Pricing rules: shared types and the live preview (PURE: safe to import in client components). */
import type { OfferKind } from "@prisma/client";
import { inr } from "../../money";
import { evaluatePrice, type PricingOffer, type PricingSettings, type PriceResult } from "../pricing";

export const RULE_OFFERS = ["GROUP", "EARLY_BIRD", "REPEAT_TRAVELLER"] as const satisfies readonly OfferKind[];
export type RuleOfferKind = (typeof RULE_OFFERS)[number];

export const FLOOR_MIN_BPS = 800;
export const FLOOR_MAX_BPS = 3000;
export const SOLO_MAX = 150_000; // ₹1,500
export const SOLO_STEP = 10_000; // ₹100
export const PREVIEW_PAX = 6;

export type RuleOffer = { kind: RuleOfferKind; enabled: boolean; amountPerPax: number; minPax: number | null; minDaysBeforeTravel: number | null };

export type RulesSample = { id: string; pricePerPax: number; costPerPax: number; startDate: string };

export type RulesInput = {
  floorMarginBps: number;
  soloDiscountPerPax: number;
  stackOffers: boolean;
  escalateGroupSizeAtLeast: number;
  offers: RuleOffer[];
};

export const OFFER_DEFAULTS: Record<RuleOfferKind, { name: string; describe: (o: RuleOffer) => string }> = {
  GROUP: { name: "Group offer", describe: (o) => `${inr(o.amountPerPax)} off per person for ${o.minPax ?? 6} or more` },
  EARLY_BIRD: { name: "Early-bird", describe: (o) => `${inr(o.amountPerPax)} off when booked ${o.minDaysBeforeTravel ?? 45}+ days before` },
  REPEAT_TRAVELLER: { name: "Repeat traveller", describe: (o) => `${inr(o.amountPerPax)} off for anyone who travelled with Lavigo before` },
};


// ───────────────────────────── RUL-3 preview (pure) ─────────────────────────────

export type RulesPreview = {
  result: PriceResult;
  /** "your staff can go down to ₹13,499 on their own; between ₹13,499 and ₹13,140 they ask you; below ₹13,140 only you can approve" */
  sentence: string;
};

/** The same evaluatePrice the quote builder uses, on the sample departure for a group of 6. */
export function previewRules(rules: RulesInput & { charmEnding: number }, sample: RulesSample, sampleOffers: readonly PricingOffer[], today: Date): RulesPreview {
  const settings: PricingSettings = {
    floorMarginBps: rules.floorMarginBps,
    soloDiscountPerPax: rules.soloDiscountPerPax,
    escalateGroupSizeAtLeast: rules.escalateGroupSizeAtLeast,
    charmEnding: rules.charmEnding,
    stackOffers: rules.stackOffers,
  };
  const offers: PricingOffer[] = [
    ...rules.offers.map((o) => ({ kind: o.kind, name: OFFER_DEFAULTS[o.kind].name, amountPerPax: o.amountPerPax, minPax: o.minPax, minDaysBeforeTravel: o.minDaysBeforeTravel, enabled: o.enabled, departureId: null })),
    ...sampleOffers,
  ];
  const result = evaluatePrice({
    departure: { id: sample.id, pricePerPax: sample.pricePerPax, costPerPax: sample.costPerPax, startDate: new Date(`${sample.startDate}T00:00:00Z`) },
    pax: PREVIEW_PAX,
    isRepeatCustomer: false,
    today,
    settings,
    offers,
  });
  const L = inr(result.staffLimit);
  const F = inr(result.floor);
  const sentence = result.isLargeGroup
    ? `every quote for a group of ${PREVIEW_PAX} comes to you first (groups of ${rules.escalateGroupSizeAtLeast}+ always need your OK); below ${F} only you can approve`
    : result.staffLimit > result.floor
      ? `your staff can go down to ${L} on their own; between ${L} and ${F} they ask you; below ${F} only you can approve`
      : `your staff can go down to ${L} on their own, which is already your floor; below ${F} only you can approve`;
  return { result, sentence };
}
