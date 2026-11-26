/**
 * Supplier desk reads (SUP-2, SUP-6). Rows are built for the page; ranking and savings come from
 * the pure ./compare module, candidates for "needs check" from the pure parser.
 */
import type { ContactChannel, MealPlan, RfqRecipientStatus, RoomCategory, SupplierQuoteStatus, SupplierType } from "@prisma/client";
import { db } from "../../db";
import { daysBetween, formatDate, istDateStringOf, todayIST } from "../../time";
import { bestRow, isTrusted, savings, type Savings } from "./compare";
import { NO_REPLY_AFTER_MS, NUDGE_AFTER_MS } from "./index";
import { parseSupplierReply } from "./parser";

// ───────────────────────────── directory ─────────────────────────────

export type SupplierRow = {
  id: string;
  name: string;
  type: SupplierType;
  destinations: string[];
  contactName: string | null;
  phone: string | null;
  email: string | null;
  preferredChannel: ContactChannel;
  active: boolean;
  notes: string | null;
};

export async function listSuppliers(): Promise<SupplierRow[]> {
  return db.supplier.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true, type: true, destinations: true, contactName: true, phone: true, email: true, preferredChannel: true, active: true, notes: true },
  });
}

// ───────────────────────────── form (SUP-2) ─────────────────────────────

export type RfqForm = {
  destinations: string[];
  departures: { id: string; code: string; label: string; destination: string; checkIn: string; nights: number; usualRoomRate: number | null }[];
  suppliers: { id: string; name: string; destinations: string[]; channel: ContactChannel }[];
  /** Last BOOKED rate per destination + category (paise), the fallback baseline. */
  lastBooked: { destination: string; category: RoomCategory; rate: number }[];
};

export async function getRfqForm(now: Date = new Date()): Promise<RfqForm> {
  const [suppliers, departures, booked] = await Promise.all([
    db.supplier.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, destinations: true, preferredChannel: true } }),
    db.departure.findMany({
      where: { status: "OPEN", startDate: { gte: todayIST(now) } },
      orderBy: { startDate: "asc" },
      include: { trip: { select: { name: true, destination: true } } },
    }),
    db.supplierQuote.findMany({
      where: { status: "BOOKED" },
      orderBy: { bookedAt: "desc" },
      select: { ratePerRoomNight: true, recipient: { select: { rfq: { select: { destination: true, category: true } } } } },
      take: 200,
    }),
  ]);
  const seen = new Set<string>();
  const lastBooked: RfqForm["lastBooked"] = [];
  for (const q of booked) {
    const { destination, category } = q.recipient.rfq;
    const k = `${destination}|${category}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lastBooked.push({ destination, category, rate: q.ratePerRoomNight });
  }
  const destinations = [...new Set([...suppliers.flatMap((s) => s.destinations), ...departures.map((d) => d.trip.destination)])].sort();
  return {
    destinations,
    departures: departures.map((d) => ({
      id: d.id,
      code: d.code,
      label: `${d.trip.name} · ${formatDate(d.startDate)} (${d.code})`,
      destination: d.trip.destination,
      checkIn: istDateStringOf(d.startDate),
      nights: Math.max(1, daysBetween(d.startDate, d.endDate)),
      usualRoomRate: d.usualRoomRate,
    })),
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, destinations: s.destinations, channel: s.preferredChannel })),
    lastBooked,
  };
}

// ───────────────────────────── quotes table (SUP-6) ─────────────────────────────

export type QuoteRowView = {
  recipientId: string;
  supplierId: string;
  supplierName: string;
  channel: ContactChannel;
  status: RfqRecipientStatus;
  /** "12 min", "1h 5m" */
  repliedIn: string | null;
  /** For SENT rows: "in 1h 40m" until the nudge; null after it. */
  nudgeIn: string | null;
  quote: {
    id: string;
    ratePerRoomNight: number;
    totalAmount: number;
    inclusions: string | null;
    rawText: string;
    source: "AI_PARSED" | "MANUAL";
    status: SupplierQuoteStatus;
    needsCheck: boolean;
    candidates: number[];
  } | null;
  best: boolean;
  /** The supplier sent a newer quote that replaced an earlier one. */
  updated: boolean;
  /** Their latest message when it isn't the quote shown (chatter, a decline, a question). */
  latest: { text: string; ago: string } | null;
};

export type RfqView = {
  id: string;
  destination: string;
  checkInLabel: string;
  nights: number;
  rooms: number;
  category: RoomCategory;
  mealPlan: MealPlan;
  status: "DRAFT" | "SENT" | "CLOSED" | "BOOKED";
  baseline: number | null;
  departureCode: string | null;
  rows: QuoteRowView[];
  replied: number;
  best: { supplierName: string; rate: number } | null;
  savings: Savings | null;
  waiting: { name: string; nudgeIn: string | null; nudged: boolean }[];
};

function duration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h < 48 ? (m ? `${h}h ${m}m` : `${h}h`) : `${Math.round(h / 24)} days`;
}

export async function getRfqView(rfqId: string, now: Date = new Date()): Promise<RfqView | null> {
  const rfq = await db.rfq.findUnique({
    where: { id: rfqId },
    include: {
      departure: { select: { code: true } },
      recipients: {
        include: { supplier: { select: { name: true } }, quotes: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { quotes: true } } },
        orderBy: { supplier: { name: "asc" } },
      },
    },
  });
  if (!rfq) return null;
  const ctx = { rooms: rfq.rooms, nights: rfq.nights };

  // Latest inbound WhatsApp message per supplier since the request went out.
  const msgs = await db.message.findMany({
    where: { direction: "INBOUND", createdAt: { gte: rfq.sentAt ?? rfq.createdAt }, conversation: { supplierId: { in: rfq.recipients.map((r) => r.supplierId) } } },
    orderBy: { createdAt: "desc" },
    select: { body: true, createdAt: true, conversation: { select: { supplierId: true } } },
    take: 200,
  });
  const latestBySupplier = new Map<string, { body: string; createdAt: Date }>();
  for (const m of msgs) if (m.conversation.supplierId && !latestBySupplier.has(m.conversation.supplierId)) latestBySupplier.set(m.conversation.supplierId, m);

  const rows: QuoteRowView[] = rfq.recipients.map((r) => {
    const q = r.quotes[0] ?? null;
    const needsCheck = !!q && (q.ratePerRoomNight <= 0 || !isTrusted({ confidenceBps: q.confidenceBps }));
    const nudgeAt = r.sentAt ? r.sentAt.getTime() + NUDGE_AFTER_MS : null;
    return {
      recipientId: r.id,
      supplierId: r.supplierId,
      supplierName: r.supplier.name,
      channel: r.channel,
      status: r.status,
      repliedIn: r.repliedAt && r.sentAt ? duration(r.repliedAt.getTime() - r.sentAt.getTime()) : null,
      nudgeIn: r.status === "SENT" && !r.nudgedAt && nudgeAt ? duration(Math.max(60_000, nudgeAt - now.getTime())) : null,
      quote: q
        ? {
            id: q.id,
            ratePerRoomNight: q.ratePerRoomNight,
            totalAmount: q.totalAmount,
            inclusions: q.inclusions,
            rawText: q.rawText,
            source: q.source,
            status: q.status,
            needsCheck,
            candidates: needsCheck ? parseSupplierReply(q.rawText, ctx).candidates : [],
          }
        : null,
      best: false,
      updated: r._count.quotes > 1 && !!q && q.status !== "REJECTED",
      latest: (() => {
        const m = latestBySupplier.get(r.supplierId);
        if (!m?.body || (q && q.rawText === m.body.slice(0, 4000))) return null;
        return { text: m.body.length > 120 ? `${m.body.slice(0, 117)}…` : m.body, ago: `${duration(now.getTime() - m.createdAt.getTime())} ago` };
      })(),
    };
  });

  const best = bestRow(
    rows.map((r) => ({
      id: r.recipientId,
      ratePerRoomNight: r.quote && r.quote.ratePerRoomNight > 0 && r.quote.status !== "REJECTED" ? r.quote.ratePerRoomNight : null,
      declined: r.status === "DECLINED",
      confidenceBps: r.quote?.needsCheck ? 0 : null,
    })),
  );
  const bestView = best ? rows.find((r) => r.recipientId === best.id)! : null;
  if (bestView) bestView.best = true;

  const waiting = rows
    .filter((r) => r.status === "QUEUED" || r.status === "SENT" || r.status === "NUDGED")
    .map((r) => ({ name: r.supplierName, nudgeIn: r.nudgeIn, nudged: r.status === "NUDGED" }));

  return {
    id: rfq.id,
    destination: rfq.destination,
    checkInLabel: formatDate(rfq.checkIn, "d MMM yyyy"),
    nights: rfq.nights,
    rooms: rfq.rooms,
    category: rfq.category,
    mealPlan: rfq.mealPlan,
    status: rfq.status,
    baseline: rfq.baselineRatePerRoomNight,
    departureCode: rfq.departure?.code ?? null,
    rows,
    replied: rows.filter((r) => r.status === "REPLIED" || r.status === "DECLINED").length,
    best: bestView?.quote ? { supplierName: bestView.supplierName, rate: bestView.quote.ratePerRoomNight } : null,
    savings: savings(rfq.baselineRatePerRoomNight, bestView?.quote?.ratePerRoomNight ?? null, rfq.rooms, rfq.nights),
    waiting,
  };
}

export async function listRecentRfqs(limit = 12) {
  const rows = await db.rfq.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, destination: true, checkIn: true, status: true, _count: { select: { recipients: true } } },
  });
  return rows.map((r) => ({ id: r.id, label: `${r.destination} · ${formatDate(r.checkIn)}${r.status === "BOOKED" ? " · booked" : ""}`, status: r.status, recipients: r._count.recipients }));
}

/** A reply "timed out" once it's past the NO_REPLY window, even before the cron marks it. */
export function timedOut(r: { status: RfqRecipientStatus; sentAt: Date | null }, now: Date): boolean {
  return (r.status === "SENT" || r.status === "NUDGED") && !!r.sentAt && now.getTime() - r.sentAt.getTime() >= NO_REPLY_AFTER_MS;
}

