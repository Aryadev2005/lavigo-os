/**
 * PDF render jobs (worker only: slow work never runs in a request).
 * invoice.render: one Invoice per booking (INV-{n}) + one receipt per payment, stored privately in S3.
 * Idempotent: Document.storageKey and Invoice.number are unique; re-runs skip what exists.
 */
import "./fonts"; // first: registers pdfkit fonts before react-pdf loads
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import type { DocumentKind } from "@prisma/client";
import { db } from "../db";
import { gstInclusiveBreakup } from "../domain/payments/gst";
import { getSettings } from "../domain/settings";
import { getStorage } from "../storage/s3";
import { formatDate } from "../time";
import { InvoicePdf, type InvoiceData } from "./invoice";
import { ItineraryPdf, parseItinerary } from "./itinerary";
import { ReceiptPdf } from "./receipt";

const METHOD_LABEL: Record<string, string> = {
  UPI: "UPI",
  CARD: "Card",
  NETBANKING: "Net banking",
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  OTHER: "Other",
};

function bookingNo(code: string) {
  return code.replace(/^LVG-/, "");
}

async function store(opts: { kind: DocumentKind; key: string; fileName: string; element: ReactElement; bookingId?: string; departureId?: string }) {
  const existing = await db.document.findUnique({ where: { storageKey: opts.key } });
  if (existing) return existing;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-pdf's renderToBuffer wants its own Document element type
  const pdf = await renderToBuffer(opts.element as any);
  await getStorage().put(opts.key, pdf, "application/pdf");
  return db.document.upsert({
    where: { storageKey: opts.key },
    update: {},
    create: {
      kind: opts.kind,
      bookingId: opts.bookingId,
      departureId: opts.departureId,
      storageKey: opts.key,
      fileName: opts.fileName,
      mimeType: "application/pdf",
      sizeBytes: pdf.length,
    },
  });
}

async function loadBooking(bookingId: string) {
  return db.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { customer: true, departure: { include: { trip: true } } },
  });
}

function describe(b: Awaited<ReturnType<typeof loadBooking>>): string {
  if (b.departure) return `${b.departure.trip.title} (${b.departure.code}), departs ${formatDate(b.departure.startDate, "d MMM yyyy")}`;
  return `${b.customTitle ?? "Custom trip"}${b.customStartDate ? `, departs ${formatDate(b.customStartDate, "d MMM yyyy")}` : ""}`;
}

/** One tax invoice per booking for the full GST-inclusive total. */
export async function renderInvoice(bookingId: string) {
  const b = await loadBooking(bookingId);
  const number = `INV-${bookingNo(b.code)}`;
  const existing = await db.invoice.findUnique({ where: { number }, include: { document: true } });
  if (existing?.document) return existing;

  const settings = await getSettings();
  const breakup = gstInclusiveBreakup(b.totalAmount, settings.gstRateBps);
  const issuedAt = existing?.issuedAt ?? new Date();
  const data: InvoiceData = {
    number,
    issuedAt,
    bookingCode: b.code,
    gstin: settings.gstin,
    customer: { name: b.customer.name, phone: b.customer.phone, email: b.customer.email, city: b.customer.city },
    description: describe(b),
    pax: b.pax,
    pricePerPax: b.pricePerPax,
    breakup,
  };
  const doc = await store({
    kind: "INVOICE",
    key: `invoices/${number}.pdf`,
    fileName: `${number}.pdf`,
    element: createElement(InvoicePdf, { d: data }),
    bookingId,
  });
  return db.invoice.upsert({
    where: { number },
    update: { documentId: doc.id },
    create: { number, bookingId, amount: b.totalAmount, taxBreakup: breakup, documentId: doc.id, issuedAt },
  });
}

export async function renderReceipt(paymentId: string) {
  const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const b = await loadBooking(p.bookingId);
  const seq = await db.payment.count({
    where: { bookingId: b.id, OR: [{ receivedAt: { lt: p.receivedAt } }, { receivedAt: p.receivedAt, id: { lte: p.id } }] },
  });
  const paidToDate = await db.payment.aggregate({
    where: { bookingId: b.id, status: "CAPTURED", OR: [{ receivedAt: { lt: p.receivedAt } }, { receivedAt: p.receivedAt, id: { lte: p.id } }] },
    _sum: { amount: true },
  });
  const number = `RCPT-${bookingNo(b.code)}-${seq}`;
  return store({
    kind: "RECEIPT",
    key: `receipts/${p.id}.pdf`,
    fileName: `${number}.pdf`,
    element: createElement(ReceiptPdf, {
      d: {
        number,
        bookingCode: b.code,
        customerName: b.customer.name,
        description: describe(b),
        amount: p.amount,
        method: METHOD_LABEL[p.method] ?? p.method,
        reference: p.providerPaymentId,
        receivedAt: p.receivedAt,
        totalAmount: b.totalAmount,
        paidAmount: paidToDate._sum.amount ?? p.amount,
      },
    }),
    bookingId: b.id,
  });
}

/** Itinerary for a departure (optionally personalised with a booking code). */
export async function renderItinerary(departureId: string, bookingId?: string) {
  const dep = await db.departure.findUniqueOrThrow({ where: { id: departureId }, include: { trip: true } });
  const b = bookingId ? await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { code: true } }) : null;
  const key = b ? `itineraries/${dep.code}-${b.code}.pdf` : `itineraries/${dep.code}.pdf`;
  return store({
    kind: "ITINERARY",
    key,
    fileName: `${dep.code}-itinerary.pdf`,
    element: createElement(ItineraryPdf, {
      d: {
        title: dep.trip.title,
        departureCode: dep.code,
        startDate: dep.startDate,
        endDate: dep.endDate,
        bookingCode: b?.code,
        days: parseItinerary(dep.trip.itinerary),
        inclusions: dep.trip.inclusions,
        exclusions: dep.trip.exclusions,
      },
    }),
    bookingId,
    departureId: bookingId ? undefined : dep.id,
  });
}

/** invoice.render job body. */
export async function renderPaymentDocuments(data: { bookingId: string; paymentId?: string }) {
  const invoice = await renderInvoice(data.bookingId);
  const receipt = data.paymentId ? await renderReceipt(data.paymentId) : null;
  return { invoiceId: invoice.id, invoiceDocumentId: invoice.documentId, receiptDocumentId: receipt?.id ?? null };
}
