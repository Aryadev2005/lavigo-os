/**
 * Profit (SRS §4.10, PRF-1 … PRF-3). OWNER only: enforced here, not just on the page.
 *
 * Revenue = Σ booking totals (excluding cancelled). Cost = Σ actual Expense rows (every category)
 * once they are the whole story, else Σ planned cost (costTotalPlanned):
 *   - actual when the trip has ended, or when the bills already reach the plan;
 *   - otherwise planned, with what's been billed so far shown alongside.
 * A strict "actual as soon as one bill exists" would show a departure with only its train tickets
 * billed at an absurd margin (₹41k of tickets against ₹2.3L planned), so partial bills don't switch.
 */
import type { Role } from "@prisma/client";
import { db } from "../../db";
import { toBps } from "../../money";
import { formatDate, todayIST } from "../../time";

export class ForbiddenError extends Error {
  constructor() {
    super("Owner only");
    this.name = "ForbiddenError";
  }
}

export function assertOwner(actor: { role: Role }) {
  if (actor.role !== "OWNER") throw new ForbiddenError();
}

/** Below this margin the bar turns amber (PRF-2). */
export const LOW_MARGIN_BPS = 2000;

export type CostBasis = { cost: number; basis: "actual" | "planned"; billed: number };

/** PURE: which cost to use for a trip (see the header). */
export function costBasis(planned: number, actual: number | null, ended: boolean): CostBasis {
  if (actual !== null && (ended || actual >= planned)) return { cost: actual, basis: "actual", billed: actual };
  return { cost: planned, basis: "planned", billed: actual ?? 0 };
}

export type ProfitRow = {
  key: string;
  kind: "departure" | "custom";
  title: string;
  sub: string;
  revenue: number;
  cost: number;
  basis: "actual" | "planned";
  billed: number;
  profit: number;
  marginBps: number;
};

export type ProfitScope = "upcoming" | "recent" | "all";

export type ProfitBoard = {
  scope: ProfitScope;
  rows: ProfitRow[];
  revenue: number;
  cost: number;
  profit: number;
  marginBps: number;
  lowest: ProfitRow | null;
};

const RECENT_DAYS = 90;

export async function getProfitBoard(actor: { role: Role }, scope: ProfitScope = "upcoming", now: Date = new Date()): Promise<ProfitBoard> {
  assertOwner(actor);
  const today = todayIST(now);
  const from = scope === "upcoming" ? today : scope === "recent" ? new Date(today.getTime() - RECENT_DAYS * 86_400_000) : null;

  const [deps, customs] = await Promise.all([
    db.departure.findMany({
      where: { status: { not: "CANCELLED" }, ...(from ? { startDate: { gte: from } } : {}), bookings: { some: { status: { not: "CANCELLED" } } } },
      orderBy: { startDate: "asc" },
      include: {
        trip: { select: { title: true } },
        bookings: { where: { status: { not: "CANCELLED" } }, select: { pax: true, totalAmount: true, costTotalPlanned: true } },
        expenses: { select: { amount: true } },
      },
    }),
    db.booking.findMany({
      where: { kind: "CUSTOM", status: { not: "CANCELLED" }, ...(from ? { customStartDate: { gte: from } } : {}) },
      orderBy: { customStartDate: "asc" },
      select: { id: true, code: true, customTitle: true, customStartDate: true, status: true, pax: true, totalAmount: true, costTotalPlanned: true, expenses: { select: { amount: true } } },
    }),
  ]);

  const row = (r: Omit<ProfitRow, "profit" | "marginBps">): ProfitRow => ({ ...r, profit: r.revenue - r.cost, marginBps: r.revenue > 0 ? toBps(r.revenue - r.cost, r.revenue) : 0 });
  const rows: ProfitRow[] = [
    ...deps.map((d) => {
      const revenue = d.bookings.reduce((n, b) => n + b.totalAmount, 0);
      const planned = d.bookings.reduce((n, b) => n + b.costTotalPlanned, 0);
      const actual = d.expenses.length ? d.expenses.reduce((n, e) => n + e.amount, 0) : null;
      const pax = d.bookings.reduce((n, b) => n + b.pax, 0);
      return row({ key: d.id, kind: "departure", title: d.trip.title, sub: `${formatDate(d.startDate)} · ${pax} traveller${pax === 1 ? "" : "s"}`, revenue, ...costBasis(planned, actual, d.endDate < today || d.status === "COMPLETED") });
    }),
    ...customs.map((b) => {
      const actual = b.expenses.length ? b.expenses.reduce((n, e) => n + e.amount, 0) : null;
      const ended = b.status === "COMPLETED" || (!!b.customStartDate && b.customStartDate < today);
      return row({
        key: b.id,
        kind: "custom",
        title: `Custom · ${b.customTitle ?? b.code}`,
        sub: `${b.customStartDate ? formatDate(b.customStartDate) : "date to fix"} · ${b.pax} traveller${b.pax === 1 ? "" : "s"}`,
        revenue: b.totalAmount,
        ...costBasis(b.costTotalPlanned, actual, ended),
      });
    }),
  ];
  const revenue = rows.reduce((n, r) => n + r.revenue, 0);
  const cost = rows.reduce((n, r) => n + r.cost, 0);
  const lowest = rows.filter((r) => r.revenue > 0).sort((a, b) => a.marginBps - b.marginBps)[0] ?? null;
  return { scope, rows, revenue, cost, profit: revenue - cost, marginBps: revenue > 0 ? toBps(revenue - cost, revenue) : 0, lowest };
}
