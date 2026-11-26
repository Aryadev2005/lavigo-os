/**
 * Extension points after a payment is captured and committed.
 * P4 sends the customer's WhatsApp confirmation (DESK-6, PAY-2) from onPaymentCaptured.
 */
import { logger } from "../../logger";

export async function onPaymentCaptured(bookingId: string): Promise<void> {
  logger.debug({ bookingId }, "onPaymentCaptured hook (no-op until P4)");
}
