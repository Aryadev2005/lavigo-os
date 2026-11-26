/** Departures page reads (DEP-1, DEP-2, DEP-4). */
import type { DepartureStatus } from "@prisma/client";
import { db } from "../../db";
import { daysBetween, formatDate, istDateStringOf, todayIST } from "../../time";
import { departureHealth, type DepartureHealth, type ItineraryDay } from "./index";

export type DepartureCard = {
  id: string;
  code: string;
  name: string;
  title: string;
  dateLabel: string;
  daysToGo: number;
  seats: number;
  sold: number;
  revenue: number;
  health: DepartureHealth;
  status: DepartureStatus;
  image: string | null;
  /** Latest campaign: how many it reached and how many booked from it (DEP-4). */
  campaign: { sentTo: number; converted: number; sentLabel: string } | null;
  travellers: number;
  confirmedBookings: number;
};

export async function listDepartureCards(now: Date = new Date()): Promise<DepartureCard[]> {
  const today = todayIST(now);
  const deps = await db.departure.findMany({
    where: { startDate: { gte: today }, status: { notIn: ["CANCELLED", "COMPLETED"] } },
    orderBy: { startDate: "asc" },
    include: {
      trip: { select: { name: true, title: true, heroImageKey: true } },
      bookings: { where: { status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } }, select: { pax: true, totalAmount: true, status: true, _count: { select: { travellers: true } } } },
      campaigns: {
        where: { status: { in: ["SENDING", "SENT"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { sentAt: true, createdAt: true, _count: { select: { recipients: { where: { status: "SENT" } } } }, recipients: { where: { convertedBookingId: { not: null } }, select: { id: true } } },
      },
    },
  });
  return deps.map((d) => {
    const sold = d.bookings.reduce((n, b) => n + b.pax, 0);
    const daysToGo = daysBetween(today, d.startDate);
    const c = d.campaigns[0];
    return {
      id: d.id,
      code: d.code,
      name: d.trip.name,
      title: d.trip.title,
      dateLabel: formatDate(d.startDate),
      daysToGo,
      seats: d.seatsTotal,
      sold,
      revenue: d.bookings.reduce((n, b) => n + b.totalAmount, 0),
      health: departureHealth(sold, d.seatsTotal, daysToGo),
      status: d.status,
      image: d.trip.heroImageKey ? `/${d.trip.heroImageKey}` : null,
      campaign: c ? { sentTo: c._count.recipients, converted: c.recipients.length, sentLabel: formatDate(c.sentAt ?? c.createdAt) } : null,
      travellers: d.bookings.reduce((n, b) => n + b._count.travellers, 0),
      confirmedBookings: d.bookings.filter((b) => b.status === "CONFIRMED").length,
    };
  });
}

export type TripForm = {
  id: string;
  name: string;
  title: string;
  destination: string;
  nights: number;
  days: number;
  summary: string;
  inclusions: string[];
  exclusions: string[];
  itinerary: ItineraryDay[];
  tags: string[];
  heroImageKey: string | null;
};

export type DepartureForm = {
  id: string;
  tripId: string;
  code: string;
  startDate: string;
  endDate: string;
  seatsTotal: number;
  pricePerPax: number;
  costPerPax: number;
  travelBudgetPerPax: number;
  usualRoomRate: number | null;
  status: DepartureStatus;
};

export async function getDepartureSheet(departureId: string | null): Promise<{ trips: TripForm[]; departure: DepartureForm | null }> {
  const [trips, dep] = await Promise.all([
    db.trip.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    departureId ? db.departure.findUnique({ where: { id: departureId } }) : null,
  ]);
  return {
    trips: trips.map((t) => ({
      id: t.id,
      name: t.name,
      title: t.title,
      destination: t.destination,
      nights: t.nights,
      days: t.days,
      summary: t.summary,
      inclusions: t.inclusions,
      exclusions: t.exclusions,
      itinerary: Array.isArray(t.itinerary) ? (t.itinerary as unknown as ItineraryDay[]) : [],
      tags: t.tags,
      heroImageKey: t.heroImageKey,
    })),
    departure: dep
      ? {
          id: dep.id,
          tripId: dep.tripId,
          code: dep.code,
          startDate: istDateStringOf(dep.startDate),
          endDate: istDateStringOf(dep.endDate),
          seatsTotal: dep.seatsTotal,
          pricePerPax: dep.pricePerPax,
          costPerPax: dep.costPerPax,
          travelBudgetPerPax: dep.travelBudgetPerPax,
          usualRoomRate: dep.usualRoomRate,
          status: dep.status,
        }
      : null,
  };
}
