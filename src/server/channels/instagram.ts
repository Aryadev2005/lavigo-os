/**
 * Instagram messaging adapter (INB-2), behind FEATURE_INSTAGRAM. Same signature scheme as WhatsApp.
 * Instagram has no message templates; sends outside the 24h window are blocked upstream.
 */
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { logger } from "../logger";
import { fetchAllowedMedia } from "./media";
import { ChannelSendError, graphError, type ChannelAdapter, type InboundEventPayload, type SendReceipt } from "./types";

const GRAPH = "https://graph.facebook.com";

export class InstagramAdapter implements ChannelAdapter {
  readonly channel = "INSTAGRAM" as const;
  readonly mode = "real" as const;

  constructor(private readonly cfg = { version: env.GRAPH_API_VERSION!, accountId: env.IG_ACCOUNT_ID!, token: env.IG_ACCESS_TOKEN! }) {}

  private async post(recipient: string, message: Record<string, unknown>, what: string): Promise<SendReceipt> {
    let res: Response;
    try {
      res = await fetch(`${GRAPH}/${this.cfg.version}/${this.cfg.accountId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipient }, message }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ChannelSendError(`instagram ${what} network error: ${(err as Error).message}`, true);
    }
    if (!res.ok) throw await graphError(res, `instagram ${what}`);
    const json = (await res.json()) as { message_id?: string };
    if (!json.message_id) throw new ChannelSendError(`instagram ${what}: no message id`, true);
    return { externalId: json.message_id };
  }

  sendText(to: string, body: string) {
    return this.post(to, { text: body }, "text");
  }
  sendCta(to: string, body: string, button: { label: string; url: string }) {
    // Instagram's button template needs a Page-linked account; a plain link works everywhere.
    return this.post(to, { text: `${body}\n\n${button.label}: ${button.url}` }, "cta");
  }
  async sendTemplate(): Promise<SendReceipt> {
    throw new ChannelSendError("Instagram has no message templates", false);
  }
  sendDocument(to: string, file: { url: string; filename: string }) {
    return this.post(to, { attachment: { type: "file", payload: { url: file.url } } }, "document");
  }
  /** Instagram webhooks carry the attachment URL itself; it must be on an allowlisted Meta host. */
  downloadMedia(url: string) {
    return fetchAllowedMedia(url, { authorization: `Bearer ${this.cfg.token}` });
  }
}

export class FakeInstagramAdapter implements ChannelAdapter {
  readonly channel = "INSTAGRAM" as const;
  readonly mode = "fake" as const;
  private receipt(kind: string): SendReceipt {
    const externalId = `igmid.fake.${randomUUID()}`;
    logger.info({ kind, externalId }, "instagram (fake) send");
    return { externalId };
  }
  sendText = async () => this.receipt("text");
  sendCta = async () => this.receipt("cta");
  sendTemplate = async (): Promise<SendReceipt> => {
    throw new ChannelSendError("Instagram has no message templates", false);
  };
  sendDocument = async () => this.receipt("document");
}

type IgMessaging = {
  sender?: { id: string };
  timestamp?: number;
  message?: { mid: string; text?: string; is_echo?: boolean; attachments?: { type: string; payload?: { url?: string } }[] };
  read?: { mid?: string };
};
export type IgWebhook = { object?: string; entry?: { time?: number; messaging?: IgMessaging[] }[] };

export function normalizeInstagramWebhook(body: IgWebhook): { externalId: string; payload: InboundEventPayload }[] {
  const out: { externalId: string; payload: InboundEventPayload }[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const ts = new Date(ev.timestamp ?? entry.time ?? Date.now()).toISOString();
      if (ev.message && !ev.message.is_echo && ev.sender?.id) {
        const att = ev.message.attachments?.[0];
        const media = att?.payload?.url && (att.type === "image" || att.type === "file") ? { ref: att.payload.url } : undefined;
        out.push({
          externalId: `msg:${ev.message.mid}`,
          payload: {
            type: "message",
            message: {
              channel: "INSTAGRAM",
              externalId: ev.message.mid,
              from: ev.sender.id,
              kind: media ? "MEDIA" : "TEXT",
              text: ev.message.text ?? (att ? `[${att.type}]` : ""),
              media,
              timestamp: ts,
            },
          },
        });
      } else if (ev.read?.mid) {
        out.push({
          externalId: `status:${ev.read.mid}:read`,
          payload: { type: "status", status: { channel: "INSTAGRAM", externalId: ev.read.mid, status: "READ", timestamp: ts } },
        });
      }
    }
  }
  return out;
}
