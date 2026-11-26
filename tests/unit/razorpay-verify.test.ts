import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRazorpayEvent, verifyWebhookSignature } from "@/server/payments/razorpay";
import { buildPaymentLinkPaid } from "@/server/payments/simulate";

const SECRET = "whsec_test_123";
const body = JSON.stringify({ event: "payment_link.paid", payload: { payment: { entity: { id: "pay_1", amount: 2024900 } } } });
const sign = (b: string, s = SECRET) => createHmac("sha256", s).update(b).digest("hex");

describe("verifyWebhookSignature (PAY-2, system design §9)", () => {
  it("accepts a valid signature over the raw body", () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body (even whitespace / re-serialisation)", () => {
    const sig = sign(body);
    expect(verifyWebhookSignature(body.replace("2024900", "9999999"), sig, SECRET)).toBe(false);
    expect(verifyWebhookSignature(JSON.stringify(JSON.parse(body), null, 1), sig, SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifyWebhookSignature(body, sign(body, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a missing, empty or malformed header", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "zz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign(body).slice(0, 62), SECRET)).toBe(false);
    // Non-hex characters are dropped by Buffer.from(…, "hex"); they must not sneak through.
    expect(verifyWebhookSignature(body, `${sign(body)}zz`, SECRET)).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    expect(verifyWebhookSignature(body, sign(body, ""), "")).toBe(false);
  });
});

describe("normalizeRazorpayEvent", () => {
  const link = { providerLinkId: "plink_1", bookingCode: "LVG-24912", amount: 2_024_900 };

  it("maps payment_link.paid and payment.captured for the same payment to the same payment id", () => {
    const a = buildPaymentLinkPaid(link, { paymentId: "pay_X" });
    const b = buildPaymentLinkPaid(link, { paymentId: "pay_X", event: "payment.captured" });
    const na = normalizeRazorpayEvent(JSON.parse(a.rawBody))!;
    const nb = normalizeRazorpayEvent(JSON.parse(b.rawBody))!;
    expect(na).toMatchObject({ providerPaymentId: "pay_X", providerLinkId: "plink_1", bookingCode: "LVG-24912", amount: 2_024_900, method: "UPI" });
    expect(nb).toMatchObject({ providerPaymentId: "pay_X", providerLinkId: null, bookingCode: "LVG-24912", amount: 2_024_900 });
  });

  it("ignores events we don't act on and non-integer amounts", () => {
    expect(normalizeRazorpayEvent({ event: "payment.failed", payload: {} })).toBeNull();
    const bad = JSON.parse(buildPaymentLinkPaid(link).rawBody);
    bad.payload.payment.entity.amount = 100.5;
    expect(normalizeRazorpayEvent(bad)).toBeNull();
  });
});
