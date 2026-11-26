/**
 * Deal desk (SRS DESK-1 … DESK-8, system design §6.1). Staff-operated in v1.
 *
 * Plain functions with no React/Next imports: v2's AI agent calls exactly these as tools. Each
 * takes an explicit actor and re-derives every price on the server through pricing.evaluatePrice
 * + canQuote. A price from the caller is only the requested input, never trusted.
 *
 * Responses are role-safe: floor, cost and margin reach the caller only through
 * pricing.forRole(…, "OWNER"), never for STAFF.
 */
import type { Approval, ApprovalKind, BookingSource, Channel, PaymentPurpose, Role } from "@prisma/client";
import { audit } from "../../audit";
import { send, windowOpen, type OutboundAuthor, type OutboundResult } from "../../channels/outbound";
import { channelEnabled, getAdapter } from "../../channels";
import { db, type Tx } from "../../db";
import { logger } from "../../logger";
import { inr, pct } from "../../money";
import { publish } from "../../pubsub";
import { enqueue, enqueueReplacingFinished } from "../../queue";
import { formatDate, formatIST, todayIST } from "../../time";
import { createBooking, evaluateForDeparture, PriceNotAllowed, TX_OPTS } from "../bookings";
import { DepartureNotBookable, SeatsUnavailable, seatsTaken } from "../inventory";
import { createLink } from "../payments";
import { advanceAmount } from "../payments/amounts";
import { canQuote, forRole, type CanQuoteReason, type OwnerPriceView, type PriceResult, type StaffPriceView } from "../pricing";
import { getSettings } from "../settings";

export type DealActor = { id: string; role: Role };

export type DealErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID"
  | "DEPARTURE_NOT_BOOKABLE"
  | "PRICE_NOT_ALLOWED"
  | "NO_APPROVAL_NEEDED"
  | "APPROVAL_NOT_PENDING"
  | "QUOTE_NOT_VALID"
  | "WINDOW_CLOSED"
  | "NOT_OPTED_IN"
  | "SEND_BLOCKED";

export class DealError extends Error {
  constructor(
    readonly code: DealErrorCode,
    message: string,
    readonly reason?: CanQuoteReason | string,
  ) {
    super(message);
    this.name = "DealError";
  }
}

const HOUR = 3_600_000;
const HUNDRED_RUPEES = 10_000;

// ───────────────────────────── loading ─────────────────────────────

async function loadConversation(client: Tx | typeof db, conversationId: string) {
  const c = await client.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { id: true, name: true, phone: true, marketingOptIn: true } } },
  });
  if (!c || !c.customer || c.supplierId) throw new DealError("NOT_FOUND", "Conversation not found");
  return { ...c, customer: c.customer };
}

/** A departure that can still be quoted: OPEN and not in the past. */
async function loadDeparture(client: Tx | typeof db, code: string, now: Date) {
  const d = await client.departure.findUnique({ where: { code }, include: { trip: { select: { name: true, title: true } } } });
  if (!d) throw new DealError("NOT_FOUND", `No departure ${code}`);
  if (d.status !== "OPEN" || d.startDate < todayIST(now)) {
    throw new DealError("DEPARTURE_NOT_BOOKABLE", `${d.code} isn't open for booking`);
  }
  return d;
}

function assertPax(pax: number) {
  if (!Number.isSafeInteger(pax) || pax < 1 || pax > 200) throw new DealError("INVALID", "Travellers must be 1–200");
}

function assertPrice(p: number | null | undefined, label: string) {
  if (p == null) return;
  if (!Number.isSafeInteger(p) || p <= 0) throw new DealError("INVALID", `${label} must be a positive amount`);
}

/** The owner's decision for exactly this conversation + departure + pax, if any (APPROVED / COUNTERED). */
async function ownerApproved(client: Tx | typeof db, m: { conversationId: string; departureId: string; pax: number }) {
  const a = await client.approval.findFirst({
    where: {
      conversationId: m.conversationId,
      departureId: m.departureId,
      pax: m.pax,
      status: { in: ["APPROVED", "COUNTERED"] },
      decidedPricePerPax: { not: null },
    },
    orderBy: { decidedAt: "desc" },
  });
  return a ? { approvalId: a.id, pricePerPax: a.decidedPricePerPax! } : null;
}

/** Engine's suggestion for an approval: the charm counter at/above the floor, else what was asked (capped at A). */
export function suggestedFor(result: PriceResult): number {
  const r = result.requestedPricePerPax;
  if (r === null) return result.autoOffer;
  if (r < result.floor) return result.suggestedCounter;
  return result.quotePricePerPax;
}

function approvalKindFor(result: PriceResult): ApprovalKind {
  if (result.isLargeGroup) return "LARGE_GROUP";
  return result.priceBand === "BELOW_FLOOR" ? "BELOW_FLOOR" : "PRICE";
}

function sourceFor(channel: Channel): BookingSource {
  // The sandbox simulates WhatsApp end to end (INB-3).
  if (channel === "INSTAGRAM") return "INSTAGRAM";
  return "WHATSAPP";
}

function firstName(name: string) {
  return name.split(/[\s&]/)[0] || name;
}

async function seatsLeft(client: Tx | typeof db, departureId: string, seatsTotal: number) {
  return Math.max(0, seatsTotal - (await seatsTaken(departureId, client)));
}

async function note(conversationId: string, body: string, author: OutboundAuthor) {
  await send(conversationId, { type: "note", body }, author);
}

async function activity(type: string, icon: string, text: string, entity: { type: string; id: string }, actorType: "USER" | "SYSTEM" | "CUSTOMER" = "USER") {
  const a = await db.activityEvent.create({ data: { type, icon, text, actorType, entityType: entity.type, entityId: entity.id } });
  await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
}

async function convUpdated(conversationId: string) {
  await publish({ type: "conversation.updated", payload: { conversationId } }).catch(() => undefined);
}

// ───────────────────────────── previewQuote (DESK-1) ─────────────────────────────

export type PreviewInput = { conversationId: string; code: string; pax: number; requestedPricePerPax?: number | null };

export type QuotePreview = {
  departure: { code: string; title: string; dateLabel: string; seatsLeft: number };
  price: StaffPriceView | OwnerPriceView;
  /** An owner decision for this exact deal, usable by staff as their floor. */
  approved: { approvalId: string; pricePerPax: number } | null;
  pendingApprovalId: string | null;
  /** Sending at the engine's price for this request, for this actor. */
  send: { pricePerPax: number; totalAmount: number; ok: boolean; reason: CanQuoteReason; needsConfirm: boolean };
  /** "Ask owner" (staff only), with the engine's suggested counter. */
  askOwner: { allowed: boolean; kind: ApprovalKind | null; suggestedPricePerPax: number | null };
  advanceAmount: number;
};

export async function previewQuote(input: PreviewInput, actor: DealActor, opts: { now?: Date } = {}): Promise<QuotePreview> {
  const now = opts.now ?? new Date();
  assertPax(input.pax);
  assertPrice(input.requestedPricePerPax, "Asked price");
  const conv = await loadConversation(db, input.conversationId);
  const dep = await loadDeparture(db, input.code, now);
  const { result } = await evaluateForDeparture(db, {
    departureId: dep.id,
    customerId: conv.customerId,
    pax: input.pax,
    requestedPricePerPax: input.requestedPricePerPax ?? null,
    now,
  });
  const [approved, pending, settings, left] = await Promise.all([
    ownerApproved(db, { conversationId: conv.id, departureId: dep.id, pax: input.pax }),
    db.approval.findFirst({ where: { conversationId: conv.id, status: "PENDING" }, select: { id: true } }),
    getSettings(),
    seatsLeft(db, dep.id, dep.seatsTotal),
  ]);

  // Staff holding an owner decision may send it even if the customer asked for less.
  let price = result.quotePricePerPax;
  if (actor.role !== "OWNER" && approved && price < approved.pricePerPax) price = approved.pricePerPax;
  const check = canQuote(result, price, actor.role, { approvedPrice: approved?.pricePerPax ?? null });
  const needsConfirm = check.reason === "BELOW_FLOOR_NEEDS_CONFIRMATION";
  const askAllowed = actor.role !== "OWNER" && !check.ok;

  return {
    departure: { code: dep.code, title: dep.trip.title, dateLabel: formatDate(dep.startDate), seatsLeft: left },
    price: forRole(result, actor.role),
    approved,
    pendingApprovalId: pending?.id ?? null,
    send: { pricePerPax: price, totalAmount: price * input.pax, ok: check.ok, reason: check.reason, needsConfirm },
    askOwner: {
      allowed: askAllowed,
      kind: askAllowed ? approvalKindFor(result) : null,
      suggestedPricePerPax: askAllowed ? suggestedFor(result) : null,
    },
    advanceAmount: advanceAmount(price * input.pax, settings.advancePctBps),
  };
}

// ───────────────────────────── sendQuote (DESK-1, DESK-2) ─────────────────────────────

export type SendQuoteInput = { conversationId: string; code: string; pax: number; pricePerPax: number; confirmBelowFloor?: boolean };

export type SentQuote = {
  quoteId: string;
  messageId: string;
  pricePerPax: number;
  totalAmount: number;
  validUntil: Date;
  reason: CanQuoteReason;
};

/**
 * Re-derives the price, checks it for this actor, supersedes older quotes, creates the Quote and
 * sends the quote card. Nothing is written when the price isn't allowed.
 */
export async function sendQuote(input: SendQuoteInput, actor: DealActor, opts: { now?: Date; ip?: string | null } = {}): Promise<SentQuote> {
  const now = opts.now ?? new Date();
  assertPax(input.pax);
  assertPrice(input.pricePerPax, "Price");
  const conv = await loadConversation(db, input.conversationId);
  if (!channelEnabled(conv.channel)) throw new DealError("SEND_BLOCKED", "This channel is switched off");
  if (!windowOpen(conv.lastInboundAt, now)) {
    throw new DealError("WINDOW_CLOSED", "The 24-hour window is closed: a quote can go out once the customer writes again.");
  }
  const dep = await loadDeparture(db, input.code, now);

  const created = await db.$transaction(async (tx) => {
    const { result } = await evaluateForDeparture(tx, {
      departureId: dep.id,
      customerId: conv.customerId,
      pax: input.pax,
      requestedPricePerPax: input.pricePerPax,
      now,
    });
    const approved = await ownerApproved(tx, { conversationId: conv.id, departureId: dep.id, pax: input.pax });
    // Never quote above the auto offer for this request (the engine's quotePricePerPax).
    const price = result.quotePricePerPax;
    const check = canQuote(result, price, actor.role, {
      approvedPrice: approved?.pricePerPax ?? null,
      // Only the owner may confirm below the floor (PRC-5); staff can't, whatever they send.
      confirmBelowFloor: actor.role === "OWNER" && input.confirmBelowFloor === true,
    });
    if (!check.ok) {
      throw new DealError("PRICE_NOT_ALLOWED", priceRefusal(check.reason, actor.role), check.reason);
    }
    const settings = await getSettings(tx);
    const left = await seatsLeft(tx, dep.id, dep.seatsTotal);
    const discounts = [
      ...result.appliedOffers.map((o) => ({ label: o.name, amountPerPax: o.amountPerPax })),
      ...(price < result.autoOffer ? [{ label: "Special price", amountPerPax: result.autoOffer - price }] : []),
    ];
    const validUntil = new Date(now.getTime() + settings.quoteValidityHours * HOUR);

    await tx.quote.updateMany({ where: { conversationId: conv.id, status: "SENT" }, data: { status: "SUPERSEDED" } });
    const quote = await tx.quote.create({
      data: {
        conversationId: conv.id,
        customerId: conv.customerId!,
        departureId: dep.id,
        pax: input.pax,
        listPricePerPax: result.listPrice,
        pricePerPax: price,
        discounts,
        totalAmount: price * input.pax,
        validUntil,
        status: "SENT",
        approvalId: check.reason === "OWNER_APPROVED" ? approved!.approvalId : null,
        createdBy: "OWNER", // Author.OWNER = any logged-in user (owner or staff)
        createdAt: now,
      },
    });
    if (check.audit) {
      await audit(
        {
          userId: actor.id,
          action: check.audit,
          entityType: "Quote",
          entityId: quote.id,
          after: { pricePerPax: price, pax: input.pax, departure: dep.code, reason: check.reason, role: actor.role },
          ip: opts.ip,
        },
        tx,
      );
    }
    await tx.conversation.update({
      where: { id: conv.id },
      data: { status: "QUOTED", interestedDepartureId: dep.id, paxCount: input.pax },
    });
    return { quote, discounts, left, reason: check.reason };
  }, TX_OPTS);

  const { quote, discounts, left } = created;
  const title = `${dep.trip.title} · ${formatDate(dep.startDate)}`;
  const validLabel = formatIST(quote.validUntil, "d MMM, h:mm a");
  const lines = [
    `🧾 *${title}* · ${quote.pax} traveller${quote.pax > 1 ? "s" : ""}`,
    `${inr(quote.listPricePerPax)} × ${quote.pax} = ${inr(quote.listPricePerPax * quote.pax)}`,
    ...discounts.map((d) => `${d.label}: −${inr(d.amountPerPax * quote.pax)}`),
    `*Total ${inr(quote.totalAmount)}*${discounts.length ? ` (${inr(quote.pricePerPax)} per person)` : ""}`,
    `${left <= 10 ? `Only ${left} seats left · ` : ""}Offer valid till ${validLabel}`,
  ];
  const r = await send(
    conv.id,
    { type: "text", body: lines.join("\n") },
    { userId: actor.id },
    {
      now,
      card: {
        kind: "QUOTE",
        payload: {
          quoteId: quote.id,
          departure: dep.code,
          title,
          pax: quote.pax,
          listPricePerPax: quote.listPricePerPax,
          discounts,
          pricePerPax: quote.pricePerPax,
          totalAmount: quote.totalAmount,
          seatsLeft: left,
          validUntil: validLabel,
        },
      },
    },
  );
  if (r.status === "BLOCKED") {
    await db.quote.update({ where: { id: quote.id }, data: { status: "EXPIRED" } });
    throw new DealError("SEND_BLOCKED", `The quote couldn't be sent (${r.reason})`, r.reason);
  }
  await convUpdated(conv.id);
  return { quoteId: quote.id, messageId: r.messageId, pricePerPax: quote.pricePerPax, totalAmount: quote.totalAmount, validUntil: quote.validUntil, reason: created.reason };
}

function priceRefusal(reason: CanQuoteReason, role: Role): string {
  switch (reason) {
    case "BELOW_STAFF_LIMIT":
      return "That's below what staff can give alone. Ask the owner.";
    case "BELOW_FLOOR":
      return "That's below the minimum price. Ask the owner.";
    case "LARGE_GROUP_NEEDS_APPROVAL":
      return "Large groups always need the owner's OK. Ask the owner.";
    case "BELOW_APPROVED_PRICE":
      return "That's below the price the owner approved.";
    case "BELOW_FLOOR_NEEDS_CONFIRMATION":
      return role === "OWNER" ? "That's below your floor. Confirm to send it anyway." : "That's below the minimum price.";
    default:
      return "That price isn't allowed.";
  }
}

// ───────────────────────────── askOwner (DESK-3) ─────────────────────────────

export type AskOwnerInput = { conversationId: string; code: string; pax: number; requestedPricePerPax?: number | null; note?: string | null };

export async function askOwner(
  input: AskOwnerInput,
  actor: DealActor,
  opts: { now?: Date } = {},
): Promise<{ approvalId: string; kind: ApprovalKind; suggestedPricePerPax: number }> {
  const now = opts.now ?? new Date();
  if (actor.role === "OWNER") throw new DealError("FORBIDDEN", "You're the owner: send the quote directly.");
  assertPax(input.pax);
  assertPrice(input.requestedPricePerPax, "Asked price");
  const conv = await loadConversation(db, input.conversationId);
  const dep = await loadDeparture(db, input.code, now);

  const approval = await db.$transaction(async (tx) => {
    const { result } = await evaluateForDeparture(tx, {
      departureId: dep.id,
      customerId: conv.customerId,
      pax: input.pax,
      requestedPricePerPax: input.requestedPricePerPax ?? null,
      now,
    });
    const approved = await ownerApproved(tx, { conversationId: conv.id, departureId: dep.id, pax: input.pax });
    const own = canQuote(result, result.quotePricePerPax, actor.role, { approvedPrice: approved?.pricePerPax ?? null });
    if (own.ok) throw new DealError("NO_APPROVAL_NEEDED", "No approval needed: you can send this price yourself.");

    const settings = await getSettings(tx);
    const kind = approvalKindFor(result);
    const suggested = suggestedFor(result); // from the engine, never from the caller
    const requested = result.requestedPricePerPax ?? result.quotePricePerPax;
    // One open request per conversation: a newer ask replaces the older one.
    await tx.approval.updateMany({ where: { conversationId: conv.id, status: "PENDING" }, data: { status: "EXPIRED" } });
    const extra = input.note?.trim() ? ` · Note: ${input.note.trim().slice(0, 300)}` : "";
    return tx.approval.create({
      data: {
        kind,
        conversationId: conv.id,
        departureId: dep.id,
        pax: input.pax,
        requestedPricePerPax: requested,
        suggestedPricePerPax: suggested,
        summary: `${conv.customer.name} asks ${inr(requested)} per person for ${input.pax} on ${dep.trip.name} ${formatDate(dep.startDate)}${kind === "LARGE_GROUP" ? " (large group)" : ""}${extra}`,
        expiresAt: new Date(now.getTime() + settings.quoteValidityHours * HOUR),
        createdAt: now,
      },
    });
  }, TX_OPTS);

  await db.conversation.update({
    where: { id: conv.id },
    data: { status: "AWAITING_OWNER", interestedDepartureId: dep.id, paxCount: input.pax },
  });
  await note(conv.id, `🔔 Sent to owner for approval: ${input.pax} × ${inr(approval.requestedPricePerPax!)} asked`, { userId: actor.id });
  await afterApprovalCreated(approval, conv.customer.name, now);
  return { approvalId: approval.id, kind: approval.kind, suggestedPricePerPax: approval.suggestedPricePerPax! };
}

async function afterApprovalCreated(approval: Approval, customerName: string, now: Date) {
  const steps: [string, () => Promise<unknown>][] = [
    [
      "expire",
      () =>
        enqueue(
          "approval.expire",
          { approvalId: approval.id },
          { jobId: `approval-expire-${approval.id}`, delay: Math.max(0, (approval.expiresAt?.getTime() ?? now.getTime()) - now.getTime()) },
        ),
    ],
    // Best-effort WhatsApp alert to the owner's phone (DESK-3 "S"); in-app alerts don't depend on it.
    ["notify", () => enqueue("notify.owner", { approvalId: approval.id }, { jobId: `notify-owner-${approval.id}` })],
    ["sse", () => publish({ type: "approval.created", payload: { approvalId: approval.id } })],
    [
      "toast",
      () => publish({ type: "toast", payload: { text: `Owner approval needed: ${customerName} (${approval.pax ?? "?"} pax)`, icon: "🤝", audience: "OWNER" } }),
    ],
    ["conv", () => convUpdated(approval.conversationId!)],
    ["activity", () => activity("approval.requested", "🤝", `Approval requested: ${approval.summary}`, { type: "Approval", id: approval.id })],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      logger.error({ err, step: name, approvalId: approval.id }, "approval alert step failed");
    }
  }
}

// ───────────────────────────── decideApproval (DESK-4) ─────────────────────────────

export type DecideInput = {
  approvalId: string;
  action: "APPROVE" | "COUNTER" | "DECLINE";
  /** COUNTER only: a custom price. Default: suggested + ₹100. */
  pricePerPax?: number | null;
  confirmBelowFloor?: boolean;
  reason?: string | null;
};

export type DecideResult =
  | { status: "APPROVED" | "COUNTERED"; pricePerPax: number; quote: SentQuote | null; sendError: string | null }
  | { status: "DECLINED" };

export async function decideApproval(input: DecideInput, actor: DealActor, opts: { now?: Date; ip?: string | null } = {}): Promise<DecideResult> {
  const now = opts.now ?? new Date();
  if (actor.role !== "OWNER") throw new DealError("FORBIDDEN", "Only the owner can decide approvals");
  assertPrice(input.pricePerPax, "Counter price");
  const a = await db.approval.findUnique({ where: { id: input.approvalId }, include: { departure: true, conversation: { include: { customer: true } } } });
  if (!a) throw new DealError("NOT_FOUND", "Approval not found");
  if (a.status !== "PENDING") throw new DealError("APPROVAL_NOT_PENDING", `This request is already ${a.status.toLowerCase()}`);

  if (input.action === "DECLINE") {
    const reason = input.reason?.trim().slice(0, 300) || null;
    await db.$transaction(async (tx) => {
      const n = await tx.approval.updateMany({
        where: { id: a.id, status: "PENDING" },
        data: { status: "DECLINED", decidedById: actor.id, decidedAt: now },
      });
      if (n.count === 0) throw new DealError("APPROVAL_NOT_PENDING", "This request was already decided");
      await audit({ userId: actor.id, action: "approval.decline", entityType: "Approval", entityId: a.id, after: { reason }, ip: opts.ip }, tx);
      if (a.conversationId) await tx.conversation.update({ where: { id: a.conversationId }, data: { status: "NEGOTIATING" } });
    }, TX_OPTS);
    if (a.conversationId) {
      let hold = "";
      if (a.departureId && a.pax) {
        const { result } = await evaluateForDeparture(db, { departureId: a.departureId, customerId: a.conversation?.customerId, pax: a.pax, now });
        hold = ` Hold at ${inr(result.staffLimit)} per person.`;
      }
      await note(
        a.conversationId,
        `🙅 Owner declined ${a.requestedPricePerPax != null ? inr(a.requestedPricePerPax) : "the request"}${reason ? `: “${reason}”` : "."}${hold}`,
        { userId: actor.id },
      );
    }
    await afterDecision(a.id, a.conversationId, `Owner declined ${a.conversation?.customer?.name ?? "the request"}`, "🙅");
    return { status: "DECLINED" };
  }

  if (!a.departureId || !a.pax || !a.conversationId || !a.departure) {
    throw new DealError("INVALID", "This request has no trip to quote: decline it or reply in the chat");
  }
  const suggested = a.suggestedPricePerPax ?? a.requestedPricePerPax;
  if (suggested == null) throw new DealError("INVALID", "No suggested price on this request");
  const price = input.action === "APPROVE" ? suggested : (input.pricePerPax ?? suggested + HUNDRED_RUPEES);
  const status = input.action === "APPROVE" && input.pricePerPax == null ? "APPROVED" : "COUNTERED";

  // Re-check the owner's own price (PRC-5): below the floor needs the second confirmation.
  const { result } = await evaluateForDeparture(db, { departureId: a.departureId, customerId: a.conversation?.customerId, pax: a.pax, requestedPricePerPax: price, now });
  const check = canQuote(result, price, "OWNER", { confirmBelowFloor: input.confirmBelowFloor === true });
  if (!check.ok) throw new DealError("PRICE_NOT_ALLOWED", priceRefusal(check.reason, "OWNER"), check.reason);

  await db.$transaction(async (tx) => {
    const n = await tx.approval.updateMany({
      where: { id: a.id, status: "PENDING" },
      data: { status, decidedPricePerPax: price, decidedById: actor.id, decidedAt: now },
    });
    if (n.count === 0) throw new DealError("APPROVAL_NOT_PENDING", "This request was already decided");
    await audit(
      {
        userId: actor.id,
        action: status === "APPROVED" ? "approval.approve" : "approval.counter",
        entityType: "Approval",
        entityId: a.id,
        before: { requestedPricePerPax: a.requestedPricePerPax, suggestedPricePerPax: a.suggestedPricePerPax },
        after: { decidedPricePerPax: price, belowFloor: check.reason === "OWNER_BELOW_FLOOR_CONFIRMED" },
        ip: opts.ip,
      },
      tx,
    );
  }, TX_OPTS);

  await note(a.conversationId, `✅ Owner ${status === "APPROVED" ? "approved" : "countered at"} ${inr(price)} per person · 1 tap`, { userId: actor.id });

  // DESK-4: the approved quote card goes to the customer automatically, as the owner.
  let quote: SentQuote | null = null;
  let sendError: string | null = null;
  try {
    quote = await sendQuote(
      { conversationId: a.conversationId, code: a.departure.code, pax: a.pax, pricePerPax: price, confirmBelowFloor: input.confirmBelowFloor },
      actor,
      { now, ip: opts.ip },
    );
    await db.quote.update({ where: { id: quote.quoteId }, data: { approvalId: a.id } });
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    logger.warn({ approvalId: a.id, err: sendError }, "approved quote not sent");
    await note(a.conversationId, `⚠ The approved quote wasn't sent: ${sendError}`, "SYSTEM");
  }
  await afterDecision(a.id, a.conversationId, `Owner ${status === "APPROVED" ? "approved" : "countered"} ${inr(price)} for ${a.conversation?.customer?.name ?? "the customer"}`, "✅");
  return { status, pricePerPax: price, quote, sendError };
}

async function afterDecision(approvalId: string, conversationId: string | null, text: string, icon: string) {
  await publish({ type: "approval.decided", payload: { approvalId } }).catch(() => undefined);
  await publish({ type: "toast", payload: { text, icon, audience: "STAFF" } }).catch(() => undefined);
  if (conversationId) await convUpdated(conversationId);
}

/** approval.expire job: a request nobody decided before the quote validity lapses. */
export async function expireApproval(approvalId: string, now: Date = new Date()): Promise<"expired" | "skipped"> {
  const a = await db.approval.findUnique({ where: { id: approvalId } });
  if (!a || a.status !== "PENDING" || (a.expiresAt && a.expiresAt > now)) return "skipped";
  const n = await db.approval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "EXPIRED" } });
  if (n.count === 0) return "skipped";
  if (a.conversationId) {
    await db.conversation.updateMany({ where: { id: a.conversationId, status: "AWAITING_OWNER" }, data: { status: "NEGOTIATING" } });
    await note(a.conversationId, "⌛ The owner approval request expired without a decision", "SYSTEM");
    await convUpdated(a.conversationId);
  }
  await publish({ type: "approval.decided", payload: { approvalId } }).catch(() => undefined);
  return "expired";
}

// ───────────────────────────── sendPaymentLink (DESK-5) ─────────────────────────────

export async function sendPaymentLink(
  input: { quoteId: string; purpose?: Extract<PaymentPurpose, "ADVANCE" | "FULL"> },
  actor: DealActor,
  opts: { now?: Date } = {},
): Promise<{ queued: true; jobId: string }> {
  const now = opts.now ?? new Date();
  const purpose = input.purpose ?? "ADVANCE";
  const quote = await db.quote.findUnique({ where: { id: input.quoteId }, include: { conversation: true, booking: true } });
  if (!quote || !quote.conversation) throw new DealError("NOT_FOUND", "Quote not found");
  await loadConversation(db, quote.conversation.id);
  if (quote.status !== "SENT" && quote.status !== "ACCEPTED") {
    throw new DealError("QUOTE_NOT_VALID", `This quote is ${quote.status.toLowerCase()}. Send a fresh quote first.`);
  }
  if (quote.validUntil <= now && !(quote.booking && quote.booking.status !== "CANCELLED")) {
    throw new DealError("QUOTE_NOT_VALID", `This quote expired on ${formatIST(quote.validUntil)}. Send a fresh quote first.`);
  }
  if (!windowOpen(quote.conversation.lastInboundAt, now)) {
    throw new DealError("WINDOW_CLOSED", "The 24-hour window is closed: send the link once the customer writes again.");
  }
  const jobId = `quote-link-${quote.id}-${purpose}`;
  // The worker holds seats, creates the booking and calls Razorpay (never inside a request).
  await enqueueReplacingFinished("payment.createLink", { quoteId: quote.id, purpose, requestedById: actor.id }, jobId);
  return { queued: true, jobId };
}

export type QuoteLinkOutcome =
  | { status: "sent" | "not_sent"; bookingId: string; bookingCode: string; amount: number; shortUrl: string }
  | { status: "seats_unavailable" | "not_bookable" | "price_not_allowed" | "quote_not_valid"; detail: string };

/**
 * payment.createLink job body for a quote: hold seats in a transaction → Booking HELD (linked to the
 * quote and conversation) → Razorpay link → payment-link card. Idempotent: a quote has at most one
 * booking (Booking.quoteId unique) and open links are reused.
 */
export async function createQuoteLink(data: { quoteId: string; purpose: PaymentPurpose; requestedById: string }, opts: { now?: Date } = {}): Promise<QuoteLinkOutcome> {
  const now = opts.now ?? new Date();

  const quote = await db.quote.findUniqueOrThrow({
    where: { id: data.quoteId },
    include: { conversation: true, booking: true, customer: true, departure: { include: { trip: true } } },
  });
  const conv = quote.conversation!;
  const requester = await db.user.findUniqueOrThrow({ where: { id: data.requestedById }, select: { id: true, role: true } });
  const fail = async (status: Exclude<QuoteLinkOutcome["status"], "sent" | "not_sent">, detail: string) => {
    await note(conv.id, `⚠ ${detail}`, "SYSTEM");
    await publish({ type: "toast", payload: { text: detail, icon: "⚠️" } }).catch(() => undefined);
    await convUpdated(conv.id);
    return { status, detail } as const;
  };

  let booking = quote.booking;
  if (booking && booking.status === "CANCELLED") {
    return fail("quote_not_valid", `The seat hold for ${booking.code} has lapsed. Send a fresh quote.`);
  }
  if (!booking) {
    if (quote.status !== "SENT" || quote.validUntil <= now) return fail("quote_not_valid", "This quote is no longer valid. Send a fresh quote.");
    // The quote was authorised when it was sent. If the OWNER authorised a price below the staff
    // limit (audit row on the quote), the hold re-validates with the owner's authority.
    const ownerAuthorised = await db.auditLog.findFirst({
      where: { entityType: "Quote", entityId: quote.id, action: { in: ["quote.below_limit", "quote.below_floor"] }, user: { role: "OWNER" } },
      select: { action: true },
    });
    try {
      ({ booking } = await createBooking(
        {
          customerId: quote.customerId,
          departureId: quote.departureId,
          pax: quote.pax,
          pricePerPax: quote.pricePerPax,
          source: sourceFor(conv.channel),
          conversationId: conv.id,
          quoteId: quote.id,
          approvalId: quote.approvalId ?? undefined,
          confirmBelowFloor: ownerAuthorised?.action === "quote.below_floor",
        },
        { id: requester.id, role: ownerAuthorised ? "OWNER" : requester.role },
        { now },
      ));
    } catch (err) {
      if (err instanceof SeatsUnavailable) {
        return fail("seats_unavailable", `Seats unavailable: only ${err.available} left on ${quote.departure.code}, ${quote.pax} needed. Nothing was held.`);
      }
      if (err instanceof DepartureNotBookable) return fail("not_bookable", `${quote.departure.code} isn't open for booking any more.`);
      if (err instanceof PriceNotAllowed) return fail("price_not_allowed", "This quote's price is no longer allowed under the current rules. Send a fresh quote.");
      throw err;
    }
    await db.quote.update({ where: { id: quote.id }, data: { status: "ACCEPTED" } });
  }

  const link = await createLink(booking.id, data.purpose, { now });
  const settings = await getSettings();
  const balance = booking.totalAmount - link.amount;
  const what = `${quote.departure.trip.name} ${formatDate(quote.departure.startDate)}`;
  const body = [
    `Here's your secure payment link 🔒`,
    data.purpose === "ADVANCE"
      ? `Pay ${inr(link.amount)} (${pct(settings.advancePctBps, 0)} advance) to lock ${booking.pax} seat${booking.pax > 1 ? "s" : ""} on ${what}.`
      : `Pay ${inr(link.amount)} for ${booking.pax} seat${booking.pax > 1 ? "s" : ""} on ${what}.`,
    balance > 0 && booking.balanceDueDate ? `Balance ${inr(balance)} is due by ${formatDate(booking.balanceDueDate)}.` : null,
    booking.holdExpiresAt ? `Seats are held till ${formatIST(booking.holdExpiresAt)}.` : null,
    `Booking ${booking.code}`,
  ]
    .filter(Boolean)
    .join("\n");
  const r: OutboundResult = await send(
    conv.id,
    { type: "cta", body, button: { label: `Pay ${inr(link.amount)}`, url: link.shortUrl } },
    { userId: requester.id },
    {
      now,
      card: { kind: "PAYMENT_LINK", payload: { amount: link.amount, url: link.shortUrl, label: "Pay securely", bookingId: booking.id, bookingCode: booking.code, quoteId: quote.id, linkId: link.linkId } },
      meta: { bookingId: booking.id },
    },
  );
  if (r.status === "BLOCKED") {
    await note(conv.id, `⚠ Link ${inr(link.amount)} for ${booking.code} is ready but wasn't sent (${r.reason}): ${link.shortUrl}`, "SYSTEM");
  } else {
    await db.conversation.update({ where: { id: conv.id }, data: { status: "PAYMENT_PENDING" } });
    await activity(
      "payment_link.sent",
      "💳",
      `${data.purpose === "ADVANCE" ? "Advance" : "Payment"} link ${inr(link.amount)} sent to ${quote.customer.name} · ${booking.code} (${booking.pax} seats held)`,
      { type: "Booking", id: booking.id },
    );
  }
  await publish({ type: "booking.updated", payload: { bookingId: booking.id } }).catch(() => undefined);
  await convUpdated(conv.id);
  return { status: r.status === "BLOCKED" ? "not_sent" : "sent", bookingId: booking.id, bookingCode: booking.code, amount: link.amount, shortUrl: link.shortUrl };
}

// ───────────────────────────── follow-ups (DESK-7) ─────────────────────────────

export const FOLLOW_UP_AFTER_HOURS = 20;

/**
 * followups.scan (hourly): a SENT quote with no inbound since it went out and nothing sent for
 * 20h → "Follow-up due". Also expires quotes past their validity. No automatic sends in v1.
 */
export async function scanFollowUps(now: Date = new Date()): Promise<{ flagged: number; expiredQuotes: number }> {
  const cutoff = new Date(now.getTime() - FOLLOW_UP_AFTER_HOURS * HOUR);
  const due = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id FROM "Conversation" c
    JOIN "Quote" q ON q."conversationId" = c.id AND q.status = 'SENT'
    WHERE c.status = 'QUOTED' AND q."createdAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = c.id AND m.direction = 'INBOUND' AND m."createdAt" > q."createdAt")
      AND NOT EXISTS (
        SELECT 1 FROM "Message" m WHERE m."conversationId" = c.id AND m.direction = 'OUTBOUND'
          AND m.kind <> 'SYSTEM_NOTE' AND m.status NOT IN ('BLOCKED', 'FAILED') AND m."createdAt" > ${cutoff}
      )`;
  let flagged = 0;
  for (const { id } of due) {
    const n = await db.conversation.updateMany({ where: { id, status: "QUOTED" }, data: { status: "FOLLOW_UP" } });
    if (n.count) {
      flagged += 1;
      await convUpdated(id);
    }
  }
  const expired = await db.quote.updateMany({ where: { status: "SENT", validUntil: { lt: now } }, data: { status: "EXPIRED" } });
  return { flagged, expiredQuotes: expired.count };
}

export async function sendFollowUp(input: { conversationId: string }, actor: DealActor, opts: { now?: Date } = {}): Promise<{ messageId: string; via: "text" | "template" }> {
  const now = opts.now ?? new Date();
  const conv = await loadConversation(db, input.conversationId);
  const quote = await db.quote.findFirst({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
    include: { departure: { include: { trip: true } } },
  });
  const dep = quote?.departure ?? (conv.interestedDepartureId ? await db.departure.findUnique({ where: { id: conv.interestedDepartureId }, include: { trip: true } }) : null);
  const pax = quote?.pax ?? conv.paxCount;
  const trip = dep ? `${dep.trip.name} ${formatDate(dep.startDate)}` : "trip";
  const name = firstName(conv.customer.name);

  let r: OutboundResult;
  let via: "text" | "template";
  if (windowOpen(conv.lastInboundAt, now)) {
    via = "text";
    const left = dep ? await seatsLeft(db, dep.id, dep.seatsTotal) : null;
    const body = `Hi ${name}! Just checking in on the ${trip} plan 🙂${left != null && left <= 10 ? ` Only ${left} seats are left.` : ""} Shall I hold ${pax ? `${pax} seats` : "seats"} for you?`;
    r = await send(conv.id, { type: "text", body }, { userId: actor.id }, { now });
  } else {
    via = "template";
    // follow_up is a MARKETING template: outbound refuses it unless the customer opted in.
    r = await send(conv.id, { type: "template", name: "follow_up", vars: { name, trip, pax: String(pax ?? "") } }, { userId: actor.id }, { now });
  }
  if (r.status === "BLOCKED") {
    if (r.reason === "NOT_OPTED_IN") {
      throw new DealError("NOT_OPTED_IN", "The 24-hour window is closed and this customer hasn't opted in to follow-ups. Wait for them to write.");
    }
    if (r.reason === "NO_TEMPLATES_ON_CHANNEL") {
      throw new DealError("WINDOW_CLOSED", "Instagram allows no templates: you can follow up once the customer writes again.");
    }
    throw new DealError("SEND_BLOCKED", `Follow-up not sent (${r.reason})`, r.reason);
  }
  await db.conversation.updateMany({ where: { id: conv.id, status: "FOLLOW_UP" }, data: { status: "QUOTED" } });
  await convUpdated(conv.id);
  return { messageId: r.messageId, via };
}

// ───────────────────────────── owner WhatsApp alert (DESK-3, S) ─────────────────────────────

/** notify.owner job: `owner_approval` template to every active owner with a phone. Best-effort. */
export async function notifyOwnersOfApproval(approvalId: string, appUrl: string): Promise<{ sent: number; skipped: string | null }> {
  const a = await db.approval.findUnique({
    where: { id: approvalId },
    include: { conversation: { include: { customer: true } }, departure: { include: { trip: true } } },
  });
  if (!a || a.status !== "PENDING") return { sent: 0, skipped: "not pending" };
  const template = await db.messageTemplate.findUnique({ where: { name: "owner_approval" } });
  if (!template || template.metaStatus !== "APPROVED") return { sent: 0, skipped: "owner_approval template not approved" };
  const owners = await db.user.findMany({ where: { role: "OWNER", active: true, phone: { not: null } }, select: { id: true, phone: true } });
  if (!owners.length) return { sent: 0, skipped: "no owner phone" };
  const vars: Record<string, string> = {
    customer: a.conversation?.customer?.name ?? "A customer",
    pax: String(a.pax ?? "?"),
    trip: a.departure ? `${a.departure.trip.name} ${formatDate(a.departure.startDate)}` : "custom trip",
    asked: a.requestedPricePerPax != null ? inr(a.requestedPricePerPax) : "–",
    suggested: a.suggestedPricePerPax != null ? inr(a.suggestedPricePerPax) : "–",
    link: `${appUrl.replace(/\/$/, "")}/approvals/${a.id}`,
  };
  const adapter = getAdapter("WHATSAPP");
  let sent = 0;
  for (const o of owners) {
    await adapter.sendTemplate(o.phone!, template.name, template.language, template.variables.map((v) => vars[v] ?? ""));
    sent += 1;
  }
  logger.info({ approvalId, sent }, "owner approval alert sent");
  return { sent, skipped: null };
}

