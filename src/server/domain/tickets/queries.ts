/**
 * Tickets desk reads (TKT-1..TKT-7). The page and the Needs-you list both build on these.
 * Profit (extra profit vs the travel budget) is only filled in for OWNER; STAFF get null.
 */
import type { Prisma, Role, TravelMode, TravelPlanStatus } from "@prisma/client";
import { db } from "../../db";
import { daysBetween, formatDate, formatIST, istDateStringOf, todayIST } from "../../time";
import { fareAlert, FARE_WINDOW_DAYS, irctcPassengerText, pnrSplit, rankOptions, unticketed, type Passenger } from "./core";
import { planBookings, ticketedPassengers } from "./index";

export type OptionView = {
  id: string;
  mode: TravelMode;
  title: string;
  details: string;
  ticketPerPax: number;
  extrasPerPax: number;
  extrasNote: string | null;
  tags: string[];
  disqualified: boolean;
  disqualifiedReason: string | null;
  landed: number;
  vsBudget: number;
  best: boolean;
  booked: boolean;
};

export type PlanView = {
  id: string;
  label: string;
  who: string;
  dateLabel: string;
  travelDate: string;
  origin: string;
  destination: string;
  departureId: string | null;
  bookingId: string | null;
  note: string | null;
  status: TravelPlanStatus;
  /** "flight": portal-style; "train": IRCTC with a booking plan; "window": train, bookings not open yet. */
  kind: "flight" | "train" | "window";
  budgetPerPax: number;
  /** Travellers this view is about: those still to ticket, else everyone ticketed. */
  pax: number;
  toTicket: number;
  ticketedPax: number;
  options: OptionView[];
  best: { id: string; title: string; landed: number } | null;
  /** OWNER only: (budget − best landed) × pax, or the profit locked in once booked. */
  extraProfit: number | null;
  locked: boolean;
  windowOpens: { label: string; short: string } | null;
  trend: { title: string; fares: number[]; today: number; rise: number } | null;
  /** The pending split for travellers still to ticket (trains), with IRCTC text per ticket. */
  split: { label: string; count: number; text: string }[];
  tickets: { idx: number; label: string; count: number; pnr: string | null; documentId: string | null }[];
};

export type DeskAlerts = {
  window: { planId: string; title: string; opens: string; days: number; ready: number; total: number; remind: string } | null;
  fare: { planId: string; text: string; rise: number; riseBps: number; underBudget: boolean } | null;
  newTravellers: { planId: string | null; count: number; text: string };
};

export type PlanForm = {
  departures: { id: string; label: string; destination: string; startDate: string; budget: number | null }[];
  bookings: { id: string; label: string; startDate: string | null }[];
};

const head = (label: string) => label.split(" · ")[0]!;
const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)![0]}.` : first!;
};

async function loadPlans(where: Prisma.TravelPlanWhereInput = {}) {
  return db.travelPlan.findMany({
    where,
    orderBy: [{ travelDate: "asc" }, { createdAt: "asc" }],
    include: {
      options: { orderBy: { createdAt: "asc" }, include: { fareSnapshots: { orderBy: { capturedAt: "asc" } } } },
      tickets: { orderBy: { idx: "asc" } },
      booking: { select: { customer: { select: { name: true } } } },
    },
  });
}
type LoadedPlan = Awaited<ReturnType<typeof loadPlans>>[number];

function kindOf(plan: LoadedPlan, bestMode: TravelMode | undefined, now: Date): PlanView["kind"] {
  if (bestMode !== "TRAIN" && bestMode !== "BUS") return bestMode === "FLIGHT" ? "flight" : "train";
  if (bestMode === "TRAIN" && plan.status !== "BOOKED" && plan.windowOpensAt && plan.windowOpensAt > now) return "window";
  return "train";
}

async function buildPlan(plan: LoadedPlan, role: Role, now: Date): Promise<PlanView> {
  const bookings = await planBookings(plan);
  const ticketed = ticketedPassengers(plan.tickets);
  const parties = unticketed(bookings, ticketed);
  const toTicket = parties.reduce((n, p) => n + p.passengers.length, 0);
  const ticketedPax = ticketed.length;
  const pax = toTicket || ticketedPax;
  const { ranked, best, extraProfit } = rankOptions(plan.options, plan.budgetPerPax, pax);
  const locked = plan.status === "BOOKED" && toTicket === 0;
  const bookedOpt = plan.options.find((o) => o.id === plan.bookedOptionId) ?? null;
  const shownBest = locked && bookedOpt ? ranked.find((o) => o.id === bookedOpt.id)! : best;
  const kind = kindOf(plan, shownBest?.mode, now);

  const customer = plan.booking?.customer.name;
  const newNames = parties.map((p) => p.label).join(", ");
  const who = plan.bookingId
    ? `${customer ?? "Custom trip"} · ${pax} traveller${pax === 1 ? "" : "s"}`
    : plan.status === "BOOKED"
      ? toTicket
        ? `New travellers to ticket (${newNames})`
        : "Group departure · all ticketed"
      : "Group departure";

  // Trend: the shown best option's snapshots over the last 14 days.
  const since = now.getTime() - FARE_WINDOW_DAYS * 86_400_000;
  const trendOpt = shownBest ? plan.options.find((o) => o.id === shownBest.id) : undefined;
  const snaps = trendOpt?.fareSnapshots.filter((s) => s.capturedAt.getTime() >= since) ?? [];
  const trend =
    snaps.length >= 2
      ? { title: `${plan.origin} → ${plan.destination}`, fares: snaps.map((s) => s.farePerPax), today: snaps.at(-1)!.farePerPax, rise: snaps.at(-1)!.farePerPax - snaps[0]!.farePerPax }
      : null;

  const split =
    kind !== "flight" && toTicket
      ? pnrSplit(parties).map((g, i) => ({ label: g.label, count: g.passengers.length, text: irctcPassengerText(g, i + 1) }))
      : [];

  return {
    id: plan.id,
    label: plan.label,
    who,
    dateLabel: formatDate(plan.travelDate, "EEE d MMM"),
    travelDate: istDateStringOf(plan.travelDate),
    origin: plan.origin,
    destination: plan.destination,
    departureId: plan.departureId,
    bookingId: plan.bookingId,
    note: plan.note,
    status: plan.status,
    kind,
    budgetPerPax: plan.budgetPerPax,
    pax,
    toTicket,
    ticketedPax,
    options: ranked.map((o) => ({
      id: o.id,
      mode: o.mode,
      title: o.title,
      details: o.details,
      ticketPerPax: o.ticketPerPax,
      extrasPerPax: o.extrasPerPax,
      extrasNote: o.extrasNote,
      tags: o.tags,
      disqualified: o.disqualified,
      disqualifiedReason: o.disqualifiedReason,
      landed: o.landed,
      vsBudget: o.vsBudget,
      best: !!shownBest && o.id === shownBest.id,
      booked: locked && o.id === plan.bookedOptionId,
    })),
    best: shownBest ? { id: shownBest.id, title: shownBest.title, landed: shownBest.landed } : null,
    extraProfit: role === "OWNER" ? (locked && shownBest ? (plan.budgetPerPax - shownBest.landed) * pax : extraProfit) : null,
    locked,
    windowOpens: plan.windowOpensAt && plan.status !== "BOOKED" ? { label: formatIST(plan.windowOpensAt, "EEE d MMM, h:mm a"), short: formatIST(plan.windowOpensAt, "d MMM") } : null,
    trend,
    split,
    tickets: plan.tickets.map((t) => ({ idx: t.idx, label: t.label, count: Array.isArray(t.passengers) ? (t.passengers as unknown as Passenger[]).length : 0, pnr: t.pnr, documentId: t.documentId })),
  };
}

export async function getTicketsDesk(role: Role, selected: string | null, now: Date = new Date()) {
  const today = todayIST(now);
  const plans = await loadPlans({ OR: [{ travelDate: { gte: today } }, { status: { not: "BOOKED" } }] });
  const views = await Promise.all(plans.map((p) => buildPlan(p, role, now)));
  const plan = views.find((v) => v.id === selected) ?? views[0] ?? null;
  return { plans: views.map((v) => ({ id: v.id, label: v.label })), plan, alerts: await withReadiness(alertsOf(plans, views, now)) };
}

function alertsOf(plans: LoadedPlan[], views: PlanView[], now: Date): DeskAlerts {
  const today = todayIST(now);
  const byId = new Map(views.map((v) => [v.id, v]));

  // 1. Train window: the next one to open.
  const nextWindow = plans
    .filter((p) => p.status !== "BOOKED" && p.windowOpensAt && p.windowOpensAt > now && byId.get(p.id)?.kind === "window")
    .sort((a, b) => a.windowOpensAt!.getTime() - b.windowOpensAt!.getTime())[0];
  let window: DeskAlerts["window"] = null;
  if (nextWindow) {
    const v = byId.get(nextWindow.id)!;
    const opens = nextWindow.windowOpensAt!;
    const eve = new Date(opens.getTime() - 11 * 3_600_000);
    window = {
      planId: v.id,
      title: `${head(v.label)} ${formatDate(nextWindow.travelDate)}`,
      opens: formatIST(opens, "EEE d MMM, h:mm a"),
      days: Math.max(0, daysBetween(today, todayIST(opens))),
      ready: 0,
      total: v.pax,
      remind: `${formatIST(eve, "d MMM, h a")} and ${formatIST(new Date(opens.getTime() - 15 * 60_000), "d MMM, h:mm a")}`,
    };
  }

  // 2. Fare rising: the steepest ≥5% rise among plans still to book.
  let fare: DeskAlerts["fare"] = null;
  for (const p of plans) {
    if (p.status === "BOOKED" || p.travelDate < today) continue;
    for (const o of p.options) {
      if (o.disqualified) continue;
      const a = fareAlert(o.fareSnapshots, now);
      if (!a || (fare && fare.riseBps >= a.riseBps)) continue;
      const who = p.booking ? `${shortName(p.booking.customer.name)}, ${formatDate(p.travelDate)}` : formatDate(p.travelDate);
      const under = p.budgetPerPax - (a.to + o.extrasPerPax) >= 0;
      fare = { planId: p.id, rise: a.rise, riseBps: a.riseBps, underBudget: under, text: `${p.destination} (${who}): ${p.origin} → ${p.destination}` };
    }
  }

  // 3. New travellers on group departures already ticketed.
  const groupBooked = views.filter((v) => v.departureId && v.status === "BOOKED");
  const waiting = groupBooked.filter((v) => v.toTicket > 0);
  const count = waiting.reduce((n, v) => n + v.toTicket, 0);
  const first = waiting[0] ?? groupBooked[0] ?? null;
  const name = (v: PlanView) => `${head(v.label)} ${formatDate(new Date(`${v.travelDate}T00:00:00Z`))}`;
  const text = !first
    ? "No group departure has tickets booked yet."
    : count
      ? `${name(first)}: ${count} new traveller${count === 1 ? "" : "s"} (${first.split.map((s) => s.label).join(", ") || first.who}) ${count === 1 ? "isn't" : "aren't"} ticketed yet.`
      : `${name(first)}: all ${first.ticketedPax} travellers are ticketed.`;

  return { window, fare, newTravellers: { planId: first?.id ?? null, count, text } };
}

/** Fills window.ready (travellers with age + gender, as IRCTC needs). Kept separate: one extra query. */
async function withReadiness(alerts: DeskAlerts): Promise<DeskAlerts> {
  if (!alerts.window) return alerts;
  const plan = await db.travelPlan.findUnique({ where: { id: alerts.window.planId }, select: { bookingId: true, departureId: true } });
  if (!plan) return alerts;
  const bookings = await planBookings(plan);
  const ready = bookings.reduce((n, b) => n + b.travellers.filter((t) => t.age != null && !!t.gender).length, 0);
  return { ...alerts, window: { ...alerts.window, ready } };
}

export async function getPlanForm(now: Date = new Date()): Promise<PlanForm> {
  const today = todayIST(now);
  const [deps, customs] = await Promise.all([
    db.departure.findMany({ where: { startDate: { gte: today }, status: { not: "CANCELLED" } }, orderBy: { startDate: "asc" }, include: { trip: { select: { name: true, destination: true } } } }),
    db.booking.findMany({
      where: { kind: "CUSTOM", status: { not: "CANCELLED" }, OR: [{ customStartDate: { gte: today } }, { customStartDate: null }] },
      orderBy: { customStartDate: "asc" },
      select: { id: true, code: true, customTitle: true, customStartDate: true, customer: { select: { name: true } } },
    }),
  ]);
  return {
    departures: deps.map((d) => ({ id: d.id, label: `${d.trip.name} · ${formatDate(d.startDate)} (${d.code})`, destination: d.trip.destination, startDate: istDateStringOf(d.startDate), budget: d.travelBudgetPerPax })),
    bookings: customs.map((b) => ({ id: b.id, label: `${b.customTitle ?? b.customer.name} (${b.code})`, startDate: b.customStartDate ? istDateStringOf(b.customStartDate) : null })),
  };
}
