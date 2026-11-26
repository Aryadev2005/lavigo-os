/**
 * Pricing rules (SRS §4.11, RUL-1 … RUL-4). OWNER only, enforced here. Every save is audited and
 * published as `settings.updated`, so open inboxes re-render their price meter; the quote builder
 * reads settings fresh on every evaluation, so the next decision uses the new rules.
 */
import type { Role } from "@prisma/client";
import { audit } from "../../audit";
import { db } from "../../db";
import { publish } from "../../pubsub";
import type { PricingOffer } from "../pricing";
import { todayIST } from "../../time";
import { assertOwner } from "../profit";
import { getSettings } from "./index";
import { OFFER_DEFAULTS, RULE_OFFERS, FLOOR_MAX_BPS, FLOOR_MIN_BPS, SOLO_MAX, SOLO_STEP, type RulesInput } from "./rules-preview";
export * from "./rules-preview";

export type RulesView = RulesInput & {
  charmEnding: number;
  /** The sample departure for the live preview (Nepal, else the next open departure). */
  sample: { code: string; name: string; id: string; pricePerPax: number; costPerPax: number; startDate: string } | null;
  /** Departure-specific offers also count in the preview. */
  sampleOffers: PricingOffer[];
  today: string;
  updatedAt: string;
};

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesError";
  }
}

export async function getRulesView(actor: { role: Role }, now: Date = new Date()): Promise<RulesView> {
  assertOwner(actor);
  const today = todayIST(now);
  const [s, offers, nepal] = await Promise.all([
    getSettings(),
    db.offer.findMany({ where: { departureId: null, kind: { in: [...RULE_OFFERS] } }, orderBy: { createdAt: "asc" } }),
    db.departure.findFirst({ where: { status: "OPEN", startDate: { gte: today }, trip: { slug: "nepal" } }, orderBy: { startDate: "asc" }, include: { trip: { select: { name: true } } } }),
  ]);
  const sample = nepal ?? (await db.departure.findFirst({ where: { status: "OPEN", startDate: { gte: today } }, orderBy: { startDate: "asc" }, include: { trip: { select: { name: true } } } }));
  const sampleOffers = sample ? await db.offer.findMany({ where: { departureId: sample.id, enabled: true } }) : [];
  return {
    floorMarginBps: s.floorMarginBps,
    soloDiscountPerPax: s.soloDiscountPerPax,
    stackOffers: s.stackOffers,
    escalateGroupSizeAtLeast: s.escalateGroupSizeAtLeast,
    charmEnding: s.charmEnding,
    offers: RULE_OFFERS.map((kind) => {
      const o = offers.find((x) => x.kind === kind);
      return { kind, enabled: o?.enabled ?? false, amountPerPax: o?.amountPerPax ?? 50_000, minPax: o?.minPax ?? (kind === "GROUP" ? 6 : null), minDaysBeforeTravel: o?.minDaysBeforeTravel ?? (kind === "EARLY_BIRD" ? 45 : null) };
    }),
    sample: sample ? { id: sample.id, code: sample.code, name: sample.trip.name, pricePerPax: sample.pricePerPax, costPerPax: sample.costPerPax, startDate: sample.startDate.toISOString().slice(0, 10) } : null,
    sampleOffers: sampleOffers.map((o) => ({ kind: o.kind, name: o.name, amountPerPax: o.amountPerPax, minPax: o.minPax, minDaysBeforeTravel: o.minDaysBeforeTravel, enabled: o.enabled, departureId: o.departureId })),
    today: today.toISOString().slice(0, 10),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function validate(input: RulesInput) {
  const bad = (m: string) => {
    throw new RulesError(m);
  };
  if (!Number.isInteger(input.floorMarginBps) || input.floorMarginBps < FLOOR_MIN_BPS || input.floorMarginBps > FLOOR_MAX_BPS) bad("Minimum margin must be 8–30%");
  if (!Number.isSafeInteger(input.soloDiscountPerPax) || input.soloDiscountPerPax < 0 || input.soloDiscountPerPax > SOLO_MAX || input.soloDiscountPerPax % SOLO_STEP) bad("Staff discount must be ₹0–₹1,500 in steps of ₹100");
  if (!Number.isInteger(input.escalateGroupSizeAtLeast) || input.escalateGroupSizeAtLeast < 2 || input.escalateGroupSizeAtLeast > 200) bad("Group size must be 2–200");
  for (const o of input.offers) {
    if (!RULE_OFFERS.includes(o.kind)) bad("Unknown offer");
    if (!Number.isSafeInteger(o.amountPerPax) || o.amountPerPax < 0 || o.amountPerPax > 1_000_000) bad("Offer amounts must be ₹0–₹10,000");
    if (o.kind === "GROUP" && (!Number.isInteger(o.minPax) || o.minPax! < 2)) bad("Group offer needs at least 2 people");
    if (o.kind === "EARLY_BIRD" && (!Number.isInteger(o.minDaysBeforeTravel) || o.minDaysBeforeTravel! < 1)) bad("Early-bird needs a number of days");
  }
}

/** Save the rules (OWNER only), audit before/after, and tell open pages. */
export async function saveRules(input: RulesInput, actor: { id: string; role: Role }) {
  assertOwner(actor);
  validate(input);
  const before = await getRulesView(actor);
  await db.$transaction(async (tx) => {
    await tx.agentSettings.upsert({
      where: { id: 1 },
      update: { floorMarginBps: input.floorMarginBps, soloDiscountPerPax: input.soloDiscountPerPax, stackOffers: input.stackOffers, escalateGroupSizeAtLeast: input.escalateGroupSizeAtLeast, updatedById: actor.id },
      create: { id: 1, floorMarginBps: input.floorMarginBps, soloDiscountPerPax: input.soloDiscountPerPax, stackOffers: input.stackOffers, escalateGroupSizeAtLeast: input.escalateGroupSizeAtLeast, updatedById: actor.id },
    });
    for (const o of input.offers) {
      const d = OFFER_DEFAULTS[o.kind];
      const data = {
        enabled: o.enabled,
        amountPerPax: o.amountPerPax,
        minPax: o.kind === "GROUP" ? o.minPax : null,
        minDaysBeforeTravel: o.kind === "EARLY_BIRD" ? o.minDaysBeforeTravel : null,
        description: d.describe(o),
      };
      const existing = await tx.offer.findFirst({ where: { departureId: null, kind: o.kind }, orderBy: { createdAt: "asc" } });
      if (existing) await tx.offer.update({ where: { id: existing.id }, data });
      else await tx.offer.create({ data: { kind: o.kind, name: d.name, ...data } });
    }
    await audit(
      {
        userId: actor.id,
        action: "rules.update",
        entityType: "AgentSettings",
        entityId: "1",
        before: { floorMarginBps: before.floorMarginBps, soloDiscountPerPax: before.soloDiscountPerPax, stackOffers: before.stackOffers, escalateGroupSizeAtLeast: before.escalateGroupSizeAtLeast, offers: before.offers },
        after: input,
      },
      tx,
    );
  });
  await publish({ type: "settings.updated", payload: {} }).catch(() => undefined);
}

