/**
 * Booking reads for the Bookings screen (BKG-1, BKG-5) and global search (TOD-6).
 * Profit is computed only for OWNER (cost never reaches a STAFF session).
 */
import type { BookingSource, Prisma, Role } from "@prisma/client";
import { db } from "../../db";
import { inr } from "../../money";
import { daysBetween, formatDate, formatIST, todayIST } from "../../time";
import { daysLate } from "../dues/planner";

export const SOURCE_LABEL: Record<BookingSource, string> = {
  WEBSITE: "Website",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  WALK_IN: "Walk-in",
  PHONE: "Phone",
  AI_WHATSAPP: "WhatsApp",
  AI_INSTAGRAM: "Instagram",
  SANDBOX: "Sandbox",
} as Record<BookingSource, string>;

export type BookingFilter = "all" | "paid" | "due";

export type BookingStatusPill =
  | { kind: "paid"; label: "Paid in full" }
  | { kind: "late"; label: string }
  | { kind: "balance"; label: string }
  | { kind: "held"; label: string }
  | { kind: "cancelled"; label: "Cancelled" };

export type BookingRow = {
  id: string;
  code: string;
  createdLabel: string;
  customerName: string;
  phone: string | null;
  tripTitle: string;
  tripDate: string;
  pax: number;
  total: number;
  paid: number;
  pill: BookingStatusPill;
  source: string;
};

const listInclude = {
  customer: { select: { name: true, phone: true } },
  departure: { select: { code: true, startDate: true, trip: { select: { title: true, name: true } } } },
} satisfies Prisma.BookingInclude;

type ListBooking = Prisma.BookingGetPayload<{ include: typeof listInclude }>;

/** "70040 55871" style, like the demo. */
export function displayPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/^\+91/, "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : phone;
}

export function statusPill(b: Pick<ListBooking, "status" | "totalAmount" | "paidAmount" | "balanceDueDate">, today: Date): BookingStatusPill {
  if (b.status === "CANCELLED") return { kind: "cancelled", label: "Cancelled" };
  const balance = b.totalAmount - b.paidAmount;
  if (balance <= 0) return { kind: "paid", label: "Paid in full" };
  if (b.status === "HELD" && b.paidAmount === 0) return { kind: "held", label: "Held · awaiting advance" };
  const late = daysLate(b.balanceDueDate, today);
  if (late > 0) return { kind: "late", label: `${late}d late` };
  return { kind: "balance", label: `Balance ${inr(balance)}` };
}

function tripOf(b: ListBooking) {
  if (b.departure) return { title: b.departure.trip.title, date: formatDate(b.departure.startDate) };
  return { title: b.customTitle ?? "Custom trip", date: b.customStartDate ? formatDate(b.customStartDate) : "" };
}

export async function listBookings(opts: { filter?: BookingFilter; customerId?: string; now?: Date; take?: number } = {}) {
  const today = todayIST(opts.now);
  const where: Prisma.BookingWhereInput = opts.customerId ? { customerId: opts.customerId } : {};
  const rows = await db.booking.findMany({ where, include: listInclude, orderBy: { createdAt: "desc" }, take: opts.take ?? 200 });

  const active = rows.filter((b) => b.status !== "CANCELLED");
  const counts = {
    all: rows.length,
    paid: active.filter((b) => b.paidAmount >= b.totalAmount).length,
    due: active.filter((b) => b.paidAmount < b.totalAmount).length,
  };
  const filtered =
    opts.filter === "paid"
      ? active.filter((b) => b.paidAmount >= b.totalAmount)
      : opts.filter === "due"
        ? active.filter((b) => b.paidAmount < b.totalAmount)
        : rows;

  const out: BookingRow[] = filtered.map((b) => {
    const t = tripOf(b);
    return {
      id: b.id,
      code: b.code,
      createdLabel: formatIST(b.createdAt, "d MMM"),
      customerName: b.customer.name,
      phone: displayPhone(b.customer.phone),
      tripTitle: t.title,
      tripDate: t.date,
      pax: b.pax,
      total: b.totalAmount,
      paid: b.paidAmount,
      pill: statusPill(b, today),
      source: SOURCE_LABEL[b.source] ?? b.source,
    };
  });
  return { rows: out, counts };
}

// ───────────────────────────── drawer (BKG-5) ─────────────────────────────

export type JourneyStep = { done: boolean; title: string; detail: string };

export type BookingDetail = {
  id: string;
  code: string;
  status: string;
  customerId: string;
  customerName: string;
  phone: string | null;
  tripLine: string;
  departureId: string | null;
  pax: number;
  total: number;
  paid: number;
  balance: number;
  /** OWNER only. */
  profit: number | null;
  pill: BookingStatusPill;
  journey: JourneyStep[];
  links: { id: string; purpose: string; amount: number; shortUrl: string; expiresLabel: string | null }[];
  invoiceDocumentId: string | null;
  itineraryDocumentId: string | null;
  receipts: { id: string; fileName: string }[];
  payments: { id: string; amount: number; method: string; when: string; provider: string }[];
  travellers: { id: string; fullName: string; age: number | null; gender: string | null; idType: string | null; docStatus: string; isLead: boolean }[];
  cancelReason: string | null;
  canCancel: boolean;
};

export async function getBookingDetail(code: string, role: Role, now: Date = new Date()): Promise<BookingDetail | null> {
  const today = todayIST(now);
  const b = await db.booking.findUnique({
    where: { code },
    include: {
      ...listInclude,
      conversation: { select: { createdAt: true } },
      payments: { where: { status: "CAPTURED" }, orderBy: { receivedAt: "asc" } },
      paymentLinks: { where: { status: "CREATED" }, orderBy: { createdAt: "desc" } },
      invoices: { select: { documentId: true }, take: 1 },
      documents: { select: { id: true, kind: true, fileName: true }, orderBy: { createdAt: "asc" } },
      travellers: { orderBy: [{ isLead: "desc" }, { createdAt: "asc" }] },
      expenses: { where: { category: "HOTEL" }, select: { id: true }, take: 1 },
    },
  });
  if (!b) return null;

  const t = tripOf(b);
  const balance = Math.max(0, b.totalAmount - b.paidAmount);
  const travelDate = b.departure?.startDate ?? b.customStartDate;
  const late = daysLate(b.balanceDueDate, today);
  const remindersOn = (await db.reminderRule.count({ where: { enabled: true, action: "SEND_REMINDER" } })) > 0;
  const firstPayment = b.payments[0];
  const invoiceDocumentId = b.invoices[0]?.documentId ?? b.documents.find((d) => d.kind === "INVOICE")?.id ?? null;

  const hotelsBooked = b.departureId
    ? (await db.rfq.count({ where: { departureId: b.departureId, status: "BOOKED" } })) > 0
    : b.expenses.length > 0;
  const idsIn = b.travellers.filter((x) => x.docStatus === "RECEIVED" || x.docStatus === "VERIFIED").length;

  const journey: JourneyStep[] = [
    { done: true, title: "Enquiry", detail: `${SOURCE_LABEL[b.source] ?? b.source} · ${formatIST(b.conversation?.createdAt ?? b.createdAt, "d MMM")}` },
    firstPayment
      ? {
          done: true,
          title: "Advance paid",
          detail: `${inr(firstPayment.amount)} · ${invoiceDocumentId ? "invoice sent automatically" : "invoice being prepared"}`,
        }
      : {
          done: false,
          title: "Advance pending",
          detail: b.holdExpiresAt ? `Seats held until ${formatIST(b.holdExpiresAt, "d MMM, h:mm a")}` : "No payment yet",
        },
    balance === 0
      ? { done: true, title: "Paid in full", detail: "Nothing pending" }
      : {
          done: false,
          title: "Balance due",
          detail: b.balanceDueDate
            ? `Due ${formatDate(b.balanceDueDate)} · ${late > 0 ? `${late} days late` : remindersOn ? "reminders scheduled" : "reminders off"}`
            : "Due 15 days before travel",
        },
    hotelsBooked
      ? { done: true, title: "Hotels confirmed", detail: "Voucher ready to send" }
      : { done: false, title: "Hotels", detail: "Not confirmed yet" },
    { done: b.pax > 0 && idsIn >= b.pax, title: "Documents", detail: `${idsIn} of ${b.pax} IDs uploaded` },
    travelDate
      ? daysBetween(today, travelDate) >= 0
        ? { done: false, title: "Travel", detail: `${formatDate(travelDate)} · ${daysBetween(today, travelDate)} days to go` }
        : { done: true, title: "Travelled", detail: formatDate(travelDate, "d MMM yyyy") }
      : { done: false, title: "Travel", detail: "Date to be fixed" },
  ];

  return {
    id: b.id,
    code: b.code,
    status: b.status,
    customerId: b.customerId,
    customerName: b.customer.name,
    phone: b.customer.phone,
    tripLine: t.date ? `${t.title} · ${t.date}` : t.title,
    departureId: b.departureId,
    pax: b.pax,
    total: b.totalAmount,
    paid: b.paidAmount,
    balance,
    profit: role === "OWNER" ? b.totalAmount - b.costTotalPlanned : null,
    pill: statusPill(b, today),
    journey,
    links: b.paymentLinks
      .filter((l) => !l.expiresAt || l.expiresAt > now)
      .map((l) => ({ id: l.id, purpose: l.purpose, amount: l.amount, shortUrl: l.shortUrl, expiresLabel: l.expiresAt ? formatIST(l.expiresAt, "d MMM, h:mm a") : null })),
    invoiceDocumentId,
    itineraryDocumentId: b.documents.find((d) => d.kind === "ITINERARY")?.id ?? null,
    receipts: b.documents.filter((d) => d.kind === "RECEIPT").map((d) => ({ id: d.id, fileName: d.fileName })),
    payments: b.payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, when: formatIST(p.receivedAt, "d MMM, h:mm a"), provider: p.provider })),
    travellers: b.travellers.map((x) => ({ id: x.id, fullName: x.fullName, age: x.age, gender: x.gender, idType: x.idType, docStatus: x.docStatus, isLead: x.isLead })),
    cancelReason: b.cancelReason,
    canCancel: b.status === "HELD" || b.status === "CONFIRMED",
  };
}

// ───────────────────────────── new booking support ─────────────────────────────

export async function listBookableDepartures(now: Date = new Date()) {
  const today = todayIST(now);
  const deps = await db.departure.findMany({
    where: { status: "OPEN", startDate: { gte: today } },
    orderBy: { startDate: "asc" },
    include: { trip: { select: { title: true } } },
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
    label: `${d.trip.title} · ${formatDate(d.startDate)}`,
    pricePerPax: d.pricePerPax,
    seatsLeft: d.seatsTotal - (soldBy.get(d.id) ?? 0),
  }));
}

// ───────────────────────────── search (TOD-6) ─────────────────────────────

export type CustomerHit = { id: string; name: string; phone: string | null; bookings: number };
export type BookingHit = { code: string; customerName: string; trip: string };

/** Customers by name (trigram, so typos still match) or phone digits. */
export async function searchCustomers(q: string, take = 8): Promise<CustomerHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const digits = term.replace(/\D/g, "");
  const rows = await db.$queryRaw<{ id: string; name: string; phone: string | null; bookings: bigint }[]>`
    SELECT c.id, c.name, c.phone,
           (SELECT count(*) FROM "Booking" b WHERE b."customerId" = c.id)::bigint AS bookings
    FROM "Customer" c
    WHERE c.name ILIKE ${`%${term}%`}
       OR c.name % ${term}
       OR (${digits.length >= 4} AND c.phone LIKE ${`%${digits}%`})
    ORDER BY (c.name ILIKE ${`${term}%`}) DESC, similarity(c.name, ${term}) DESC, c.name
    LIMIT ${take}`;
  return rows.map((r) => ({ id: r.id, name: r.name, phone: displayPhone(r.phone), bookings: Number(r.bookings) }));
}

export async function globalSearch(q: string): Promise<{ customers: CustomerHit[]; bookings: BookingHit[] }> {
  const term = q.trim();
  if (term.length < 2) return { customers: [], bookings: [] };
  const code = term.toUpperCase();
  const [customers, bookings] = await Promise.all([
    searchCustomers(term, 6),
    db.booking.findMany({
      // The booking_code_trgm GIN index serves this ILIKE.
      where: { code: { contains: code.startsWith("LVG") ? code : code.replace(/\D/g, "") || code, mode: "insensitive" } },
      include: listInclude,
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);
  return {
    customers,
    bookings: bookings.map((b) => ({ code: b.code, customerName: b.customer.name, trip: tripOf(b).title })),
  };
}
