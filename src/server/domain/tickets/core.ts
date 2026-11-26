/**
 * Tickets desk, pure core (SRS §4.8, DFD 7.3–7.6). No I/O, no clock: callers pass `now`.
 * Money is integer paise; percentages are basis points.
 */
import { toBps } from "../../money";
import { addDays, dateOnly, istDateString, istDateStringOf, istDateTime } from "../../time";

// ───────────────────────────── 7.3 rank by landed cost (TKT-3) ─────────────────────────────

export type OptionLike = { ticketPerPax: number; extrasPerPax: number; disqualified: boolean };

/** Real cost per person: the ticket plus hidden extras (cab, extra night, meals). */
export const landed = (o: { ticketPerPax: number; extrasPerPax: number }): number => o.ticketPerPax + o.extrasPerPax;

export type Ranked<T> = T & { landed: number; /** budget − landed, per person (+ is under budget). */ vsBudget: number };

export type Ranking<T> = {
  /** Ascending by landed cost; ties keep input order. */
  ranked: Ranked<T>[];
  /** Cheapest non-disqualified option, or null when every option is disqualified. */
  best: Ranked<T> | null;
  /** (budget − best landed) × pax. Negative when even the best is over budget. */
  extraProfit: number;
};

export function rankOptions<T extends OptionLike>(options: readonly T[], budgetPerPax: number, pax: number): Ranking<T> {
  const ranked = options
    .map((o, i) => ({ o: { ...o, landed: landed(o), vsBudget: budgetPerPax - landed(o) } as Ranked<T>, i }))
    .sort((a, b) => a.o.landed - b.o.landed || a.i - b.i)
    .map((x) => x.o);
  const best = ranked.find((o) => !o.disqualified) ?? null;
  return { ranked, best, extraProfit: best ? (budgetPerPax - best.landed) * pax : 0 };
}

// ───────────────────────────── 7.5 train booking window (TKT-5) ─────────────────────────────

/** IRCTC advance reservation: bookings open `arpDays` before travel, at 08:00 IST. */
export function windowOpensAt(travelDate: Date, arpDays: number): Date {
  return istDateTime(istDateStringOf(addDays(travelDate, -arpDays)), "08:00");
}

/** Owner reminders: the evening before (21:00 IST) and 15 minutes before opening (07:45 IST). */
export function windowReminderTimes(opensAt: Date): { kind: "eve" | "morning"; at: Date }[] {
  const day = istDateString(opensAt);
  return [
    { kind: "eve", at: istDateTime(istDateStringOf(addDays(dateOnly(day), -1)), "21:00") },
    { kind: "morning", at: istDateTime(day, "07:45") },
  ];
}

// ───────────────────────────── 7.4 fare-rise alert (TKT-4) ─────────────────────────────

export const FARE_RISE_BPS = 500; // ≥ 5%
export const FARE_WINDOW_DAYS = 14;

export type Snapshot = { farePerPax: number; capturedAt: Date };
export type FareAlert = { from: number; to: number; rise: number; riseBps: number };

/**
 * Rise from the first to the latest fare inside the last 14 days. An alert when it is ≥ 5%.
 * Needs at least two snapshots in the window.
 */
export function fareAlert(snapshots: readonly Snapshot[], now: Date): FareAlert | null {
  const since = now.getTime() - FARE_WINDOW_DAYS * 86_400_000;
  const inWindow = snapshots
    .filter((s) => s.capturedAt.getTime() >= since && s.capturedAt.getTime() <= now.getTime())
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  if (inWindow.length < 2) return null;
  const from = inWindow[0]!.farePerPax;
  const to = inWindow.at(-1)!.farePerPax;
  if (from <= 0 || to <= from) return null;
  const riseBps = toBps(to - from, from);
  return riseBps >= FARE_RISE_BPS ? { from, to, rise: to - from, riseBps } : null;
}

// ───────────────────────────── 7.6 PNR split (TKT-6) ─────────────────────────────

export const MAX_PER_TICKET = 6;

export type Passenger = {
  bookingId: string;
  travellerId: string | null;
  fullName: string;
  age: number | null;
  gender: string | null;
  berthPref: string | null;
};

export type BookingParty = { bookingId: string; label: string; passengers: Passenger[] };
export type TicketPlan = { label: string; passengers: Passenger[] };

/**
 * First-fit decreasing by booking size, max 6 per ticket. A booking of ≤ 6 is never split. A larger
 * booking fills whole tickets of 6, then its remainder opens the very next ticket (so its tickets are
 * consecutive), which smaller bookings may then share. Ties keep input order (stable).
 */
export function pnrSplit(parties: readonly BookingParty[], max = MAX_PER_TICKET): TicketPlan[] {
  const order = parties
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.passengers.length > 0)
    .sort((a, b) => b.p.passengers.length - a.p.passengers.length || a.i - b.i)
    .map((x) => x.p);

  type Bin = { parts: { label: string; part?: string }[]; passengers: Passenger[] };
  const bins: Bin[] = [];
  for (const p of order) {
    const n = p.passengers.length;
    if (n > max) {
      const chunks = Math.ceil(n / max);
      for (let k = 0; k < chunks; k++) {
        bins.push({ parts: [{ label: p.label, part: `${k + 1} of ${chunks}` }], passengers: p.passengers.slice(k * max, (k + 1) * max) });
      }
      continue;
    }
    const bin = bins.find((b) => b.passengers.length + n <= max);
    if (bin) {
      bin.parts.push({ label: p.label });
      bin.passengers.push(...p.passengers);
    } else bins.push({ parts: [{ label: p.label }], passengers: [...p.passengers] });
  }
  return bins.map((b) => ({
    label: b.parts.map((x) => (x.part ? `${x.label} (${x.part})` : x.label)).join(" + "),
    passengers: b.passengers,
  }));
}

/** "Riya Sinha's family" for a party, "Riya Sinha" for one person. */
export function partyLabel(leadName: string, size: number): string {
  return size > 1 ? `${leadName}'s family` : leadName;
}

const GENDER: Record<string, string> = { M: "Male", F: "Female", O: "Transgender" };
const BERTH: Record<string, string> = { LB: "Lower", MB: "Middle", UB: "Upper", SL: "Side lower", SU: "Side upper" };

/** IRCTC-ready passenger list: one line per passenger, in IRCTC's field order. */
export function irctcPassengerText(group: { label: string; passengers: readonly Passenger[] }, ticketNo?: number): string {
  const head = `${ticketNo ? `Ticket ${ticketNo} · ` : ""}${group.label} · ${group.passengers.length} passenger${group.passengers.length === 1 ? "" : "s"}`;
  const lines = group.passengers.map((p, i) => {
    const gender = p.gender ? (GENDER[p.gender.toUpperCase()] ?? p.gender) : "Gender ?";
    const berth = p.berthPref ? (BERTH[p.berthPref.toUpperCase()] ?? p.berthPref) : "No preference";
    return `${i + 1}. ${p.fullName}, ${p.age ?? "Age ?"}, ${gender}, ${berth}`;
  });
  return [head, ...lines].join("\n");
}

// ───────────────────────────── who still needs a ticket ─────────────────────────────

export type BookingForTickets = {
  id: string;
  code: string;
  pax: number;
  customerName: string;
  travellers: { id: string; fullName: string; age: number | null; gender: string | null; berthPref: string | null; isLead: boolean }[];
};

/**
 * Parties still to ticket: each booking's pax minus the passengers already on a booked ticket.
 * Travellers without details yet become placeholders, so the split still counts every seat.
 */
export function unticketed(bookings: readonly BookingForTickets[], ticketed: readonly Passenger[]): BookingParty[] {
  const done = new Map<string, { count: number; ids: Set<string> }>();
  for (const p of ticketed) {
    const d = done.get(p.bookingId) ?? { count: 0, ids: new Set<string>() };
    d.count += 1;
    if (p.travellerId) d.ids.add(p.travellerId);
    done.set(p.bookingId, d);
  }
  const out: BookingParty[] = [];
  for (const b of bookings) {
    const d = done.get(b.id);
    const left = b.pax - (d?.count ?? 0);
    if (left <= 0) continue;
    const named: Passenger[] = b.travellers
      .filter((t) => !d?.ids.has(t.id))
      .slice(0, left)
      .map((t) => ({ bookingId: b.id, travellerId: t.id, fullName: t.fullName, age: t.age, gender: t.gender, berthPref: t.berthPref }));
    const pad: Passenger[] = Array.from({ length: left - named.length }, (_, k) => ({
      bookingId: b.id,
      travellerId: null,
      fullName: `Traveller ${b.pax - left + named.length + k + 1} of ${b.code} (details pending)`,
      age: null,
      gender: null,
      berthPref: null,
    }));
    const lead = b.travellers.find((t) => t.isLead)?.fullName ?? b.customerName;
    out.push({ bookingId: b.id, label: partyLabel(lead, b.pax), passengers: [...named, ...pad] });
  }
  return out;
}

/** A stable fingerprint of a split, to detect that it changed between preview and confirm. */
export const splitSignature = (groups: readonly TicketPlan[]) => groups.map((g) => g.passengers.map((p) => `${p.bookingId}:${p.travellerId ?? "-"}`).join(",")).join("|");

/** Hidden extras become their own expense: TRANSPORT when the note is about getting around, else OTHER. */
export function extrasCategory(note: string | null): "TRANSPORT" | "OTHER" {
  return note && /\b(cabs?|transfers?|taxis?|bus(es)?)\b/i.test(note) ? "TRANSPORT" : "OTHER";
}
