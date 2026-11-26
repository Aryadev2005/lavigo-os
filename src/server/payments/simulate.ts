/**
 * Builds and posts a realistic, correctly signed Razorpay `payment_link.paid` webhook.
 * Used by the dev pay page (/dev/pay/[id]) and scripts/simulate-payment.ts. Never in production.
 */
import { randomBytes } from "node:crypto";
import { signWebhookBody, webhookSecret } from "./razorpay";

export type SimulatedLink = {
  providerLinkId: string;
  referenceId?: string;
  bookingCode: string;
  amount: number; // paise
  purpose?: string;
  shortUrl?: string;
};

export function buildPaymentLinkPaid(link: SimulatedLink, opts: { paymentId?: string; method?: "upi" | "card" | "netbanking"; event?: "payment_link.paid" | "payment.captured" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const paymentId = opts.paymentId ?? `pay_sim${randomBytes(7).toString("hex")}`;
  const notes = { booking_code: link.bookingCode, purpose: link.purpose ?? "ADVANCE" };
  const payment = {
    id: paymentId,
    entity: "payment",
    amount: link.amount,
    currency: "INR",
    status: "captured",
    method: opts.method ?? "upi",
    captured: true,
    description: `Lavigo booking ${link.bookingCode}`,
    vpa: opts.method === "upi" || !opts.method ? "customer@okaxis" : null,
    email: "customer@example.com",
    contact: "+919800000000",
    notes,
    fee: Math.round(link.amount * 0.02),
    tax: Math.round(link.amount * 0.0036),
    created_at: now,
  };
  const event = opts.event ?? "payment_link.paid";
  const body = {
    entity: "event",
    account_id: "acc_simulated",
    event,
    contains: event === "payment_link.paid" ? ["payment_link", "order", "payment"] : ["payment"],
    payload:
      event === "payment_link.paid"
        ? {
            payment_link: {
              entity: {
                id: link.providerLinkId,
                amount: link.amount,
                amount_paid: link.amount,
                currency: "INR",
                status: "paid",
                reference_id: link.referenceId ?? link.bookingCode,
                short_url: link.shortUrl ?? "",
                notes,
              },
            },
            order: { entity: { id: `order_sim${randomBytes(5).toString("hex")}`, amount: link.amount, status: "paid" } },
            payment: { entity: payment },
          }
        : { payment: { entity: payment } },
    created_at: now,
  };
  return { eventId: `evt_sim${randomBytes(7).toString("hex")}`, paymentId, rawBody: JSON.stringify(body) };
}

export async function postSignedWebhook(baseUrl: string, built: { eventId: string; rawBody: string }, secret = webhookSecret()) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signWebhookBody(built.rawBody, secret),
      "x-razorpay-event-id": built.eventId,
    },
    body: built.rawBody,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
}
