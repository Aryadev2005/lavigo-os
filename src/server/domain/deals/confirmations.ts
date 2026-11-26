/**
 * Automatic (non-AI) customer messages after money arrives (DESK-6, system design §6.3).
 * Only for bookings that came from a chat (Booking.conversationId). Each step is idempotent:
 * the confirmation is keyed by paymentId on Message.payload, the invoice by Document.sentAt.
 */
import type { ApplyOutcome } from "../payments";
import { send, windowOpen } from "../../channels/outbound";
import { db } from "../../db";
import { logger } from "../../logger";
import { inr } from "../../money";
import { publish } from "../../pubsub";
import { formatDate } from "../../time";

const METHOD_LABEL: Record<string, string> = { UPI: "UPI", CARD: "card", NETBANKING: "net banking", CASH: "cash", BANK_TRANSFER: "bank transfer", WALLET: "wallet" };

export async function confirmPaymentToCustomer(
  bookingId: string,
  info: { paymentId: string; amount: number; outcome: ApplyOutcome },
): Promise<"sent" | "noted" | "skipped"> {
  const b = await db.booking.findUnique({
    where: { id: bookingId },
    include: { customer: true, departure: { include: { trip: true } }, conversation: true },
  });
  if (!b?.conversation) return "skipped";
  const conv = b.conversation;
  const already = await db.message.findFirst({
    where: { conversationId: conv.id, payload: { path: ["paymentId"], equals: info.paymentId } },
    select: { id: true },
  });
  if (already) return "skipped";

  const payment = await db.payment.findUnique({ where: { id: info.paymentId }, select: { method: true } });
  const name = b.customer.name.split(/[\s&]/)[0] || b.customer.name;
  const balance = Math.max(0, b.totalAmount - b.paidAmount);
  const due = b.balanceDueDate ? formatDate(b.balanceDueDate) : "before travel";
  const trip = b.departure ? `${b.departure.trip.name} ${formatDate(b.departure.startDate)}` : (b.customTitle ?? "your trip");
  const firstConfirmation = info.outcome !== "paid";

  const text = firstConfirmation
    ? `Payment received, thank you ${name}! 🙏 Booking ${b.code} confirmed.${balance > 0 ? ` Balance ${inr(balance)} due ${due}; we'll remind you.` : " You're fully paid."}`
    : `Payment of ${inr(info.amount)} received, thank you ${name}! 🙏 ${balance > 0 ? `Balance ${inr(balance)} due ${due}.` : `${b.code} is now fully paid. See you on the trip!`}`;
  const meta = { bookingId: b.id, paymentId: info.paymentId };

  const r = windowOpen(conv.lastInboundAt)
    ? await send(conv.id, { type: "text", body: text }, "SYSTEM", { meta })
    : await send(
        conv.id,
        {
          type: "template",
          name: "booking_confirmed",
          vars: { name, booking_code: b.code, trip, pax: String(b.pax), paid: inr(b.paidAmount), balance: inr(balance), due_date: due },
        },
        "SYSTEM",
        { meta },
      );

  const via = payment ? ` via ${METHOD_LABEL[payment.method] ?? payment.method.toLowerCase()}` : "";
  const status = r.status === "BLOCKED" ? ` · confirmation not sent (${r.reason})` : "";
  await send(
    conv.id,
    { type: "note", body: `💸 ${inr(info.amount)} received${via} · Booking ${b.code} ${firstConfirmation ? `confirmed · ${b.pax} seats` : `balance ${inr(balance)}`}${status}` },
    "SYSTEM",
    { meta: { bookingId: b.id, paymentNote: info.paymentId } },
  );
  await db.conversation.update({ where: { id: conv.id }, data: { status: "PAID" } });
  await publish({ type: "conversation.updated", payload: { conversationId: conv.id } }).catch(() => undefined);
  if (firstConfirmation) {
    await publish({ type: "toast", payload: { text: `New booking: ${b.customer.name} · ${b.pax} seats · ${inr(b.totalAmount)}`, icon: "🎉" } }).catch(() => undefined);
  }
  if (r.status === "BLOCKED") logger.warn({ bookingId, reason: r.reason }, "payment confirmation not sent");
  return r.status === "BLOCKED" ? "noted" : "sent";
}

/** After invoice.render: send the invoice PDF into the chat once (inside the 24h window only). */
export async function sendInvoiceToChat(bookingId: string, documentId: string | null | undefined): Promise<"sent" | "skipped"> {
  if (!documentId) return "skipped";
  const [b, doc] = await Promise.all([
    db.booking.findUnique({ where: { id: bookingId }, select: { code: true, conversation: { select: { id: true, lastInboundAt: true } } } }),
    db.document.findUnique({ where: { id: documentId }, select: { id: true, sentAt: true, invoice: { select: { number: true } } } }),
  ]);
  if (!b?.conversation || !doc || doc.sentAt) return "skipped";
  // Claim first so a retried render job can't send it twice.
  const claimed = await db.document.updateMany({ where: { id: doc.id, sentAt: null }, data: { sentAt: new Date() } });
  if (!claimed.count) return "skipped";
  const caption = `Invoice ${doc.invoice?.number ?? ""} for ${b.code}`.replace(/\s+/g, " ").trim();
  if (!windowOpen(b.conversation.lastInboundAt)) {
    await send(b.conversation.id, { type: "note", body: `🧾 ${caption} is ready (not sent: the 24-hour window is closed)` }, "SYSTEM");
    return "skipped";
  }
  const r = await send(b.conversation.id, { type: "document", documentId: doc.id, caption }, "SYSTEM", { meta: { bookingId } });
  if (r.status === "BLOCKED") {
    await db.document.update({ where: { id: doc.id }, data: { sentAt: null } });
    return "skipped";
  }
  return "sent";
}
