/**
 * Extension points after a payment is captured and committed (PAY-2 "then, async").
 * The deal desk confirms to the customer in their chat (DESK-6).
 */
import { confirmPaymentToCustomer } from "../deals/confirmations";
import type { ApplyOutcome } from ".";

export async function onPaymentCaptured(bookingId: string, info: { paymentId: string; amount: number; outcome: ApplyOutcome }): Promise<void> {
  await confirmPaymentToCustomer(bookingId, info);
}
