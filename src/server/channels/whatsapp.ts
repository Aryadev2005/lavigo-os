/**
 * WhatsApp Cloud API adapter (system design §7) + webhook normalisation (INB-1).
 * POST graph.facebook.com/{GRAPH_API_VERSION}/{WA_PHONE_NUMBER_ID}/messages, bearer WA_ACCESS_TOKEN.
 */
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { logger } from "../logger";
import { fetchAllowedMedia } from "./media";
import { ChannelSendError, graphError, type ChannelAdapter, type InboundEventPayload, type NormalizedInbound, type SendReceipt } from "./types";

const GRAPH = "https://graph.facebook.com";

/** "+919835011223" → "919835011223" (the API wants digits only). */
export const waTo = (e164: string) => e164.replace(/\D/g, "");
/** "919835011223" → "+919835011223". */
export const waFrom = (digits: string) => `+${digits.replace(/\D/g, "")}`;

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly mode = "real" as const;

  constructor(
    private readonly cfg = {
      version: env.GRAPH_API_VERSION!,
      phoneNumberId: env.WA_PHONE_NUMBER_ID!,
      token: env.WA_ACCESS_TOKEN!,
    },
  ) {}

  private async post(body: Record<string, unknown>, what: string): Promise<SendReceipt> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/${this.cfg.version}/${this.cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ChannelSendError(`${what} network error: ${(err as Error).message}`, true);
    }
    if (!res.ok) throw await graphError(res, `whatsapp ${what}`);
    const json = (await res.json()) as { messages?: { id: string }[] };
    const id = json.messages?.[0]?.id;
    if (!id) throw new ChannelSendError(`whatsapp ${what}: no message id in response`, true);
    return { externalId: id };
  }

  sendText(to: string, body: string) {
    return this.post({ to: waTo(to), type: "text", text: { body, preview_url: true } }, "text");
  }

  sendCta(to: string, body: string, button: { label: string; url: string }) {
    return this.post(
      {
        to: waTo(to),
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: body },
          action: { name: "cta_url", parameters: { display_text: button.label.slice(0, 20), url: button.url } },
        },
      },
      "cta",
    );
  }

  sendTemplate(to: string, name: string, lang: string, vars: string[], buttonUrlSuffix?: string) {
    const components: Record<string, unknown>[] = [];
    if (vars.length) components.push({ type: "body", parameters: vars.map((text) => ({ type: "text", text })) });
    if (buttonUrlSuffix) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: buttonUrlSuffix }] });
    return this.post({ to: waTo(to), type: "template", template: { name, language: { code: lang }, components } }, "template");
  }

  sendDocument(to: string, file: { url: string; filename: string }, caption?: string) {
    return this.post({ to: waTo(to), type: "document", document: { link: file.url, filename: file.filename, ...(caption ? { caption } : {}) } }, "document");
  }

  /** Media id → Graph lookup → allowlisted download (lookaside.fbsbx.com). */
  async downloadMedia(mediaId: string) {
    const auth = { authorization: `Bearer ${this.cfg.token}` };
    const meta = await fetch(`${GRAPH}/${this.cfg.version}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    if (!meta.ok) throw await graphError(meta, "whatsapp media lookup");
    const { url } = (await meta.json()) as { url?: string };
    if (!url) throw new ChannelSendError("whatsapp media lookup: no url", false);
    return fetchAllowedMedia(url, auth);
  }
}

/** Dev/test stand-in: logs (no PII) and returns a fake wamid. Outbound then marks the message SENT. */
export class FakeWhatsAppAdapter implements ChannelAdapter {
  readonly channel = "WHATSAPP" as const;
  readonly mode = "fake" as const;
  private receipt(kind: string): SendReceipt {
    const externalId = `wamid.fake.${randomUUID()}`;
    logger.info({ kind, externalId }, "whatsapp (fake) send");
    return { externalId };
  }
  sendText = async (_to: string, _body: string) => this.receipt("text");
  sendCta = async (_to: string, _body: string, _b: { label: string; url: string }) => this.receipt("cta");
  sendTemplate = async (_to: string, name: string) => this.receipt(`template:${name}`);
  sendDocument = async (_to: string, _f: { url: string; filename: string }) => this.receipt("document");
}

// ───────────────────────────── webhook normalisation ─────────────────────────────

type WaMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { latitude: number; longitude: number; name?: string };
  referral?: Record<string, unknown>;
};
type WaStatus = { id: string; status: string; timestamp: string; errors?: { code?: number; title?: string }[] };
type WaValue = { contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: WaMessage[]; statuses?: WaStatus[] };
export type WaWebhook = { object?: string; entry?: { changes?: { field?: string; value?: WaValue }[] }[] };

const iso = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000).toISOString();

function toInbound(m: WaMessage, contacts: WaValue["contacts"]): NormalizedInbound {
  const profileName = contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
  const base = { channel: "WHATSAPP" as const, externalId: m.id, from: waFrom(m.from), profileName, timestamp: iso(m.timestamp), referral: m.referral };
  switch (m.type) {
    case "text":
      return { ...base, kind: "TEXT", text: m.text?.body ?? "" };
    case "image":
      return { ...base, kind: "MEDIA", text: m.image?.caption ?? "📷 Photo", media: { ref: m.image!.id, mime: m.image?.mime_type } };
    case "document":
      return {
        ...base,
        kind: "MEDIA",
        text: m.document?.caption ?? `📎 ${m.document?.filename ?? "Document"}`,
        media: { ref: m.document!.id, mime: m.document?.mime_type, filename: m.document?.filename },
      };
    case "button":
      return { ...base, kind: "TEXT", text: m.button?.text ?? "" };
    case "interactive":
      return { ...base, kind: "TEXT", text: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "" };
    case "location":
      return { ...base, kind: "TEXT", text: `📍 ${m.location?.name ?? "Location"} (${m.location?.latitude}, ${m.location?.longitude})` };
    default:
      return { ...base, kind: "TEXT", text: `[${m.type} message: open WhatsApp to view]` };
  }
}

const STATUS_MAP: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/** Split one webhook delivery into per-message / per-status items, each with its own dedupe key. */
export function normalizeWhatsAppWebhook(body: WaWebhook): { externalId: string; payload: InboundEventPayload }[] {
  const out: { externalId: string; payload: InboundEventPayload }[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      for (const m of v.messages ?? []) out.push({ externalId: `msg:${m.id}`, payload: { type: "message", message: toInbound(m, v.contacts) } });
      for (const s of v.statuses ?? []) {
        const status = STATUS_MAP[s.status];
        if (!status) continue;
        const error = s.errors?.[0] ? `${s.errors[0].code ?? ""} ${s.errors[0].title ?? ""}`.trim() : undefined;
        out.push({
          // A message gets several statuses; each is its own event.
          externalId: `status:${s.id}:${s.status}`,
          payload: { type: "status", status: { channel: "WHATSAPP", externalId: s.id, status, error, timestamp: iso(s.timestamp) } },
        });
      }
    }
  }
  return out;
}
