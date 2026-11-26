/**
 * Today (SRS §4.2, TOD-1 … TOD-5). Everything is computed live from source tables: there are no
 * stored counters and no "needs you" table. Sources whose tables are still empty (RFQs, quotes,
 * fares) simply contribute nothing until their phase lands.
 *
 * Role: profit, cost and margin never reach a STAFF session (CLAUDE.md), so callers pass the role.
 */
import type { Role } from "@prisma/client";
import { db } from "../../db";
import { inr, inrLakh, pct, toBps } from "../../money";
import { addDays, daysBetween, formatDate, formatIST, istStartOfDay, monthStart, todayIST } from "../../time";
import { waitingConversations } from "../conversations/waiting";
import { getLateBookings } from "../dues";
import { rfqNeeds } from "../suppliers/needs-you";
import { ticketNeeds } from "../tickets/needs-you";

// ───────────────────────────── KPIs (TOD-1) ─────────────────────────────

export type Kpis = {
  monthName: string;
  prevMonthName: string;
  collectedThisMonth: number;
  collectedChangePct: number | null; // vs last month; null when last month was 0
  balanceToCollect: number;
  lateCount: number;
  remindersOn: boolean;
  enquiriesToday: number;
  enquiriesReplied: number;
  enquiriesWaiting: number;
  /** OWNER only. */
  profit: { bookedThisMonth: number; avgMarginBps: number } | null;
  /** Shown to STAFF in place of profit. */
  bookingsThisMonth: { count: number; travellers: number };
};

async function collectedBetween(from: Date, to: Date): Promise<number> {
  const r = await db.payment.aggregate({
    where: { status: "CAPTURED", receivedAt: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  return r._sum.amount ?? 0;
}

/**
 * Today's enquiries: customer conversations whose FIRST inbound message arrived today (IST).
 * "Still waiting" is the shared waiting-for-a-reply rule (any age), so this KPI and Needs-you
 * (waiting > 30 min, any day) can't contradict each other: the KPI is a subset by scope.
 */
async function enquiriesToday(today: Date) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT m."conversationId" AS id
    FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE m.direction = 'INBOUND' AND c."customerId" IS NOT NULL AND c."supplierId" IS NULL
    GROUP BY m."conversationId"
    HAVING min(m."createdAt") >= ${istStartOfDay(today)} AND min(m."createdAt") < ${istStartOfDay(addDays(today, 1))}`;
  const waiting = await waitingConversations({ ids: rows.map((r) => r.id) });
  return { total: rows.length, replied: rows.length - waiting.length, waiting: waiting.length };
}

export async function getKpis(role: Role, now: Date = new Date()): Promise<Kpis> {
  const today = todayIST(now);
  const thisMonth = monthStart(today);
  const lastMonth = monthStart(today, 1);
  const nextMonth = monthStart(today, -1);
  const [cur, prev, late, open, rules, enq, booked] = await Promise.all([
    collectedBetween(istStartOfDay(thisMonth), istStartOfDay(nextMonth)),
    collectedBetween(istStartOfDay(lastMonth), istStartOfDay(thisMonth)),
    getLateBookings(now, 1),
    db.booking.findMany({ where: { status: { in: ["HELD", "CONFIRMED"] } }, select: { totalAmount: true, paidAmount: true } }),
    db.reminderRule.count({ where: { enabled: true, action: "SEND_REMINDER" } }),
    enquiriesToday(today),
    db.booking.findMany({
      where: { status: { not: "CANCELLED" }, createdAt: { gte: istStartOfDay(thisMonth), lt: istStartOfDay(nextMonth) } },
      select: { totalAmount: true, costTotalPlanned: true, pax: true },
    }),
  ]);
  const revenue = booked.reduce((s, b) => s + b.totalAmount, 0);
  const profit = booked.reduce((s, b) => s + b.totalAmount - b.costTotalPlanned, 0);
  return {
    monthName: formatDate(thisMonth, "MMMM"),
    prevMonthName: formatDate(lastMonth, "MMMM"),
    collectedThisMonth: cur,
    collectedChangePct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null,
    balanceToCollect: open.reduce((s, b) => s + Math.max(0, b.totalAmount - b.paidAmount), 0),
    lateCount: late.length,
    remindersOn: rules > 0,
    enquiriesToday: enq.total,
    enquiriesReplied: enq.replied,
    enquiriesWaiting: enq.waiting,
    profit: role === "OWNER" ? { bookedThisMonth: profit, avgMarginBps: revenue > 0 ? toBps(profit, revenue) : 0 } : null,
    bookingsThisMonth: { count: booked.length, travellers: booked.reduce((s, b) => s + b.pax, 0) },
  };
}

// ───────────────────────────── Needs you (TOD-2) ─────────────────────────────

export type NeedAction = { label: string; href: string; primary?: boolean };
export type NeedItem = {
  key: string;
  icon: string;
  tone: "lav" | "ok" | "bad" | "warn";
  title: string;
  detail: string;
  action: NeedAction;
};

export const WAITING_REPLY_MINUTES = 30;
export const LATE_FLAG_DAYS = 7;
export const LOW_SEATS_BPS = 4000; // < 40% sold
export const LOW_SEATS_WITHIN_DAYS = 90;

/** Today and the badge use the inbox's definition (conversations/waiting.ts). */
export { waitingConversations } from "../conversations/waiting";

function ago(from: Date, now: Date): string {
  const mins = Math.max(1, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}

async function approvalNeeds(role: Role): Promise<NeedItem[]> {
  const rows = await db.approval.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: {
      conversation: { select: { customer: { select: { name: true } } } },
      departure: { select: { startDate: true, costPerPax: true, trip: { select: { name: true } } } },
    },
  });
  return rows.map((a) => {
    const who = a.conversation?.customer?.name;
    if ((a.kind === "PRICE" || a.kind === "BELOW_FLOOR" || a.kind === "LARGE_GROUP") && a.requestedPricePerPax != null) {
      const parts = [
        a.pax ? `${a.pax} travellers` : null,
        a.departure ? `${a.departure.trip.name} ${formatDate(a.departure.startDate)}` : null,
        `asking ${inr(a.requestedPricePerPax)} per person`,
      ];
      if (a.suggestedPricePerPax != null) {
        parts.push(
          role === "OWNER" && a.departure
            ? `suggested ${inr(a.suggestedPricePerPax)}, margin ${pct(toBps(a.suggestedPricePerPax - a.departure.costPerPax, a.suggestedPricePerPax))}`
            : `suggested ${inr(a.suggestedPricePerPax)}`,
        );
      }
      return {
        key: `approval:${a.id}`,
        icon: "🤝",
        tone: "lav",
        title: `${who ?? "A customer"} wants a ${a.pax && a.pax >= 2 ? "group " : ""}discount`,
        detail: parts.filter(Boolean).join(" · "),
        action: { label: "Review", href: role === "OWNER" ? `/approvals/${a.id}` : a.conversationId ? `/inbox?c=${a.conversationId}` : "/inbox", primary: true },
      } satisfies NeedItem;
    }
    return {
      key: `approval:${a.id}`,
      icon: "⚠️",
      tone: "warn",
      title: who ? `${who}: needs your decision` : "Needs your decision",
      detail: a.summary,
      action: { label: "Review", href: role === "OWNER" ? `/approvals/${a.id}` : a.conversationId ? `/inbox?c=${a.conversationId}` : "/inbox", primary: true },
    } satisfies NeedItem;
  });
}

async function waitingNeeds(now: Date): Promise<NeedItem[]> {
  const rows = await waitingConversations({ olderThan: new Date(now.getTime() - WAITING_REPLY_MINUTES * 60_000) });
  if (!rows.length) return [];
  const oldest = rows[0]!;
  return [
    {
      key: "waiting",
      icon: "💬",
      tone: "lav",
      title: rows.length === 1 ? `${oldest.name} is waiting for a reply` : `${rows.length} chats are waiting for a reply`,
      detail:
        rows.length === 1
          ? `Waiting ${ago(oldest.lastInboundAt, now)}`
          : `${rows.slice(0, 3).map((r) => r.name).join(", ")}${rows.length > 3 ? "…" : ""} · oldest waiting ${ago(oldest.lastInboundAt, now)}`,
      action: { label: "Reply", href: rows.length === 1 ? `/inbox?c=${oldest.id}` : "/inbox" },
    },
  ];
}

/** DESK-7: conversations followups.scan marked "Follow-up due" (same source as the inbox pill). */
async function quoteNeeds(now: Date): Promise<NeedItem[]> {
  const convs = await db.conversation.findMany({
    where: { status: "FOLLOW_UP", customerId: { not: null }, supplierId: null },
    orderBy: { lastMessageAt: "asc" },
    take: 20,
    include: {
      customer: { select: { name: true } },
      quotes: { orderBy: { createdAt: "desc" }, take: 1, include: { departure: { select: { startDate: true, trip: { select: { name: true } } } } } },
    },
  });
  return convs.map((c) => {
    const q = c.quotes[0];
    return {
      key: `quote:${c.id}`,
      icon: "🔁",
      tone: "lav" as const,
      title: `${c.customer?.name ?? "A customer"} hasn't replied to your quote`,
      detail: q
        ? `${q.departure.trip.name} ${formatDate(q.departure.startDate)} · ${q.pax} travellers · ${inr(q.totalAmount)} · sent ${ago(q.createdAt, now)} ago`
        : "Follow-up due",
      action: { label: "Follow up", href: `/inbox?c=${c.id}` },
    };
  });
}

async function lateNeeds(now: Date): Promise<NeedItem[]> {
  const late = await getLateBookings(now, LATE_FLAG_DAYS);
  return late.map((r) => ({
    key: `late:${r.bookingId}`,
    icon: "⏰",
    tone: "bad",
    title: `${r.customerName} is ${r.daysLate} days late on ${inr(r.balance)}`,
    detail: `${r.remindersSent} reminder${r.remindersSent === 1 ? "" : "s"} sent · call today`,
    action: r.phone ? { label: "Call", href: `tel:${r.phone}` } : { label: "Open", href: `/bookings?b=${r.code}` },
  }));
}

/**
 * Past travellers who could fill a departure: customers with a CONFIRMED/COMPLETED booking
 * elsewhere, not already booked on it. The Departures phase refines this into the campaign audience.
 */
export async function matchingPastCustomers(departureId: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT b."customerId")::bigint AS n
    FROM "Booking" b
    WHERE b.status IN ('CONFIRMED', 'COMPLETED')
      AND (b."departureId" IS NULL OR b."departureId" <> ${departureId})
      AND b."customerId" NOT IN (
        SELECT x."customerId" FROM "Booking" x
        WHERE x."departureId" = ${departureId} AND x.status IN ('HELD', 'CONFIRMED', 'COMPLETED')
      )`;
  return Number(rows[0]?.n ?? 0);
}

async function lowSeatNeeds(now: Date): Promise<NeedItem[]> {
  const today = todayIST(now);
  const deps = await getUpcomingDepartures(now, 50);
  const out: NeedItem[] = [];
  for (const d of deps) {
    if (d.status !== "OPEN" || d.daysToGo >= LOW_SEATS_WITHIN_DAYS) continue;
    if (toBps(d.sold, d.seats) >= LOW_SEATS_BPS) continue;
    const matches = await matchingPastCustomers(d.id);
    out.push({
      key: `seats:${d.id}`,
      icon: "🚌",
      tone: "warn",
      title: `${d.name} ${formatDate(d.startDate)}: only ${d.sold} of ${d.seats} seats sold`,
      detail: `${daysBetween(today, d.startDate)} days to go · ${matches} past customer${matches === 1 ? "" : "s"} match this trip`,
      action: { label: "Fill seats", href: `/departures?d=${d.code}` },
    });
  }
  return out;
}

/** Demo order: approvals, chats, supplier quotes, late payments, fares, empty seats, quiet quotes. */
export async function getNeedsYou(role: Role, now: Date = new Date()): Promise<NeedItem[]> {
  const groups = await Promise.all([
    approvalNeeds(role),
    waitingNeeds(now),
    rfqNeeds(now),
    lateNeeds(now),
    ticketNeeds(role, now),
    lowSeatNeeds(now),
    quoteNeeds(now),
  ]);
  return groups.flat();
}

// ───────────────────────────── activity (TOD-3) ─────────────────────────────

export type ActivityItem = { id: string; time: string; icon: string; text: string };

export function toActivityItem(a: { id: string; createdAt: Date; icon: string; text: string }): ActivityItem {
  return { id: a.id, time: formatIST(a.createdAt, "h:mm"), icon: a.icon, text: a.text };
}

export async function getActivity(limit = 20): Promise<ActivityItem[]> {
  const rows = await db.activityEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return rows.map(toActivityItem);
}

// ───────────────────────────── collections chart (TOD-4) ─────────────────────────────

export type MonthBar = { label: string; amount: number; lakh: string; heightPct: number; current: boolean };

export async function getCollectedByMonth(months = 6, now: Date = new Date()): Promise<MonthBar[]> {
  const today = todayIST(now);
  const starts = Array.from({ length: months }, (_, i) => monthStart(today, months - 1 - i));
  const amounts = await Promise.all(
    starts.map((s, i) => collectedBetween(istStartOfDay(s), istStartOfDay(i === months - 1 ? monthStart(today, -1) : starts[i + 1]!))),
  );
  const max = Math.max(1, ...amounts);
  return starts.map((s, i) => ({
    label: formatDate(s, "MMM"),
    amount: amounts[i]!,
    lakh: inrLakh(amounts[i]!),
    // The tallest bar fills 82% of the track, like the demo.
    heightPct: Math.round((amounts[i]! / max) * 82),
    current: i === months - 1,
  }));
}

// ───────────────────────────── departures (TOD-5) ─────────────────────────────

export type UpcomingDeparture = {
  id: string;
  code: string;
  name: string;
  title: string;
  startDate: Date;
  dateLabel: string;
  seats: number;
  sold: number;
  daysToGo: number;
  status: string;
};

export async function getUpcomingDepartures(now: Date = new Date(), limit = 4): Promise<UpcomingDeparture[]> {
  const today = todayIST(now);
  const deps = await db.departure.findMany({
    where: { startDate: { gte: today }, status: { in: ["OPEN", "CLOSED"] } },
    orderBy: { startDate: "asc" },
    take: limit,
    include: { trip: { select: { name: true, title: true } } },
  });
  const sold = await db.booking.groupBy({
    by: ["departureId"],
    where: { departureId: { in: deps.map((d) => d.id) }, status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } },
    _sum: { pax: true },
  });
  const soldBy = new Map(sold.map((s) => [s.departureId, s._sum.pax ?? 0]));
  return deps.map((d) => ({
    id: d.id,
    code: d.code,
    name: d.trip.name,
    title: d.trip.title,
    startDate: d.startDate,
    dateLabel: formatDate(d.startDate),
    seats: d.seatsTotal,
    sold: soldBy.get(d.id) ?? 0,
    daysToGo: daysBetween(today, d.startDate),
    status: d.status,
  }));
}
