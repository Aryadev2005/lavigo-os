/** Adapter registry: real adapters when their keys are set, fakes otherwise (dev/test only; prod refuses to boot). */
import type { Channel } from "@prisma/client";
import { env } from "../env";
import { FakeInstagramAdapter, InstagramAdapter } from "./instagram";
import { sandboxAdapter } from "./sandbox";
import type { ChannelAdapter } from "./types";
import { ChannelSendError } from "./types";
import { FakeWhatsAppAdapter, WhatsAppCloudAdapter } from "./whatsapp";

const cache = new Map<Channel, ChannelAdapter>();

export function getAdapter(channel: Channel): ChannelAdapter {
  const hit = cache.get(channel);
  if (hit) return hit;
  let adapter: ChannelAdapter;
  switch (channel) {
    case "WHATSAPP":
      adapter = env.providers.whatsapp === "real" ? new WhatsAppCloudAdapter() : new FakeWhatsAppAdapter();
      break;
    case "INSTAGRAM":
      adapter = env.FEATURE_INSTAGRAM && env.providers.instagram === "real" ? new InstagramAdapter() : new FakeInstagramAdapter();
      break;
    case "SANDBOX":
      adapter = sandboxAdapter;
      break;
    default:
      throw new ChannelSendError(`${channel} has no chat adapter`, false);
  }
  cache.set(channel, adapter);
  return adapter;
}

/** Instagram sends are possible only with the flag on (or in dev, through the fake). */
export function channelEnabled(channel: Channel): boolean {
  if (channel === "INSTAGRAM") return env.FEATURE_INSTAGRAM || !env.isProd;
  return channel !== "EMAIL";
}

export * from "./types";
