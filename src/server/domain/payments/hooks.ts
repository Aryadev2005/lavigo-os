/**
 * Extension points after a payment is captured and committed (PAY-2 "then, async").
 * The deal desk confirms to the customer in their chat (DESK-6).
 */
import { enqueue } from "../../queue";
import { confirmPaymentToCustomer } from "../deals/confirmations";
import type { ApplyOutcome } from ".";

export async function onPaymentCaptured(bookingId: string, info: { paymentId: string; amount: number; outcome: ApplyOutcome }): Promise<void> {
  await confirmPaymentToCustomer(bookingId, info);
  // DEP-4: credit a Fill seats campaign if this customer was messaged about the departure.
  if (info.outcome !== "paid") await enqueue("campaign.attribute", { bookingId }, { jobId: `campaign-attribute-${bookingId}` });
}
