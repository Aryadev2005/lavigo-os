/**
 * Tickets desk mutations (SRS §4.8, DFD 7.1–7.7). Callers (server actions, jobs) enforce auth;
 * every write here is audited. Ranking, split and window maths live in the pure ./core.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, Role, TravelMode } from "@prisma/client";
import { audit } from "../../audit";
import { MAX_MEDIA_BYTES, sniffMime } from "../../channels/media";
import { db } from "../../db";
import { env } from "../../env";
import { getFareProvider } from "../../fares";
import { inr } from "../../money";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import { getStorage } from "../../storage/s3";
import { dateOnly, todayIST } from "../../time";
import { pnrSplit, rankOptions, splitSignature, unticketed, windowOpensAt, type BookingForTickets, type Passenger, type TicketPlan } from "./core";

export type Actor = { id: string; role: Role };

export class TicketError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID" | "ALREADY_BOOKED" | "CHANGED" | "WINDOW_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

/** A seeded / hand-entered TICKETS expense ending with this is a budget placeholder: booking replaces it. */
export const BUDGETED_MARK = "(budgeted)";
/** Total upload per confirm (next.config serverActions.bodySizeLimit is a little above this). */
export const MAX_UPLOAD_TOTAL = 20 * 1024 * 1024;

type Tx = Prisma.TransactionClient;

export async function activity(icon: string, text: string, type: string, entityId: string, actorType: "USER" | "SYSTEM" = "USER") {
  const a = await db.activityEvent.create({ data: { type, icon, text, actorType, entityType: "TravelPlan", entityId } });
  await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
}

// ───────────────────────────── who travels on a plan ─────────────────────────────

/** The custom booking, or every confirmed booking on the departure (holds aren't ticketed). */
export async function planBookings(plan: { bookingId: string | null; departureId: string | null }, client: Tx | typeof db = db): Promise<(BookingForTickets & { customerId: string; conversationId: string | null })[]> {
  const where: Prisma.BookingWhereInput | null = plan.bookingId
    ? { id: plan.bookingId, status: { not: "CANCELLED" } }
    : plan.departureId
      ? { departureId: plan.departureId, status: { in: ["CONFIRMED", "COMPLETED"] } }
      : null;
  if (!where) return [];
  const rows = await client.booking.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      pax: true,
      customerId: true,
      conversationId: true,
      customer: { select: { name: true } },
      travellers: { orderBy: [{ isLead: "desc" }, { createdAt: "asc" }], select: { id: true, fullName: true, age: true, gender: true, berthPref: true, isLead: true } },
    },
  });
  return rows.map((b) => ({ id: b.id, code: b.code, pax: b.pax, customerId: b.customerId, conversationId: b.conversationId, customerName: b.customer.name, travellers: b.travellers }));
}

export const ticketedPassengers = (groups: { status: string; passengers: Prisma.JsonValue }[]): Passenger[] =>
  groups.filter((g) => g.status === "BOOKED").flatMap((g) => (Array.isArray(g.passengers) ? (g.passengers as unknown as Passenger[]) : []));

/** The split for everyone not yet ticketed on this plan (the "Booking plan" card). */
export async function pendingSplit(planId: string, client: Tx | typeof db = db): Promise<{ groups: TicketPlan[]; bookings: Awaited<ReturnType<typeof planBookings>> }> {
  const plan = await client.travelPlan.findUnique({ where: { id: planId }, include: { tickets: { select: { status: true, passengers: true } } } });
  if (!plan) throw new TicketError("NOT_FOUND", "Plan not found");
  const bookings = await planBookings(plan, client);
  return { groups: pnrSplit(unticketed(bookings, ticketedPassengers(plan.tickets))), bookings };
}

// ───────────────────────────── 7.1 plans (TKT-1) ─────────────────────────────

export type PlanInput = {
  label: string;
  departureId: string | null;
  bookingId: string | null;
  origin: string;
  destination: string;
  /** YYYY-MM-DD (IST calendar date) */
  travelDate: string;
  budgetPerPax: number;
  note: string | null;
};

export async function savePlan(planId: string | null, input: PlanInput, actor: Actor): Promise<{ id: string }> {
  if (!!input.departureId === !!input.bookingId) throw new TicketError("INVALID", "Pick a departure or a custom booking");
  if (!Number.isSafeInteger(input.budgetPerPax) || input.budgetPerPax < 0) throw new TicketError("INVALID", "Enter the travel budget per person");
  let travelDate: Date;
  try {
    travelDate = dateOnly(input.travelDate);
  } catch {
    throw new TicketError("INVALID", "Enter the travel date");
  }
  if (input.departureId && !(await db.departure.findUnique({ where: { id: input.departureId }, select: { id: true } }))) throw new TicketError("NOT_FOUND", "Departure not found");
  if (input.bookingId && !(await db.booking.findUnique({ where: { id: input.bookingId }, select: { id: true } }))) throw new TicketError("NOT_FOUND", "Booking not found");

  const data = {
    label: input.label.trim(),
    departureId: input.departureId,
    bookingId: input.bookingId,
    origin: input.origin.trim(),
    destination: input.destination.trim(),
    travelDate,
    budgetPerPax: input.budgetPerPax,
    note: input.note?.trim() || null,
  };
  if (!data.label || !data.origin || !data.destination) throw new TicketError("INVALID", "Fill in the name, from and to");

  let id: string;
  if (planId) {
    const before = await db.travelPlan.findUnique({ where: { id: planId } });
    if (!before) throw new TicketError("NOT_FOUND", "Plan not found");
    if (before.status === "BOOKED" && (before.departureId !== data.departureId || before.bookingId !== data.bookingId)) {
      throw new TicketError("INVALID", "A booked plan stays on its departure or booking");
    }
    await db.travelPlan.update({ where: { id: planId }, data });
    await audit({ userId: actor.id, action: "travel_plan.update", entityType: "TravelPlan", entityId: planId, before: { ...before, travelDate: before.travelDate.toISOString() }, after: input });
    id = planId;
  } else {
    id = (await db.travelPlan.create({ data })).id;
    await audit({ userId: actor.id, action: "travel_plan.create", entityType: "TravelPlan", entityId: id, after: input });
  }
  await refreshWindow(id);
  return { id };
}

export async function deletePlan(planId: string, actor: Actor) {
  const plan = await db.travelPlan.findUnique({ where: { id: planId }, include: { _count: { select: { tickets: true } } } });
  if (!plan) throw new TicketError("NOT_FOUND", "Plan not found");
  if (plan.status === "BOOKED" || plan._count.tickets > 0) throw new TicketError("INVALID", "Booked plans can't be deleted");
  await db.travelPlan.delete({ where: { id: planId } });
  await audit({ userId: actor.id, action: "travel_plan.delete", entityType: "TravelPlan", entityId: planId, before: { label: plan.label } });
}

/**
 * Trains: store windowOpensAt (travel − ARP days, 08:00 IST) and hold the plan at WINDOW_PENDING
 * until it opens. Driven by the best option; a booked plan is left alone.
 */
export async function refreshWindow(planId: string, now: Date = new Date()) {
  const plan = await db.travelPlan.findUnique({ where: { id: planId }, include: { options: true } });
  if (!plan || plan.status === "BOOKED") return;
  const best = rankOptions(plan.options, plan.budgetPerPax, 0).best;
  const opens = best?.mode === "TRAIN" ? windowOpensAt(plan.travelDate, env.IRCTC_ARP_DAYS) : null;
  const status = opens && opens > now ? "WINDOW_PENDING" : "PLANNING";
  if (plan.status !== status || plan.windowOpensAt?.getTime() !== opens?.getTime()) {
    await db.travelPlan.update({ where: { id: planId }, data: { status, windowOpensAt: opens } });
  }
}

// ───────────────────────────── 7.1 / 7.2 options + fare snapshots (TKT-2, TKT-4, TKT-8) ─────────────────────────────

export type OptionInput = {
  mode: TravelMode;
  title: string;
  details: string;
  ticketPerPax: number;
  extrasPerPax: number;
  extrasNote: string | null;
  tags: string[];
  disqualified: boolean;
  disqualifiedReason: string | null;
};

export async function saveOption(planId: string, optionId: string | null, input: OptionInput, actor: Actor): Promise<{ id: string; snapshot: boolean }> {
  for (const v of [input.ticketPerPax, input.extrasPerPax]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new TicketError("INVALID", "Fares are whole rupees, zero or more");
  }
  if (input.ticketPerPax <= 0) throw new TicketError("INVALID", "Enter the ticket fare per person");
  if (!input.title.trim()) throw new TicketError("INVALID", "Give the option a name");
  const plan = await db.travelPlan.findUnique({ where: { id: planId }, select: { id: true } });
  if (!plan) throw new TicketError("NOT_FOUND", "Plan not found");
  const source = getFareProvider().source;
  const data = {
    mode: input.mode,
    title: input.title.trim(),
    details: input.details.trim(),
    ticketPerPax: input.ticketPerPax,
    extrasPerPax: input.extrasPerPax,
    extrasNote: input.extrasPerPax ? input.extrasNote?.trim() || null : null,
    tags: input.tags.map((t) => t.trim()).filter(Boolean).slice(0, 6),
    disqualified: input.disqualified,
    disqualifiedReason: input.disqualified ? input.disqualifiedReason?.trim() || "Not suitable" : null,
    source,
  };

  const out = await db.$transaction(async (tx) => {
    if (optionId) {
      const before = await tx.travelOption.findFirst({ where: { id: optionId, planId } });
      if (!before) throw new TicketError("NOT_FOUND", "Option not found");
      await tx.travelOption.update({ where: { id: optionId }, data });
      // 7.2: every fare change is a snapshot (the trend and the fare-rise alert read these).
      const changed = before.ticketPerPax !== data.ticketPerPax;
      if (changed) await tx.fareSnapshot.create({ data: { optionId, farePerPax: data.ticketPerPax, source } });
      await audit({ userId: actor.id, action: "travel_option.update", entityType: "TravelOption", entityId: optionId, before: { ticketPerPax: before.ticketPerPax, extrasPerPax: before.extrasPerPax, disqualified: before.disqualified }, after: input }, tx);
      return { id: optionId, snapshot: changed };
    }
    const created = await tx.travelOption.create({ data: { ...data, planId } });
    await tx.fareSnapshot.create({ data: { optionId: created.id, farePerPax: data.ticketPerPax, source } });
    await audit({ userId: actor.id, action: "travel_option.create", entityType: "TravelOption", entityId: created.id, after: input }, tx);
    return { id: created.id, snapshot: true };
  });
  await refreshWindow(planId);
  return out;
}

export async function deleteOption(optionId: string, actor: Actor) {
  const o = await db.travelOption.findUnique({ where: { id: optionId }, include: { plan: { select: { id: true, bookedOptionId: true } } } });
  if (!o) throw new TicketError("NOT_FOUND", "Option not found");
  if (o.plan.bookedOptionId === o.id) throw new TicketError("INVALID", "This option was booked; it stays for the record");
  await db.travelOption.delete({ where: { id: optionId } });
  await audit({ userId: actor.id, action: "travel_option.delete", entityType: "TravelOption", entityId: optionId, before: { title: o.title, ticketPerPax: o.ticketPerPax } });
  await refreshWindow(o.plan.id);
}

// ───────────────────────────── 7.7 confirm booking (TKT-7) ─────────────────────────────

export type ConfirmInput = {
  planId: string;
  optionId: string;
  /** One per ticket in the current split, in order. */
  tickets: { pnr: string; file: { name: string; bytes: Uint8Array } | null }[];
};

export type ConfirmResult = {
  planId: string;
  pax: number;
  tickets: number;
  pnrs: string[];
  expenseId: string;
  amount: number;
  optionTitle: string;
};

const PNR = /^[A-Z0-9][A-Z0-9-]{4,14}$/;

/**
 * PNRs + ticket PDFs → TicketGroups BOOKED, plan BOOKED, one TICKETS expense (ticket × pax).
 * The split is recomputed under a row lock on the plan, so a double submit (or two people at once)
 * books once; the loser gets ALREADY_BOOKED. PDFs go to S3 first; sending happens in the worker.
 */
export async function confirmBooking(input: ConfirmInput, actor: Actor, now: Date = new Date()): Promise<ConfirmResult> {
  const pnrs = input.tickets.map((t) => t.pnr.trim().toUpperCase());
  if (!pnrs.length) throw new TicketError("INVALID", "Nothing to book");
  if (pnrs.some((p) => !PNR.test(p))) throw new TicketError("INVALID", "Enter a PNR for every ticket (letters and digits)");
  let total = 0;
  for (const t of input.tickets) {
    if (!t.file) continue;
    if (t.file.bytes.length > MAX_MEDIA_BYTES) throw new TicketError("INVALID", "Ticket PDFs up to 10 MB each");
    if (sniffMime(t.file.bytes) !== "application/pdf") throw new TicketError("INVALID", "Tickets must be PDF files");
    total += t.file.bytes.length;
  }
  if (total > MAX_UPLOAD_TOTAL) throw new TicketError("INVALID", "Upload up to 20 MB of tickets at a time");

  // Preview the split (unlocked) so the PDFs can be stored before the transaction.
  const preview = await pendingSplit(input.planId);
  if (!preview.groups.length) throw new TicketError("ALREADY_BOOKED", "Everyone on this plan already has tickets");
  if (preview.groups.length !== input.tickets.length) throw new TicketError("CHANGED", "The booking plan changed. Reload and try again.");
  const signature = splitSignature(preview.groups);
  const codeOf = new Map(preview.bookings.map((b) => [b.id, b.code]));

  // One stored copy per booking on the ticket, so each booking keeps its own PDF.
  const batch = randomUUID();
  const storage = getStorage();
  const files: { groupIndex: number; bookingId: string; key: string; fileName: string; size: number }[] = [];
  for (const [i, t] of input.tickets.entries()) {
    if (!t.file) continue;
    const bookingIds = [...new Set(preview.groups[i]!.passengers.map((p) => p.bookingId))];
    for (const bookingId of bookingIds) {
      const key = `tickets/${input.planId}/${batch}/t${i + 1}-${bookingId}.pdf`;
      await storage.put(key, Buffer.from(t.file.bytes), "application/pdf");
      files.push({ groupIndex: i, bookingId, key, fileName: `${codeOf.get(bookingId) ?? "ticket"}-ticket-${pnrs[i]}.pdf`, size: t.file.bytes.length });
    }
  }

  const result = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "TravelPlan" WHERE id = ${input.planId} FOR UPDATE`;
    if (!locked.length) throw new TicketError("NOT_FOUND", "Plan not found");
    const plan = await tx.travelPlan.findUniqueOrThrow({ where: { id: input.planId }, include: { options: true, tickets: true } });
    const option = plan.options.find((o) => o.id === input.optionId);
    if (!option) throw new TicketError("NOT_FOUND", "Option not found");
    if (option.mode === "TRAIN" && plan.windowOpensAt && plan.windowOpensAt > now) throw new TicketError("WINDOW_CLOSED", "Train bookings for this date haven't opened yet");

    const bookings = await planBookings(plan, tx);
    const groups = pnrSplit(unticketed(bookings, ticketedPassengers(plan.tickets)));
    if (!groups.length) throw new TicketError("ALREADY_BOOKED", "Everyone on this plan already has tickets");
    if (splitSignature(groups) !== signature) throw new TicketError("CHANGED", "The booking plan changed. Reload and try again.");

    const firstBooking = plan.tickets.length === 0;
    const startIdx = plan.tickets.reduce((m, g) => Math.max(m, g.idx), 0) + 1;
    const pax = groups.reduce((n, g) => n + g.passengers.length, 0);
    const docIds: { documentId: string; bookingId: string; groupIndex: number }[] = [];
    const groupIds: string[] = [];
    for (const [i, g] of groups.entries()) {
      const mine = files.filter((f) => f.groupIndex === i);
      const docs = [];
      for (const f of mine) {
        const d = await tx.document.create({
          data: { kind: "TICKET", bookingId: f.bookingId, departureId: plan.departureId, storageKey: f.key, fileName: f.fileName, mimeType: "application/pdf", sizeBytes: f.size },
        });
        docs.push(d);
        docIds.push({ documentId: d.id, bookingId: f.bookingId, groupIndex: i });
      }
      const created = await tx.ticketGroup.create({
        data: {
          planId: plan.id,
          idx: startIdx + i,
          label: g.label,
          passengers: g.passengers as unknown as Prisma.InputJsonValue,
          pnr: pnrs[i]!,
          status: "BOOKED",
          bookedAt: now,
          documentId: docs[0]?.id ?? null,
        },
      });
      groupIds.push(created.id);
    }
    await tx.travelPlan.update({ where: { id: plan.id }, data: { status: "BOOKED", bookedOptionId: option.id } });

    const amount = option.ticketPerPax * pax;
    const description = `${option.title} · ${pax} × ${inr(option.ticketPerPax)} · PNR ${[...new Set(pnrs)].join(", ")}`;
    const placeholder =
      firstBooking && plan.bookingId
        ? await tx.expense.findFirst({ where: { bookingId: plan.bookingId, category: "TICKETS", description: { endsWith: BUDGETED_MARK } }, orderBy: { createdAt: "asc" } })
        : null;
    const expense = placeholder
      ? await tx.expense.update({ where: { id: placeholder.id }, data: { amount, description, incurredOn: todayIST(now), createdById: actor.id } })
      : await tx.expense.create({
          data: { category: "TICKETS", amount, description, departureId: plan.departureId, bookingId: plan.bookingId, incurredOn: todayIST(now), createdById: actor.id },
        });
    await audit(
      {
        userId: actor.id,
        action: "travel_plan.book",
        entityType: "TravelPlan",
        entityId: plan.id,
        before: { status: plan.status, ...(placeholder ? { placeholderExpense: { id: placeholder.id, amount: placeholder.amount } } : {}) },
        after: { optionId: option.id, pax, tickets: groupIds, pnrs, expenseId: expense.id, amount },
      },
      tx,
    );
    return { plan, option, pax, groups, groupIds, docIds, expense, amount };
  });

  if (result.docIds.length) {
    await enqueue("tickets.send", { planId: input.planId, docs: result.docIds.map((d) => ({ ...d, pnr: pnrs[d.groupIndex]! })) }, { jobId: `tickets-send-${result.groupIds[0]}` });
  }
  const n = result.groups.length;
  await activity("🎫", `${result.pax} ticket${result.pax === 1 ? "" : "s"} booked for ${result.plan.label} · ${result.option.title.split(" · ")[0]} · PNR ${[...new Set(pnrs)].join(", ")}`, "tickets.booked", result.plan.id);
  return {
    planId: result.plan.id,
    pax: result.pax,
    tickets: n,
    pnrs,
    expenseId: result.expense.id,
    amount: result.amount,
    optionTitle: result.option.title,
  };
}
