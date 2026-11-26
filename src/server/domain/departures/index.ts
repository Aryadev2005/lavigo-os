/**
 * Departures (SRS §4.9): status rule (DEP-1), trip + departure CRUD (DEP-2), traveller list CSV
 * (DEP-5) and the document checklist (DEP-6). Callers enforce auth; writes are audited.
 */
import type { DepartureStatus, Prisma } from "@prisma/client";
import { audit } from "../../audit";
import { sendTemplate } from "../../channels/outbound";
import { db } from "../../db";
import { publish } from "../../pubsub";
import { dateOnly, daysBetween, formatDate, todayIST } from "../../time";
import type { Actor } from "./campaigns";

export class DepartureError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "DepartureError";
  }
}

// ───────────────────────────── DEP-1 status pill ─────────────────────────────

export type DepartureHealth = "NEEDS_SEATS" | "FILLING_WELL" | "ON_TRACK";

/** Needs seats: < 40% sold and < 90 days to go. Filling well: > 65% sold. Else on track. */
export function departureHealth(sold: number, seats: number, daysToGo: number): DepartureHealth {
  const pct = seats > 0 ? sold / seats : 0;
  if (pct < 0.4 && daysToGo < 90) return "NEEDS_SEATS";
  if (pct > 0.65) return "FILLING_WELL";
  return "ON_TRACK";
}

// ───────────────────────────── DEP-2 trips + departures ─────────────────────────────

export type ItineraryDay = { day: number; title: string; description: string };

export type TripInput = {
  name: string;
  title: string;
  destination: string;
  nights: number;
  days: number;
  summary: string;
  inclusions: string[];
  exclusions: string[];
  itinerary: { title: string; description: string }[];
  tags: string[];
  heroImageKey: string | null;
};

export const HERO_IMAGES = ["images/departures/nepal.jpg", "images/departures/netarhat.jpg", "images/departures/darjeeling.jpg", "images/departures/sikkim.jpg"] as const;

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "trip";

function tripData(input: TripInput) {
  if (!input.name.trim() || !input.title.trim() || !input.destination.trim()) throw new DepartureError("INVALID", "Fill in the trip name, title and destination");
  if (!Number.isInteger(input.days) || input.days < 1 || !Number.isInteger(input.nights) || input.nights < 0 || input.nights > input.days) throw new DepartureError("INVALID", "Check the days and nights");
  if (input.heroImageKey && !(HERO_IMAGES as readonly string[]).includes(input.heroImageKey)) throw new DepartureError("INVALID", "Pick one of the photos");
  const itinerary: ItineraryDay[] = input.itinerary
    .map((d) => ({ title: d.title.trim(), description: d.description.trim() }))
    .filter((d) => d.title)
    .map((d, i) => ({ day: i + 1, ...d }));
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  return {
    name: input.name.trim(),
    title: input.title.trim(),
    destination: input.destination.trim(),
    nights: input.nights,
    days: input.days,
    summary: input.summary.trim(),
    inclusions: clean(input.inclusions),
    exclusions: clean(input.exclusions),
    itinerary: itinerary as unknown as Prisma.InputJsonValue,
    tags: [...new Set(clean(input.tags).map((t) => t.toLowerCase()))],
    heroImageKey: input.heroImageKey,
  };
}

export async function saveTrip(tripId: string | null, input: TripInput, actor: Actor): Promise<{ id: string }> {
  const data = tripData(input);
  if (tripId) {
    const before = await db.trip.findUnique({ where: { id: tripId } });
    if (!before) throw new DepartureError("NOT_FOUND", "Trip not found");
    await db.trip.update({ where: { id: tripId }, data });
    await audit({ userId: actor.id, action: "trip.update", entityType: "Trip", entityId: tripId, before: { title: before.title, inclusions: before.inclusions, tags: before.tags }, after: input });
    return { id: tripId };
  }
  let slug = slugify(data.name);
  if (await db.trip.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;
  const t = await db.trip.create({ data: { ...data, slug } });
  await audit({ userId: actor.id, action: "trip.create", entityType: "Trip", entityId: t.id, after: input });
  return { id: t.id };
}

export type DepartureInput = {
  tripId: string;
  code: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  seatsTotal: number;
  pricePerPax: number; // paise
  /** Owner only. Staff never see or set the cost (CLAUDE.md: cost never reaches a staff session). */
  costPerPax: number | null;
  travelBudgetPerPax: number;
  usualRoomRate: number | null;
  status: DepartureStatus;
};

/**
 * DEP-2. Owner and staff both edit departures, but the cost is the owner's: a staff save keeps the
 * stored cost, and only the owner can create a departure (a new one needs a cost).
 */
export async function saveDeparture(departureId: string | null, raw: DepartureInput, actor: Actor): Promise<{ id: string }> {
  const existing = departureId ? await db.departure.findUnique({ where: { id: departureId }, select: { costPerPax: true } }) : null;
  if (departureId && !existing) throw new DepartureError("NOT_FOUND", "Departure not found");
  if (!departureId && actor.role !== "OWNER") throw new DepartureError("INVALID", "Only the owner can add a departure, because it needs the cost price");
  const costPerPax = actor.role === "OWNER" ? raw.costPerPax : (existing?.costPerPax ?? null);
  if (costPerPax === null) throw new DepartureError("INVALID", "Enter the cost per person");
  const input = { ...raw, costPerPax };
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new DepartureError("INVALID", "Codes are letters, digits and dashes, like NP-28N");
  let start: Date;
  let end: Date;
  try {
    start = dateOnly(input.startDate);
    end = dateOnly(input.endDate);
  } catch {
    throw new DepartureError("INVALID", "Enter the start and end dates");
  }
  if (end < start) throw new DepartureError("INVALID", "The trip ends before it starts");
  if (!Number.isInteger(input.seatsTotal) || input.seatsTotal < 1 || input.seatsTotal > 500) throw new DepartureError("INVALID", "Seats must be 1–500");
  for (const v of [input.pricePerPax, input.costPerPax, input.travelBudgetPerPax, input.usualRoomRate ?? 0]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new DepartureError("INVALID", "Amounts are whole rupees");
  }
  if (input.pricePerPax <= 0) throw new DepartureError("INVALID", "Enter the price per person");
  if (input.costPerPax >= input.pricePerPax) throw new DepartureError("INVALID", "The cost must be below the price");
  if (input.travelBudgetPerPax > input.costPerPax) throw new DepartureError("INVALID", "The travel budget is part of the cost, so it can't be more than the cost");
  if (!(await db.trip.findUnique({ where: { id: input.tripId }, select: { id: true } }))) throw new DepartureError("NOT_FOUND", "Trip not found");
  const clash = await db.departure.findUnique({ where: { code }, select: { id: true } });
  if (clash && clash.id !== departureId) throw new DepartureError("CONFLICT", `${code} is already used`);

  const data = {
    tripId: input.tripId,
    code,
    startDate: start,
    endDate: end,
    seatsTotal: input.seatsTotal,
    pricePerPax: input.pricePerPax,
    costPerPax: input.costPerPax,
    travelBudgetPerPax: input.travelBudgetPerPax,
    usualRoomRate: input.usualRoomRate,
    status: input.status,
  };
  if (departureId) {
    const before = await db.departure.findUnique({ where: { id: departureId } });
    if (!before) throw new DepartureError("NOT_FOUND", "Departure not found");
    const sold = (await db.booking.aggregate({ where: { departureId, status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } }, _sum: { pax: true } }))._sum.pax ?? 0;
    if (input.seatsTotal < sold) throw new DepartureError("INVALID", `${sold} seats are already sold`);
    await db.departure.update({ where: { id: departureId }, data });
    await audit({
      userId: actor.id,
      action: "departure.update",
      entityType: "Departure",
      entityId: departureId,
      before: { seatsTotal: before.seatsTotal, pricePerPax: before.pricePerPax, costPerPax: before.costPerPax, status: before.status },
      after: { ...input, code, byRole: actor.role },
    });
    return { id: departureId };
  }
  const d = await db.departure.create({ data });
  await audit({ userId: actor.id, action: "departure.create", entityType: "Departure", entityId: d.id, after: { ...input, code } });
  return { id: d.id };
}

// ───────────────────────────── DEP-5 traveller list CSV ─────────────────────────────

/**
 * One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab/CR) neutralised with a
 * single quote so spreadsheets don't run it as a formula (CSV injection).
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const TRAVELLER_CSV_HEADER = ["Name", "Age", "Gender", "Phone", "ID status", "Booking code", "Lead"] as const;

export async function travellerCsv(departureId: string, actor: Actor): Promise<{ fileName: string; csv: string; rows: number }> {
  const dep = await db.departure.findUnique({ where: { id: departureId }, select: { code: true } });
  if (!dep) throw new DepartureError("NOT_FOUND", "Departure not found");
  const bookings = await db.booking.findMany({
    where: { departureId, status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } },
    orderBy: [{ createdAt: "asc" }, { code: "asc" }],
    select: { code: true, customer: { select: { phone: true } }, travellers: { orderBy: [{ isLead: "desc" }, { createdAt: "asc" }] } },
  });
  const lines = [TRAVELLER_CSV_HEADER.map(csvCell).join(",")];
  for (const b of bookings) {
    for (const t of b.travellers) {
      lines.push([t.fullName, t.age, t.gender, t.phone ?? (t.isLead ? b.customer.phone : null), t.docStatus, b.code, t.isLead ? "yes" : ""].map(csvCell).join(","));
    }
  }
  // Traveller lists carry personal data: every export leaves a trail (NFR-5).
  await audit({ userId: actor.id, action: "departure.travellers_export", entityType: "Departure", entityId: departureId, after: { rows: lines.length - 1 } });
  return { fileName: `${dep.code}-travellers.csv`, csv: `﻿${lines.join("\r\n")}\r\n`, rows: lines.length - 1 };
}

// ───────────────────────────── DEP-6 document checklist ─────────────────────────────

export const CHECKLIST_TEMPLATE = "doc_checklist";
export const CHECKLIST_DOCUMENTS = "a photo ID for every traveller (Aadhaar, voter ID or passport) and their age";

/** doc_checklist to the lead traveller of every confirmed booking (the customer's WhatsApp). */
export async function sendChecklist(departureId: string, actor: Actor, now: Date = new Date()) {
  const dep = await db.departure.findUnique({ where: { id: departureId }, include: { trip: { select: { title: true, name: true } } } });
  if (!dep) throw new DepartureError("NOT_FOUND", "Departure not found");
  if (daysBetween(todayIST(now), dep.startDate) < 0) throw new DepartureError("INVALID", "This departure has already left");
  const bookings = await db.booking.findMany({
    where: { departureId, status: "CONFIRMED" },
    select: { id: true, customerId: true, conversationId: true, customer: { select: { name: true } }, travellers: { where: { isLead: true }, select: { fullName: true }, take: 1 } },
  });
  let sent = 0;
  const skipped: string[] = [];
  for (const b of bookings) {
    const name = (b.travellers[0]?.fullName ?? b.customer.name).split(/\s+/)[0]!;
    const r = await sendTemplate(b.conversationId ? { conversationId: b.conversationId } : { customerId: b.customerId }, CHECKLIST_TEMPLATE, {
      name,
      trip: dep.trip.title,
      date: formatDate(dep.startDate),
      documents: CHECKLIST_DOCUMENTS,
    }, { authorUserId: actor.id });
    if (r.sent) sent += 1;
    else skipped.push(r.reason);
  }
  await audit({ userId: actor.id, action: "departure.checklist_sent", entityType: "Departure", entityId: departureId, after: { sent, skipped: skipped.length } });
  if (sent) {
    const a = await db.activityEvent.create({
      data: { type: "documents.checklist_sent", icon: "📄", text: `Document checklist sent to ${sent} ${dep.trip.name} booking${sent === 1 ? "" : "s"}`, actorType: "USER", entityType: "Departure", entityId: departureId },
    });
    await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
  }
  return { sent, skipped: skipped.length, bookings: bookings.length };
}
