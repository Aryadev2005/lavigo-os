/**
 * voucher.send job body (worker only: imports the PDF renderer, which must never load in the web
 * bundle). Renders the booking's hotel voucher and sends it with outbound.sendDocument.
 */
import { createElement } from "react";
import { sendDocument } from "../../channels/outbound";
import { db } from "../../db";
import { logger } from "../../logger";
import { store } from "../../pdf/render";
import { VoucherPdf } from "../../pdf/voucher";
import { publish } from "../../pubsub";
import { addDays } from "../../time";
import { CATEGORY_LABEL, MEAL_PLAN_LABEL } from "./common";

async function bookedStays(departureId: string) {
  return db.supplierQuote.findMany({
    where: { status: "BOOKED", recipient: { rfq: { departureId, status: "BOOKED" } } },
    include: { recipient: { include: { rfq: true, supplier: { select: { name: true } } } } },
    orderBy: { recipient: { rfq: { checkIn: "asc" } } },
  });
}

export async function renderAndSendVoucher(bookingId: string): Promise<{ documentId: string; sent: boolean; reason?: string }> {
  const b = await db.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { customer: true, departure: { include: { trip: true } }, travellers: { orderBy: { createdAt: "asc" } } },
  });
  if (!b.departure) throw new Error("voucher needs a departure");
  const quotes = await bookedStays(b.departure.id);
  if (!quotes.length) throw new Error("no booked hotels for this departure");

  const stays = quotes.map((q) => ({
    hotel: q.recipient.supplier.name,
    destination: q.recipient.rfq.destination,
    checkIn: q.recipient.rfq.checkIn,
    checkOut: addDays(q.recipient.rfq.checkIn, q.recipient.rfq.nights),
    nights: q.recipient.rfq.nights,
    // The PDF font has no ★ glyph.
    roomType: CATEGORY_LABEL[q.recipient.rfq.category].replace("★", "-star"),
    mealPlan: MEAL_PLAN_LABEL[q.recipient.rfq.mealPlan],
    reference: `${b.code}-H${q.id.slice(-5).toUpperCase()}`,
  }));
  // A new key whenever the set of booked hotels changes, so a re-send after another booking re-renders.
  const version = quotes.map((q) => q.id.slice(-6)).join("");
  const doc = await store({
    kind: "VOUCHER",
    key: `vouchers/${b.code}-${version}.pdf`,
    fileName: `${b.code}-hotel-voucher.pdf`,
    element: createElement(VoucherPdf, {
      d: {
        bookingCode: b.code,
        customerName: b.customer.name,
        tripTitle: b.departure.trip.title,
        departureCode: b.departure.code,
        pax: b.pax,
        travellers: b.travellers.map((t) => t.fullName),
        stays,
      },
    }),
    bookingId: b.id,
  });

  // The booking's chat, else the customer's latest WhatsApp conversation.
  const conv =
    (b.conversationId ? await db.conversation.findUnique({ where: { id: b.conversationId } }) : null) ??
    (await db.conversation.findFirst({ where: { customerId: b.customerId, channel: "WHATSAPP" }, orderBy: { lastMessageAt: "desc" } }));
  let sent = false;
  let reason: string | undefined;
  if (!conv) reason = "no WhatsApp chat with this customer";
  else {
    const r = await sendDocument(conv.id, doc.id, "SYSTEM", `Hotel voucher for ${b.code} 🏨`);
    if (r.status === "BLOCKED") {
      reason = r.reason;
      await db.message.create({
        data: { conversationId: conv.id, direction: "OUTBOUND", author: "SYSTEM", kind: "SYSTEM_NOTE", status: "SENT", body: `🏨 Hotel voucher for ${b.code} is ready but wasn't sent (${r.reason === "WINDOW_CLOSED" ? "the 24-hour window is closed" : r.reason}). Download it from the booking.` },
      });
    } else {
      sent = true;
      await db.document.update({ where: { id: doc.id }, data: { sentAt: new Date() } });
    }
  }
  if (!sent) logger.info({ bookingId, reason }, "voucher not sent");
  await publish({ type: "booking.updated", payload: { bookingId } }).catch(() => undefined);
  await publish({ type: "toast", payload: { text: sent ? `Hotel voucher sent to ${b.customer.name}` : `Voucher for ${b.code} ready · not sent: ${reason}`, icon: sent ? "🏨" : "⚠️" } }).catch(() => undefined);
  return { documentId: doc.id, sent, reason };
}
