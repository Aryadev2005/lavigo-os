/**
 * Today → Needs you (TOD-2) sources for the Tickets desk:
 *  - fare alerts (TKT-4): a fare up ≥ 5% in 14 days, or travel within 21 days and still not booked;
 *  - train windows (TKT-5) opening within 7 days.
 * Extra profit is shown to OWNER only.
 */
import type { Role } from "@prisma/client";
import type { NeedItem } from "../dashboard";
import { db } from "../../db";
import { inr, pct } from "../../money";
import { daysBetween, formatIST, todayIST } from "../../time";
import { fareAlert, FARE_WINDOW_DAYS, unticketed } from "./core";
import { planBookings, ticketedPassengers } from "./index";

export const FARE_BOOK_WITHIN_DAYS = 21; // travel this close and not booked → alert
export const WINDOW_NOTICE_DAYS = 7;

export async function ticketNeeds(role: Role, now: Date = new Date()): Promise<NeedItem[]> {
  const today = todayIST(now);
  const plans = await db.travelPlan.findMany({
    where: { status: { not: "BOOKED" }, travelDate: { gte: today } },
    orderBy: { travelDate: "asc" },
    include: {
      booking: { select: { customer: { select: { name: true } } } },
      options: { where: { disqualified: false }, include: { fareSnapshots: { orderBy: { capturedAt: "asc" } } } },
      tickets: { select: { status: true, passengers: true } },
    },
  });

  const out: NeedItem[] = [];
  for (const plan of plans) {
    const who = plan.booking?.customer.name ? `${plan.booking.customer.name} family` : plan.label;
    const pax = async () => unticketed(await planBookings(plan), ticketedPassengers(plan.tickets)).reduce((n, p) => n + p.passengers.length, 0);

    // Train window opening within a week.
    if (plan.status === "WINDOW_PENDING" && plan.windowOpensAt && plan.windowOpensAt > now) {
      const days = daysBetween(today, todayIST(plan.windowOpensAt));
      if (days <= WINDOW_NOTICE_DAYS) {
        const n = await pax();
        out.push({
          key: `window:${plan.id}`,
          icon: "🚆",
          tone: "warn",
          title: `Train bookings for ${plan.label} open ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`,
          detail: `${formatIST(plan.windowOpensAt, "EEE d MMM, h:mm a")} · ${n} traveller${n === 1 ? "" : "s"} to book · reminders the evening before and at 7:45 AM`,
          action: { label: "Plan", href: `/tickets?plan=${plan.id}` },
        });
      }
      continue;
    }

    // Fare rising, or travel close and nothing booked.
    const rising = plan.options
      .map((o) => ({ o, a: fareAlert(o.fareSnapshots, now) }))
      .filter((x): x is { o: (typeof plan.options)[number]; a: NonNullable<ReturnType<typeof fareAlert>> } => !!x.a)
      .sort((x, y) => y.a.riseBps - x.a.riseBps)[0];
    const daysToTravel = daysBetween(today, plan.travelDate);
    const urgent = daysToTravel <= FARE_BOOK_WITHIN_DAYS && plan.options.length > 0;
    if (!rising && !urgent) continue;

    const mode = (rising?.o.mode ?? plan.options[0]?.mode ?? "FLIGHT").toLowerCase();
    const parts = [who];
    if (rising) parts.push(`up ${pct(rising.a.riseBps, 0)} in ${FARE_WINDOW_DAYS} days`);
    if (rising && role === "OWNER") {
      const keep = (plan.budgetPerPax - rising.a.to - rising.o.extrasPerPax) * (await pax());
      if (keep > 0) parts.push(`booking today keeps ${inr(keep)} extra profit`);
    }
    if (!rising) parts.push(`travel in ${daysToTravel} days, tickets not booked`);
    out.push({
      key: `fare:${plan.id}`,
      icon: "✈",
      tone: "lav",
      title: rising ? `${plan.destination} ${mode} fare is rising: book soon` : `${plan.destination}: book ${mode} tickets now`,
      detail: parts.join(" · "),
      action: { label: "Open", href: `/tickets?plan=${plan.id}` },
    });
  }
  return out;
}
