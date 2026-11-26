/**
 * Razorpay adapter (PAY-1, PAY-2). Plain fetch: we need two calls and our own signature check.
 *
 * - real: Payment Links API.
 * - fake (dev/test, empty keys): returns `${APP_URL}/dev/pay/{id}`; that page simulates the
 *   customer paying by POSTing a correctly signed webhook (src/server/payments/simulate.ts).
 *
 * Signature verification is OUR code: HMAC-SHA256 of the RAW body, compared with timingSafeEqual.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PaymentMethod, PaymentPurpose } from "@prisma/client";
import { env } from "../env";

const API = "https://api.razorpay.com/v1";

export type CreateLinkInput = {
  amount: number; // paise
  bookingCode: string;
  purpose: PaymentPurpose;
  description: string;
  expireBy?: Date | null;
  customer: { name: string; phone?: string | null; email?: string | null };
};

export type CreatedLink = { providerLinkId: string; shortUrl: string; referenceId: string };

export interface PaymentGateway {
  readonly mode: "real" | "fake";
  createPaymentLink(input: CreateLinkInput): Promise<CreatedLink>;
}

/**
 * Razorpay: "reference_id … Must be a unique number for each Payment Link. The maximum character
 * limit supported is 40." (Payment Links API, create-standard; verified 26 Nov 2026.)
 * A booking can have several links (advance, then balance), so: booking code + purpose + a short
 * random suffix. The booking code also travels in `notes.booking_code`, which is what we match on.
 * An over-long code is truncated and disambiguated with a hash of the full code.
 */
export const RAZORPAY_REFERENCE_ID_MAX = 40;
/** Note values: the docs say 256 in one place and 255 in another; use the stricter. */
export const RAZORPAY_NOTE_VALUE_MAX = 255;

export function referenceIdFor(bookingCode: string, purpose: PaymentPurpose, suffix: string = randomBytes(3).toString("hex")): string {
  const tail = `-${purpose.slice(0, 3)}-${suffix}`;
  const full = `${bookingCode}${tail}`;
  if (full.length <= RAZORPAY_REFERENCE_ID_MAX) return full;
  const hash = createHash("sha256").update(bookingCode).digest("hex").slice(0, 6);
  const room = Math.max(0, RAZORPAY_REFERENCE_ID_MAX - tail.length - hash.length - 1);
  return `${bookingCode.slice(0, room)}~${hash}${tail}`.slice(0, RAZORPAY_REFERENCE_ID_MAX);
}

/** Razorpay rejects expiries less than ~15 minutes out; clamp to 20 minutes minimum. */
function expireBySeconds(expireBy: Date | null | undefined, now = Date.now()): number | undefined {
  if (!expireBy) return undefined;
  return Math.floor(Math.max(expireBy.getTime(), now + 20 * 60_000) / 1000);
}

class RazorpayGateway implements PaymentGateway {
  readonly mode = "real" as const;
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
  ) {}

  async createPaymentLink(input: CreateLinkInput): Promise<CreatedLink> {
    const referenceId = referenceIdFor(input.bookingCode, input.purpose);
    const res = await fetch(`${API}/payment_links`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amount,
        currency: "INR",
        accept_partial: false,
        reference_id: referenceId,
        description: input.description.slice(0, 2048),
        expire_by: expireBySeconds(input.expireBy),
        customer: {
          name: input.customer.name,
          ...(input.customer.phone ? { contact: input.customer.phone } : {}),
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        // We send the link ourselves on WhatsApp.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { booking_code: input.bookingCode.slice(0, RAZORPAY_NOTE_VALUE_MAX), purpose: input.purpose },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Never log the request (customer PII) or credentials; the error body is Razorpay's message.
      const detail = await res.text().catch(() => "");
      throw new Error(`Razorpay create link failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
    const body = (await res.json()) as { id: string; short_url: string };
    return { providerLinkId: body.id, shortUrl: body.short_url, referenceId };
  }
}

class FakeGateway implements PaymentGateway {
  readonly mode = "fake" as const;
  async createPaymentLink(input: CreateLinkInput): Promise<CreatedLink> {
    const providerLinkId = `plink_fake_${randomBytes(7).toString("hex")}`;
    return {
      providerLinkId,
      shortUrl: `${env.APP_URL.replace(/\/$/, "")}/dev/pay/${providerLinkId}`,
      referenceId: referenceIdFor(input.bookingCode, input.purpose),
    };
  }
}

let gateway: PaymentGateway | undefined;

export function getPaymentGateway(): PaymentGateway {
  gateway ??=
    env.providers.razorpay === "real"
      ? new RazorpayGateway(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET!)
      : new FakeGateway();
  return gateway;
}

/** Test hook. */
export function setPaymentGateway(g: PaymentGateway | undefined) {
  gateway = g;
}

/** Webhook secret. Dev/test fallback lives only in env.ts; production refuses to boot without it. */
export function webhookSecret(): string {
  const s = env.secrets.RAZORPAY_WEBHOOK_SECRET;
  if (!s) throw new Error("RAZORPAY_WEBHOOK_SECRET is not set");
  return s;
}

export function signWebhookBody(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret). Constant-time compare.
 * Rejects when the header or secret is missing.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signWebhookBody(rawBody, secret), "hex");
  const given = Buffer.from(signature.trim(), "hex");
  // Buffer.from(…, "hex") silently drops invalid chars, so also require the canonical length.
  if (given.length !== expected.length || signature.trim().length !== expected.length * 2) return false;
  return timingSafeEqual(given, expected);
}

// ───────────────────────────── payload normalisation ─────────────────────────────

export type NormalizedPayment = {
  event: string;
  providerPaymentId: string;
  providerLinkId: string | null;
  bookingCode: string | null;
  amount: number; // paise actually captured
  method: PaymentMethod;
  capturedAt: Date;
};

type RzpEntity = Record<string, unknown> & { notes?: Record<string, unknown> | unknown[] };

const METHOD: Record<string, PaymentMethod> = { upi: "UPI", card: "CARD", netbanking: "NETBANKING" };

function notes(e: RzpEntity | undefined): Record<string, unknown> {
  return e?.notes && !Array.isArray(e.notes) ? e.notes : {};
}

/**
 * Turn a verified webhook payload into the one shape applyPaymentEvent understands.
 * Returns null for events we don't act on (e.g. payment.failed).
 */
export function normalizeRazorpayEvent(payload: unknown): NormalizedPayment | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { event?: string; payload?: Record<string, { entity?: RzpEntity }>; created_at?: number };
  const event = p.event ?? "";
  if (event !== "payment_link.paid" && event !== "payment.captured") return null;

  const payment = p.payload?.payment?.entity;
  const link = p.payload?.payment_link?.entity;
  if (!payment || typeof payment.id !== "string") return null;
  if (event === "payment.captured" && payment.status !== "captured") return null;

  const amount = Number(payment.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const linkNotes = notes(link);
  const payNotes = notes(payment);
  const code = (linkNotes.booking_code ?? payNotes.booking_code) as string | undefined;
  const refId = typeof link?.reference_id === "string" ? link.reference_id : undefined;
  const createdAt = Number(payment.created_at ?? p.created_at);

  return {
    event,
    providerPaymentId: payment.id,
    providerLinkId: typeof link?.id === "string" ? link.id : null,
    bookingCode: code ?? (refId ? (/^(LVG-\d+)/.exec(refId)?.[1] ?? null) : null),
    amount,
    method: METHOD[String(payment.method)] ?? "OTHER",
    capturedAt: Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt * 1000) : new Date(),
  };
}
