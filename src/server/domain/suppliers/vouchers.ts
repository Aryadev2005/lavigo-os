/**
 * Hotel vouchers (Bookings drawer "Send vouchers"): one PDF per booking listing the hotels booked
 * through the Supplier desk for its departure, sent into the customer's WhatsApp chat via
 * outbound.sendDocument. Rendering and sending happen in the worker (voucher.send → ./voucher-job).
 */
import { db } from "../../db";
import { enqueue } from "../../queue";
import { SupplierError, type Actor } from "./common";

export async function hasBookedHotels(departureId: string | null): Promise<boolean> {
  if (!departureId) return false;
  return (await db.supplierQuote.count({ where: { status: "BOOKED", recipient: { rfq: { departureId, status: "BOOKED" } } } })) > 0;
}

/** Drawer action → queue the render + send. */
export async function sendVouchers(bookingId: string, actor: Actor) {
  const b = await db.booking.findUnique({ where: { id: bookingId }, select: { id: true, status: true, departureId: true } });
  if (!b || b.status === "CANCELLED") throw new SupplierError("NOT_FOUND", "Booking not found");
  if (!(await hasBookedHotels(b.departureId))) throw new SupplierError("INVALID", "No hotels are booked for this departure yet (Supplier desk)");
  await enqueue("voucher.send", { bookingId: b.id, requestedById: actor.id }, { jobId: `voucher-${b.id}-${Date.now()}` });
}

