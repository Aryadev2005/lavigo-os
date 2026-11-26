/** Channel adapter contract (system design §7) and the normalised shapes webhooks produce. */
import type { Channel } from "@prisma/client";

export type SendReceipt = { externalId: string };

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly mode: "real" | "fake";
  sendText(to: string, body: string): Promise<SendReceipt>;
  sendCta(to: string, body: string, button: { label: string; url: string }): Promise<SendReceipt>;
  sendTemplate(to: string, name: string, lang: string, vars: string[], buttonUrlSuffix?: string): Promise<SendReceipt>;
  sendDocument(to: string, file: { url: string; filename: string }, caption?: string): Promise<SendReceipt>;
  downloadMedia?(mediaRef: string): Promise<{ bytes: Buffer; mime: string }>;
}

/** A provider call failed. `retryable` = 5xx / 429 / network; other 4xx are permanent. */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ChannelSendError";
  }
}

export type InboundMedia = { ref: string; mime?: string; filename?: string };

/** One inbound customer/supplier message, provider-neutral. Dates as ISO strings (stored as JSON). */
export type NormalizedInbound = {
  channel: Channel;
  /** Provider message id (wamid / IG mid / sandbox id): the dedupe key. */
  externalId: string;
  /** Thread key: E.164 phone (WhatsApp), IGSID (Instagram), sandbox thread id. */
  from: string;
  profileName?: string;
  kind: "TEXT" | "MEDIA";
  text: string;
  media?: InboundMedia;
  /** WhatsApp click-to-chat ad/post referral, kept raw. */
  referral?: Record<string, unknown>;
  timestamp: string;
};

export type NormalizedStatus = {
  channel: Channel;
  externalId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  error?: string;
  timestamp: string;
};

/** What a webhook item becomes in WebhookEvent.payload. */
export type InboundEventPayload = { type: "message"; message: NormalizedInbound } | { type: "status"; status: NormalizedStatus };

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Meta Graph error → ChannelSendError without echoing tokens or full payloads. */
export async function graphError(res: Response, what: string): Promise<ChannelSendError> {
  const body = (await readJson(res)) as { error?: { message?: string; code?: number } } | string;
  const detail = typeof body === "object" && body?.error ? `${body.error.code ?? ""} ${body.error.message ?? ""}`.trim() : `HTTP ${res.status}`;
  const retryable = res.status >= 500 || res.status === 429;
  return new ChannelSendError(`${what} failed: ${detail}`.slice(0, 300), retryable, res.status);
}
