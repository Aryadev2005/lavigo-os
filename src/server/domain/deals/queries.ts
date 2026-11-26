/**
 * Deal desk reads for the inbox right panel (INB-8) and the owner's /approvals/[id] page.
 *
 * Role safety: everything here is built for a role. Floor, cost and margin are only computed
 * into OWNER views (via pricing.forRole and explicit role checks); a STAFF view never carries
 * them, so they can't leak through RSC props. The meter scale for STAFF is derived only from
 * values staff may see, so marker positions don't reveal the floor either.
 */
import type { ApprovalKind, Role } from "@prisma/client";
import { db } from "../../db";
import { inr } from "../../money";
import { formatDate, formatIST } from "../../time";
import { evaluateForDeparture } from "../bookings";
import { advanceAmount } from "../payments/amounts";
import { forRole, marginBps, type OwnerPriceView, type StaffPriceView } from "../pricing";
import { getSettings } from "../settings";
import { buildMeter, type Meter } from "./meter";

export type { Meter };

// ───────────────────────────── panel ─────────────────────────────

export type ApprovalCard = {
  id: string;
  kind: ApprovalKind;
  customerFirst: string;
  pax: number | null;
  trip: string | null;
  requested: number | null;
  suggested: number | null;
  counter: number | null;
  createdAt: string;
  /** OWNER only. */
  owner: { floor: number; marginBpsAtSuggested: number; floorMarginBps: number; belowFloor: boolean } | null;
};

export type TimelineItem = { at: string; icon: string; text: string; sub: string | null; ts: number };

export type DealPanel = {
  role: Role;
  basis: { code: string; label: string; pax: number } | null;
  price: StaffPriceView | OwnerPriceView | null;
  meter: Meter | null;
  /** OWNER only. */
  owner: { costPerPax: number; floorMarginBps: number; marginBpsAtOffer: number } | null;
  staffCanGive: string;
  approval: ApprovalCard | null;
  quote: {
    id: string;
    pricePerPax: number;
    totalAmount: number;
    pax: number;
    validUntil: string;
    valid: boolean;
    advance: number;
    link: "none" | "sent" | "paid";
  } | null;
  result: { code: string; dealValue: number; advanceReceived: number; status: string } | null;
  followUpDue: boolean;
  timeline: TimelineItem[];
};

export async function getDealPanel(conversationId: string, role: Role, now: Date = new Date()): Promise<DealPanel | null> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { name: true } }, interestedDeparture: { include: { trip: true } } },
  });
  if (!conv?.customer) return null;

  const [quotes, approvals, bookings, settings] = await Promise.all([
    db.quote.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, include: { departure: { include: { trip: true } }, booking: { include: { paymentLinks: true } } } }),
    db.approval.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, include: { departure: { include: { trip: true } }, decidedBy: { select: { name: true } } } }),
    db.booking.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, include: { payments: { where: { status: "CAPTURED" } }, paymentLinks: true } }),
    getSettings(),
  ]);

  const latestQuote = [...quotes].reverse().find((q) => q.status !== "SUPERSEDED") ?? null;
  const pending = approvals.find((a) => a.status === "PENDING") ?? null;
  const dep = pending?.departure ?? latestQuote?.departure ?? conv.interestedDeparture ?? null;
  const pax = pending?.pax ?? latestQuote?.pax ?? conv.paxCount ?? null;

  // The customer's ask: the open request, else the latest request for this same deal.
  const sameDeal = (a: (typeof approvals)[number]) => dep && a.departureId === dep.id && a.pax === pax;
  const askSource = pending ?? [...approvals].reverse().find(sameDeal) ?? null;
  const asked = askSource?.requestedPricePerPax ?? null;

  let price: DealPanel["price"] = null;
  let meter: Meter | null = null;
  let owner: DealPanel["owner"] = null;
  if (dep && pax) {
    const { result } = await evaluateForDeparture(db, { departureId: dep.id, customerId: conv.customerId, pax, requestedPricePerPax: asked, now });
    const view = forRole(result, role);
    price = view;
    const offer = latestQuote && latestQuote.departureId === dep.id && latestQuote.pax === pax ? latestQuote.pricePerPax : result.autoOffer;
    meter = buildMeter({
      offer,
      asked,
      staffLimit: view.staffLimit,
      autoOffer: view.autoOffer,
      listPrice: view.listPrice,
      floor: view.role === "OWNER" ? view.floor : null,
    });
    if (role === "OWNER") owner = { costPerPax: result.costPerPax, floorMarginBps: settings.floorMarginBps, marginBpsAtOffer: marginBps(offer, result.costPerPax) };
  }

  let approval: ApprovalCard | null = null;
  if (pending) {
    let ownerPart: ApprovalCard["owner"] = null;
    if (role === "OWNER" && pending.departure && pending.suggestedPricePerPax != null) {
      const { result } = await evaluateForDeparture(db, { departureId: pending.departure.id, customerId: conv.customerId, pax: pending.pax ?? 1, now });
      ownerPart = {
        floor: result.floor,
        marginBpsAtSuggested: marginBps(pending.suggestedPricePerPax, result.costPerPax),
        floorMarginBps: settings.floorMarginBps,
        belowFloor: (pending.requestedPricePerPax ?? Infinity) < result.floor,
      };
    }
    approval = {
      id: pending.id,
      kind: pending.kind,
      customerFirst: conv.customer.name.split(/\s+/)[0] ?? conv.customer.name,
      pax: pending.pax,
      trip: pending.departure ? `${pending.departure.trip.name} ${formatDate(pending.departure.startDate)}` : null,
      requested: pending.requestedPricePerPax,
      suggested: pending.suggestedPricePerPax,
      counter: pending.suggestedPricePerPax != null ? pending.suggestedPricePerPax + 10_000 : null,
      createdAt: formatIST(pending.createdAt, "h:mm a"),
      owner: ownerPart,
    };
  }

  let quoteView: DealPanel["quote"] = null;
  if (latestQuote && (latestQuote.status === "SENT" || latestQuote.status === "ACCEPTED")) {
    const live = latestQuote.booking && latestQuote.booking.status !== "CANCELLED" ? latestQuote.booking : null;
    const link = !live ? "none" : live.paidAmount > 0 ? "paid" : live.paymentLinks.length ? "sent" : "none";
    quoteView = {
      id: latestQuote.id,
      pricePerPax: latestQuote.pricePerPax,
      totalAmount: latestQuote.totalAmount,
      pax: latestQuote.pax,
      validUntil: formatIST(latestQuote.validUntil, "d MMM, h:mm a"),
      valid: latestQuote.validUntil > now || !!live,
      advance: advanceAmount(latestQuote.totalAmount, settings.advancePctBps),
      link,
    };
  }

  const won = [...bookings].reverse().find((b) => b.status === "CONFIRMED" || b.status === "COMPLETED") ?? null;
  const result = won ? { code: won.code, dealValue: won.totalAmount, advanceReceived: won.paidAmount, status: won.status } : null;

  // ── timeline (replaces the demo's "What the AI did")
  const items: TimelineItem[] = [];
  const push = (at: Date, icon: string, text: string, sub: string | null = null) =>
    items.push({ at: formatIST(at, "d MMM, h:mm a"), icon, text, sub, ts: at.getTime() });
  for (const q of quotes) {
    const tag = q.status === "SUPERSEDED" ? "replaced by a newer quote" : q.status === "EXPIRED" ? "expired" : q.status === "ACCEPTED" ? "booked" : `valid till ${formatIST(q.validUntil, "d MMM, h:mm a")}`;
    push(q.createdAt, "🧾", `Quote sent · ${q.pax} × ${inr(q.pricePerPax)} = ${inr(q.totalAmount)}`, `${q.departure.code} · ${tag}`);
  }
  for (const a of approvals) {
    push(a.createdAt, "🤝", `Asked owner · ${a.pax ?? "?"} × ${a.requestedPricePerPax != null ? inr(a.requestedPricePerPax) : "–"}`, a.suggestedPricePerPax != null ? `suggested ${inr(a.suggestedPricePerPax)}` : null);
    if (a.decidedAt) {
      const verb = a.status === "APPROVED" ? "approved" : a.status === "COUNTERED" ? "countered" : a.status === "DECLINED" ? "declined" : a.status.toLowerCase();
      push(a.decidedAt, a.status === "DECLINED" ? "🙅" : "✅", `${a.decidedBy?.name ?? "Owner"} ${verb}${a.decidedPricePerPax != null ? ` ${inr(a.decidedPricePerPax)}` : ""}`);
    } else if (a.status === "EXPIRED") {
      push(a.expiresAt ?? a.createdAt, "⌛", "Approval request expired");
    }
  }
  for (const b of bookings) {
    for (const l of b.paymentLinks) push(l.createdAt, "💳", `Payment link ${inr(l.amount)} · ${b.code}`, l.status === "PAID" ? "paid" : l.status.toLowerCase());
    for (const p of b.payments) push(p.receivedAt, "💸", `${inr(p.amount)} received · ${b.code}`, p.method.replace(/_/g, " ").toLowerCase());
    if (b.status === "CANCELLED") push(b.cancelledAt ?? b.updatedAt, "🪑", `${b.code} released`, b.cancelReason);
  }
  items.sort((x, y) => x.ts - y.ts);

  return {
    role,
    basis: dep && pax ? { code: dep.code, label: `${dep.trip.name} · ${formatDate(dep.startDate)}`, pax } : null,
    price,
    meter,
    owner,
    staffCanGive: settings.soloDiscountPerPax > 0 ? `up to ${inr(settings.soloDiscountPerPax)}/person below the offer` : "approved offers only",
    approval,
    quote: quoteView,
    result,
    followUpDue: conv.status === "FOLLOW_UP",
    timeline: items,
  };
}

// ───────────────────────────── /approvals/[id] (OWNER) ─────────────────────────────

export async function getApprovalForOwner(id: string, now: Date = new Date()) {
  const a = await db.approval.findUnique({
    where: { id },
    include: {
      conversation: { include: { customer: { select: { name: true, phone: true } } } },
      departure: { include: { trip: true } },
      decidedBy: { select: { name: true } },
    },
  });
  if (!a) return null;
  const settings = await getSettings();
  let pricing: { listPrice: number; autoOffer: number; staffLimit: number; floor: number; costPerPax: number; marginBpsAtSuggested: number | null; marginBpsAtAsked: number | null } | null = null;
  if (a.departure && a.pax) {
    const { result } = await evaluateForDeparture(db, { departureId: a.departure.id, customerId: a.conversation?.customerId, pax: a.pax, now });
    pricing = {
      listPrice: result.listPrice,
      autoOffer: result.autoOffer,
      staffLimit: result.staffLimit,
      floor: result.floor,
      costPerPax: result.costPerPax,
      marginBpsAtSuggested: a.suggestedPricePerPax != null ? marginBps(a.suggestedPricePerPax, result.costPerPax) : null,
      marginBpsAtAsked: a.requestedPricePerPax != null ? marginBps(a.requestedPricePerPax, result.costPerPax) : null,
    };
  }
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    summary: a.summary,
    customer: a.conversation?.customer?.name ?? null,
    conversationId: a.conversationId,
    trip: a.departure ? `${a.departure.trip.title} · ${formatDate(a.departure.startDate)}` : null,
    pax: a.pax,
    requested: a.requestedPricePerPax,
    suggested: a.suggestedPricePerPax,
    counter: a.suggestedPricePerPax != null ? a.suggestedPricePerPax + 10_000 : null,
    decided: a.decidedAt ? { by: a.decidedBy?.name ?? "Owner", at: formatIST(a.decidedAt), price: a.decidedPricePerPax } : null,
    createdAt: formatIST(a.createdAt),
    floorMarginBps: settings.floorMarginBps,
    pricing,
  };
}
