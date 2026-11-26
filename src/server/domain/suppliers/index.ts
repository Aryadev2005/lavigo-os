/**
 * Supplier desk (SUP-1 … SUP-8, DFD Level 2 — 6.0). Plain functions: the pages' server actions
 * and the worker jobs call them. Money in paise. No LLM: replies go through the rule-based parser.
 *
 *   6.1 createRfq          compose, prefill baseline
 *   6.2 sendToRecipient    rfq.send job: WhatsApp `rfq_request` template or SMTP email
 *   6.3 handleSupplierReply rfq.parseReply job: match the latest SENT RFQ for that supplier
 *   6.4 parseSupplierReply (./parser), confirmQuote, addQuote
 *   6.5 compare (./compare, ./queries)
 *   6.6 bookQuote          BOOKED / REJECTED, HOTEL expense, confirmation, activity
 *   6.7 scanNudges         rfq.nudge cron: one nudge after 2h, NO_REPLY after 24h
 */
import type { ContactChannel, MealPlan, RoomCategory, SupplierType } from "@prisma/client";
import { audit } from "../../audit";
import { renderTemplate, send, sendTemplate, windowOpen } from "../../channels/outbound";
import { db } from "../../db";
import { sendMail } from "../../email/smtp";
import { logger } from "../../logger";
import { inr } from "../../money";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import { addDays, dateOnly, formatDate } from "../../time";
import { bookableTotal, HIGH_CONFIDENCE_BPS } from "./compare";
import { confidenceBps, parseSupplierReply } from "./parser";
import { CATEGORY_LABEL, MEAL_PLAN_LABEL, SupplierError, type Actor } from "./common";

export { CATEGORY_LABEL, MEAL_PLAN_LABEL, SupplierError, destinationMatches, type Actor } from "./common";

export const HOUR = 3_600_000;
export const NUDGE_AFTER_MS = 2 * HOUR;
export const NO_REPLY_AFTER_MS = 24 * HOUR;

async function activity(icon: string, text: string, type: string, entityId: string, actorType: "USER" | "SYSTEM" | "SUPPLIER" = "USER") {
  const a = await db.activityEvent.create({ data: { type, icon, text, actorType, entityType: "Rfq", entityId } });
  await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
}

const rfqUpdated = (rfqId: string) => publish({ type: "rfq.updated", payload: { rfqId } }).catch(() => undefined);

// ───────────────────────────── 6.0 directory (SUP-1) ─────────────────────────────

export type SupplierInput = {
  name: string;
  type: SupplierType;
  destinations: string[];
  contactName?: string | null;
  phone?: string | null; // E.164, already normalised
  email?: string | null;
  preferredChannel: ContactChannel;
  active?: boolean;
  notes?: string | null;
};

export async function saveSupplier(id: string | null, input: SupplierInput, actor: Actor) {
  if (input.preferredChannel === "WHATSAPP" && !input.phone) throw new SupplierError("NO_CONTACT", "Add a WhatsApp number, or choose email");
  if (input.preferredChannel === "EMAIL" && !input.email) throw new SupplierError("NO_CONTACT", "Add an email address, or choose WhatsApp");
  if (input.phone) {
    const clash = await db.supplier.findUnique({ where: { phone: input.phone }, select: { id: true } });
    if (clash && clash.id !== id) throw new SupplierError("INVALID", "Another supplier already has this WhatsApp number");
    const customer = await db.customer.findUnique({ where: { phone: input.phone }, select: { id: true } });
    if (customer) logger.info({ supplierPhoneIsCustomer: true }, "supplier phone also belongs to a customer; replies route to the supplier desk");
  }
  const data = {
    name: input.name,
    type: input.type,
    destinations: [...new Set(input.destinations.map((d) => d.trim()).filter(Boolean))],
    contactName: input.contactName || null,
    phone: input.phone || null,
    email: input.email || null,
    preferredChannel: input.preferredChannel,
    active: input.active ?? true,
    notes: input.notes || null,
  };
  const row = id ? await db.supplier.update({ where: { id }, data }) : await db.supplier.create({ data });
  await audit({ userId: actor.id, action: id ? "supplier.update" : "supplier.create", entityType: "Supplier", entityId: row.id });
  return row;
}

// ───────────────────────────── 6.1 compose (SUP-2) ─────────────────────────────

/** "Your usual rate here": the departure's usualRoomRate, else the last BOOKED quote for destination + category. */
export async function baselineFor(input: { destination: string; category: RoomCategory; departureId?: string | null }): Promise<number | null> {
  if (input.departureId) {
    const dep = await db.departure.findUnique({ where: { id: input.departureId }, select: { usualRoomRate: true } });
    if (dep?.usualRoomRate) return dep.usualRoomRate;
  }
  const last = await db.supplierQuote.findFirst({
    where: { status: "BOOKED", recipient: { rfq: { destination: input.destination, category: input.category } } },
    orderBy: { bookedAt: "desc" },
    select: { ratePerRoomNight: true },
  });
  return last?.ratePerRoomNight ?? null;
}

export type CreateRfqInput = {
  destination: string;
  departureId?: string | null;
  checkIn: string; // YYYY-MM-DD (IST calendar date)
  nights: number;
  rooms: number;
  category: RoomCategory;
  mealPlan: MealPlan;
  /** Paise. null → none. Staff may edit the prefilled value. */
  baselineRatePerRoomNight: number | null;
  supplierIds: string[];
  notes?: string | null;
};

export async function createRfq(input: CreateRfqInput, actor: Actor) {
  if (!input.supplierIds.length) throw new SupplierError("INVALID", "Choose at least one supplier");
  const suppliers = await db.supplier.findMany({ where: { id: { in: input.supplierIds }, active: true } });
  if (suppliers.length !== new Set(input.supplierIds).size) throw new SupplierError("NOT_FOUND", "A chosen supplier no longer exists or is inactive");
  const channelOf = (s: (typeof suppliers)[number]): ContactChannel | null =>
    s.preferredChannel === "WHATSAPP" ? (s.phone ? "WHATSAPP" : s.email ? "EMAIL" : null) : s.email ? "EMAIL" : s.phone ? "WHATSAPP" : null;
  const noContact = suppliers.filter((s) => !channelOf(s));
  if (noContact.length) throw new SupplierError("NO_CONTACT", `${noContact.map((s) => s.name).join(", ")} has no phone or email`);
  if (input.departureId) {
    const dep = await db.departure.findUnique({ where: { id: input.departureId }, select: { id: true } });
    if (!dep) throw new SupplierError("NOT_FOUND", "Departure not found");
  }

  const now = new Date();
  const rfq = await db.rfq.create({
    data: {
      destination: input.destination,
      departureId: input.departureId || null,
      checkIn: dateOnly(input.checkIn),
      nights: input.nights,
      rooms: input.rooms,
      category: input.category,
      mealPlan: input.mealPlan,
      baselineRatePerRoomNight: input.baselineRatePerRoomNight,
      status: "SENT",
      sentAt: now,
      notes: input.notes || null,
      createdById: actor.id,
      recipients: { create: suppliers.map((s) => ({ supplierId: s.id, channel: channelOf(s)!, status: "QUEUED" as const })) },
    },
    include: { recipients: true },
  });
  for (const r of rfq.recipients) await enqueue("rfq.send", { recipientId: r.id, kind: "request" }, { jobId: `rfq-send-${r.id}` });
  await audit({ userId: actor.id, action: "rfq.create", entityType: "Rfq", entityId: rfq.id, after: { recipients: rfq.recipients.length } });
  await activity("📨", `Rate request sent to ${rfq.recipients.length} supplier${rfq.recipients.length === 1 ? "" : "s"} for ${rfq.destination}, ${formatDate(rfq.checkIn)}`, "rfq.sent", rfq.id);
  await rfqUpdated(rfq.id);
  return rfq;
}

// ───────────────────────────── 6.2 fan-out (SUP-3) ─────────────────────────────

function requestVars(rfq: { rooms: number; category: RoomCategory; mealPlan: MealPlan; destination: string; checkIn: Date; nights: number }, supplier: { name: string; contactName: string | null }) {
  return {
    supplier: supplier.contactName || supplier.name,
    rooms: String(rfq.rooms),
    category: CATEGORY_LABEL[rfq.category],
    meal_plan: MEAL_PLAN_LABEL[rfq.mealPlan],
    destination: rfq.destination,
    check_in: formatDate(rfq.checkIn, "d MMM yyyy"),
    nights: String(rfq.nights),
  };
}

/** The supplier's WhatsApp thread (the same one inbound replies land in, INB-4). */
async function supplierConversation(supplier: { id: string; phone: string | null }) {
  if (!supplier.phone) return null;
  const conv = await db.conversation.upsert({
    where: { channel_externalThreadId: { channel: "WHATSAPP", externalThreadId: supplier.phone } },
    update: {},
    create: { channel: "WHATSAPP", externalThreadId: supplier.phone, supplierId: supplier.id, status: "ACTIVE" },
  });
  if (!conv.supplierId) await db.conversation.update({ where: { id: conv.id }, data: { supplierId: supplier.id } });
  return conv;
}

export type SendKind = "request" | "nudge" | "confirm";

/** rfq.send job. Idempotent per kind: a request only from QUEUED, a nudge only once. */
export async function sendToRecipient(recipientId: string, kind: SendKind = "request", quoteId?: string): Promise<string> {
  const r = await db.rfqRecipient.findUnique({ where: { id: recipientId }, include: { rfq: true, supplier: true } });
  if (!r) return "missing";
  if (kind === "request" && r.status !== "QUEUED") return "already sent";
  if (kind === "nudge" && (r.status !== "SENT" || r.nudgedAt)) return "not nudgeable";

  const vars = requestVars(r.rfq, r.supplier);
  let ok = false;
  let messageId: string | null = null;
  let error: string | null = null;

  if (kind === "confirm") {
    const q = quoteId ? await db.supplierQuote.findUnique({ where: { id: quoteId } }) : null;
    if (!q) return "missing quote";
    const text =
      `Confirmed ✅ Please book ${r.rfq.rooms} rooms, ${CATEGORY_LABEL[r.rfq.category]}, ${MEAL_PLAN_LABEL[r.rfq.mealPlan]}, for Lavigo Travel in ` +
      `${r.rfq.destination}, check-in ${vars.check_in}, check-out ${formatDate(addDays(r.rfq.checkIn, r.rfq.nights), "d MMM yyyy")} (${r.rfq.nights} nights), ` +
      `at ${inr(q.ratePerRoomNight)}/room/night, ${inr(q.totalAmount)} in total. Please send the confirmation number. Thank you 🙏`;
    if (r.channel === "WHATSAPP") {
      const conv = await supplierConversation(r.supplier);
      if (conv && windowOpen(conv.lastInboundAt)) {
        const res = await send(conv.id, { type: "text", body: text }, "SYSTEM");
        ok = res.status !== "BLOCKED";
        error = res.status === "BLOCKED" ? res.reason : null;
      } else {
        error = "WINDOW_CLOSED";
        if (conv) await send(conv.id, { type: "note", body: `🏨 Booking confirmed with ${r.supplier.name}: call them to confirm (their 24-hour WhatsApp window is closed).` }, "SYSTEM");
      }
    } else if (r.supplier.email) {
      await sendMail({ to: r.supplier.email, subject: `Booking confirmed: ${r.rfq.destination}, check-in ${vars.check_in}`, text });
      ok = true;
    }
    logger.info({ recipientId, ok, error }, "rfq booking confirmation");
    return ok ? "confirmed" : `confirmation not sent (${error ?? "no contact"})`;
  }

  if (r.channel === "WHATSAPP") {
    const conv = await supplierConversation(r.supplier);
    const res = conv
      ? await sendTemplate({ conversationId: conv.id }, "rfq_request", vars, { meta: { rfqId: r.rfqId, recipientId: r.id, nudge: kind === "nudge" } })
      : ({ sent: false, reason: "no WhatsApp number" } as const);
    ok = res.sent;
    if (res.sent) messageId = res.messageId;
    else error = res.reason;
  } else if (r.supplier.email) {
    const template = await db.messageTemplate.findUnique({ where: { name: "rfq_request" } });
    const body = template ? renderTemplate(template, vars) : `Please share your best rate for ${vars.rooms} rooms in ${vars.destination}.`;
    const text = `${kind === "nudge" ? "Gentle reminder 🙏\n\n" : ""}${body}\n\nYou can simply reply to this email with your rate per room per night.`;
    const res = await sendMail({ to: r.supplier.email, subject: `${kind === "nudge" ? "Reminder: " : ""}Rate request: ${vars.destination}, check-in ${vars.check_in}`, text });
    ok = true;
    messageId = res.messageId;
  } else {
    error = "no email";
  }

  const now = new Date();
  if (kind === "nudge") {
    await db.rfqRecipient.updateMany({ where: { id: r.id, status: "SENT", nudgedAt: null }, data: ok ? { status: "NUDGED", nudgedAt: now } : { nudgedAt: now } });
  } else {
    await db.rfqRecipient.updateMany({
      where: { id: r.id, status: "QUEUED" },
      data: ok ? { status: "SENT", sentAt: now, outboundMessageId: messageId } : { status: "FAILED" },
    });
  }
  if (!ok) logger.warn({ recipientId, kind, reason: error }, "rfq send failed");
  await rfqUpdated(r.rfqId);
  return ok ? kind : `failed (${error})`;
}

// ───────────────────────────── 6.3 / 6.4 replies (SUP-4, SUP-5) ─────────────────────────────

/** rfq.parseReply job: a WhatsApp message from a known supplier phone (INB-4). */
export async function handleSupplierReply(data: { messageId: string; supplierId: string }) {
  const msg = await db.message.findUnique({ where: { id: data.messageId }, select: { id: true, body: true, createdAt: true } });
  if (!msg) return { outcome: "missing message" };
  // DFD 6.3: the most recent SENT RFQ that went to this supplier.
  const recipient = await db.rfqRecipient.findFirst({
    where: { supplierId: data.supplierId, rfq: { status: "SENT" }, status: { notIn: ["QUEUED", "FAILED"] } },
    orderBy: [{ rfq: { sentAt: "desc" } }, { rfq: { createdAt: "desc" } }],
    include: { rfq: true, supplier: { select: { name: true } } },
  });
  if (!recipient) {
    logger.info({ supplierId: data.supplierId }, "supplier reply without an open rate request");
    return { outcome: "no open rfq" };
  }
  const text = msg.body ?? "";
  const dup = await db.supplierQuote.findFirst({ where: { recipientId: recipient.id, rawText: text, createdAt: { gte: msg.createdAt } }, select: { id: true } });
  if (dup) return { outcome: "duplicate", quoteId: dup.id };
  return recordReply(recipient, text, "AI_PARSED", msg.createdAt, "SUPPLIER");
}

/**
 * One current quote per supplier: a new quote supersedes the recipient's RECEIVED ones (kept as
 * REJECTED for history), so compare / best / savings never see two rates from the same supplier.
 */
async function createCurrentQuote(
  recipientId: string,
  data: { ratePerRoomNight: number; totalAmount: number; inclusions: string | null; rawText: string; source: "AI_PARSED" | "MANUAL"; confidenceBps: number | null },
) {
  return db.$transaction(async (tx) => {
    await tx.supplierQuote.updateMany({ where: { recipientId, status: "RECEIVED" }, data: { status: "REJECTED" } });
    return tx.supplierQuote.create({ data: { recipientId, ...data } });
  });
}

type RecipientCtx = { id: string; rfqId: string; repliedAt: Date | null; rfq: { rooms: number; nights: number; destination: string }; supplier: { name: string } };

async function recordReply(recipient: RecipientCtx, text: string, source: "AI_PARSED", at: Date, actorType: "USER" | "SUPPLIER") {
  const parsed = parseSupplierReply(text, { rooms: recipient.rfq.rooms, nights: recipient.rfq.nights });
  if (parsed.isDecline) {
    await db.rfqRecipient.update({ where: { id: recipient.id }, data: { status: "DECLINED", repliedAt: recipient.repliedAt ?? at } });
    await activity("🙅", `${recipient.supplier.name} can't do ${recipient.rfq.destination} on those dates`, "supplier.declined", recipient.rfqId, actorType);
    await rfqUpdated(recipient.rfqId);
    return { outcome: "declined" as const };
  }
  // Chatter ("will send rates by evening"): no quote, no status change, nudges continue. The
  // message itself is already stored and shows as "Latest: …" on the supplier's row.
  if (parsed.ratePerRoomNight === null) {
    await rfqUpdated(recipient.rfqId);
    return { outcome: "chatter" as const };
  }
  const rate = parsed.ratePerRoomNight;
  const roomNights = recipient.rfq.rooms * recipient.rfq.nights;
  // parseSupplierReply only keeps a stated total that equals rate × rooms × nights (±₹1/room-night).
  const quote = await createCurrentQuote(recipient.id, {
    ratePerRoomNight: rate,
    totalAmount: parsed.totalIfStated ?? rate * roomNights,
    inclusions: parsed.inclusions,
    rawText: text.slice(0, 4000),
    source,
    confidenceBps: confidenceBps(parsed.confidence),
  });
  await db.rfqRecipient.update({ where: { id: recipient.id }, data: { status: "REPLIED", repliedAt: recipient.repliedAt ?? at } });
  const flagged = quote.confidenceBps! < HIGH_CONFIDENCE_BPS;
  await activity(
    "🏨",
    rate && !flagged
      ? `${recipient.supplier.name} quoted ${inr(rate)}/room/night for ${recipient.rfq.destination}`
      : `${recipient.supplier.name} replied for ${recipient.rfq.destination} · needs a check`,
    "supplier.replied",
    recipient.rfqId,
    actorType,
  );
  await rfqUpdated(recipient.rfqId);
  return { outcome: flagged ? ("needs check" as const) : ("quoted" as const), quoteId: quote.id };
}

/** One-click confirm of a "needs check" quote: staff pick a candidate or type the rate. */
export async function confirmQuote(quoteId: string, ratePerRoomNight: number, actor: Actor) {
  if (!Number.isSafeInteger(ratePerRoomNight) || ratePerRoomNight <= 0) throw new SupplierError("INVALID", "Enter the rate per room per night");
  const q = await db.supplierQuote.findUnique({ where: { id: quoteId }, include: { recipient: { include: { rfq: true } } } });
  if (!q) throw new SupplierError("NOT_FOUND", "Quote not found");
  if (q.status !== "RECEIVED" || q.recipient.rfq.status !== "SENT") throw new SupplierError("ALREADY_BOOKED", "This request is already booked");
  const { rooms, nights } = q.recipient.rfq;
  const updated = await db.supplierQuote.update({
    where: { id: q.id },
    data: { ratePerRoomNight, totalAmount: ratePerRoomNight * rooms * nights, confidenceBps: 10_000 },
  });
  await audit({ userId: actor.id, action: "supplier_quote.confirm", entityType: "SupplierQuote", entityId: q.id, before: { ratePerRoomNight: q.ratePerRoomNight, confidenceBps: q.confidenceBps }, after: { ratePerRoomNight } });
  await rfqUpdated(q.recipient.rfqId);
  return updated;
}

/** SUP-5: "Add quote" for email / phone replies: paste the text (same parser) or type the values (MANUAL). */
export async function addQuote(
  input: { rfqId: string; supplierId: string } & ({ text: string } | { ratePerRoomNight: number; inclusions?: string | null }),
  actor: Actor,
) {
  const rfq = await db.rfq.findUnique({ where: { id: input.rfqId } });
  if (!rfq) throw new SupplierError("NOT_FOUND", "Rate request not found");
  if (rfq.status !== "SENT") throw new SupplierError("ALREADY_BOOKED", "This request is already booked");
  const supplier = await db.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new SupplierError("NOT_FOUND", "Supplier not found");
  const recipient = await db.rfqRecipient.upsert({
    where: { rfqId_supplierId: { rfqId: rfq.id, supplierId: supplier.id } },
    update: {},
    create: { rfqId: rfq.id, supplierId: supplier.id, channel: supplier.preferredChannel, status: "SENT", sentAt: rfq.sentAt },
  });
  const ctx = { ...recipient, rfq, supplier };
  await audit({ userId: actor.id, action: "supplier_quote.add", entityType: "Rfq", entityId: rfq.id, after: { supplierId: supplier.id, pasted: "text" in input } });
  if ("text" in input) {
    const r = await recordReply(ctx, input.text, "AI_PARSED", new Date(), "USER");
    if (r.outcome === "chatter") throw new SupplierError("INVALID", "No rate found in that text. Type the rate instead.");
    return r;
  }

  if (!Number.isSafeInteger(input.ratePerRoomNight) || input.ratePerRoomNight <= 0) throw new SupplierError("INVALID", "Enter the rate per room per night");
  const quote = await createCurrentQuote(recipient.id, {
    ratePerRoomNight: input.ratePerRoomNight,
    totalAmount: input.ratePerRoomNight * rfq.rooms * rfq.nights,
    inclusions: input.inclusions || null,
    rawText: `Typed by staff: ${inr(input.ratePerRoomNight)}/room/night${input.inclusions ? ` · ${input.inclusions}` : ""}`,
    source: "MANUAL",
    confidenceBps: null,
  });
  await db.rfqRecipient.update({ where: { id: recipient.id }, data: { status: "REPLIED", repliedAt: recipient.repliedAt ?? new Date() } });
  await activity("🏨", `${supplier.name} quoted ${inr(input.ratePerRoomNight)}/room/night for ${rfq.destination} (added by hand)`, "supplier.replied", rfq.id);
  await rfqUpdated(rfq.id);
  return { outcome: "quoted" as const, quoteId: quote.id };
}

/** "Undo decline": the parser (or a supplier's wording) got it wrong; back to waiting. Audited. */
export async function undoDecline(recipientId: string, actor: Actor) {
  const r = await db.rfqRecipient.findUnique({ where: { id: recipientId }, include: { rfq: { select: { status: true } }, supplier: { select: { name: true } } } });
  if (!r) throw new SupplierError("NOT_FOUND", "Supplier not found on this request");
  if (r.rfq.status !== "SENT") throw new SupplierError("ALREADY_BOOKED", "This request is already booked");
  const { count } = await db.rfqRecipient.updateMany({ where: { id: r.id, status: "DECLINED" }, data: { status: "SENT" } });
  if (!count) throw new SupplierError("INVALID", `${r.supplier.name} isn't marked as declined`);
  await audit({ userId: actor.id, action: "rfq_recipient.undo_decline", entityType: "RfqRecipient", entityId: r.id, before: { status: "DECLINED" }, after: { status: "SENT" } });
  await rfqUpdated(r.rfqId);
}

// ───────────────────────────── 6.6 book (SUP-7) ─────────────────────────────

export async function bookQuote(quoteId: string, actor: Actor) {
  const result = await db.$transaction(async (tx) => {
    const q = await tx.supplierQuote.findUnique({ where: { id: quoteId }, include: { recipient: { include: { rfq: true, supplier: true } } } });
    if (!q) throw new SupplierError("NOT_FOUND", "Quote not found");
    const { rfq, supplier } = q.recipient;
    if (q.recipient.status === "DECLINED") throw new SupplierError("DECLINED", `${supplier.name} declined this request`);
    if (q.status !== "RECEIVED") throw new SupplierError("INVALID", "This quote was replaced by a newer one");
    if (q.ratePerRoomNight <= 0 || (q.confidenceBps !== null && q.confidenceBps < HIGH_CONFIDENCE_BPS)) {
      throw new SupplierError("NEEDS_CHECK", "Confirm the rate first");
    }
    // Claim the RFQ: only one quote can ever be booked.
    const claimed = await tx.rfq.updateMany({ where: { id: rfq.id, status: "SENT" }, data: { status: "BOOKED" } });
    if (!claimed.count) throw new SupplierError("ALREADY_BOOKED", "This request is already booked");
    const now = new Date();
    // Always book rate × rooms × nights (a stated total only when it agrees within ₹1/room-night).
    const amount = bookableTotal(q, rfq.rooms, rfq.nights);
    await tx.supplierQuote.update({ where: { id: q.id }, data: { status: "BOOKED", bookedAt: now, totalAmount: amount } });
    await tx.supplierQuote.updateMany({ where: { recipient: { rfqId: rfq.id }, id: { not: q.id }, status: "RECEIVED" }, data: { status: "REJECTED" } });
    const expense = await tx.expense.create({
      data: {
        departureId: rfq.departureId,
        supplierId: supplier.id,
        supplierQuoteId: q.id,
        category: "HOTEL",
        amount,
        description: `${supplier.name} · ${rfq.rooms} rooms × ${rfq.nights} nights · ${rfq.destination}, check-in ${formatDate(rfq.checkIn, "d MMM yyyy")}`,
        incurredOn: rfq.checkIn,
        createdById: actor.id,
      },
    });
    await audit({ userId: actor.id, action: "rfq.book", entityType: "Rfq", entityId: rfq.id, after: { quoteId: q.id, expenseId: expense.id, amount } }, tx);
    return { rfq, supplier, quote: { ...q, totalAmount: amount }, expense };
  });
  await enqueue("rfq.send", { recipientId: result.quote.recipientId, kind: "confirm", quoteId: result.quote.id }, { jobId: `rfq-confirm-${result.quote.id}` });
  await activity("🏨", `Booked ${result.supplier.name} for ${result.rfq.destination}, ${formatDate(result.rfq.checkIn)} · ${inr(result.quote.totalAmount)}`, "rfq.booked", result.rfq.id);
  await publish({ type: "toast", payload: { text: `Booked ${result.supplier.name} · confirmation on its way`, icon: "🏨" } }).catch(() => undefined);
  await rfqUpdated(result.rfq.id);
  return { expenseId: result.expense.id, rfqId: result.rfq.id };
}

// ───────────────────────────── 6.7 nudge / timeout (SUP-8) ─────────────────────────────

export async function scanNudges(now: Date = new Date()) {
  const due = await db.rfqRecipient.findMany({
    where: { status: "SENT", nudgedAt: null, sentAt: { lte: new Date(now.getTime() - NUDGE_AFTER_MS), gt: new Date(now.getTime() - NO_REPLY_AFTER_MS) }, rfq: { status: "SENT" } },
    select: { id: true },
  });
  let nudged = 0;
  for (const r of due) if ((await sendToRecipient(r.id, "nudge")) === "nudge") nudged += 1;

  const stale = await db.rfqRecipient.findMany({
    where: { status: { in: ["SENT", "NUDGED"] }, sentAt: { lte: new Date(now.getTime() - NO_REPLY_AFTER_MS) } },
    select: { id: true, rfqId: true },
  });
  if (stale.length) {
    await db.rfqRecipient.updateMany({ where: { id: { in: stale.map((s) => s.id) }, status: { in: ["SENT", "NUDGED"] } }, data: { status: "NO_REPLY" } });
    for (const id of new Set(stale.map((s) => s.rfqId))) await rfqUpdated(id);
  }
  return { nudged, noReply: stale.length };
}

export { sendVouchers, hasBookedHotels } from "./vouchers";
