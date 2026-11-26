/**
 * Sandbox channel (INB-3): the in-app customer simulator. Nothing leaves the building; the
 * outbound job marks sandbox messages DELIVERED and the /sandbox page shows them as received.
 */
import { randomUUID } from "node:crypto";
import type { ChannelAdapter, SendReceipt } from "./types";

const receipt = async (): Promise<SendReceipt> => ({ externalId: `sandbox.out.${randomUUID()}` });

export const sandboxAdapter: ChannelAdapter = {
  channel: "SANDBOX",
  mode: "fake",
  sendText: receipt,
  sendCta: receipt,
  sendTemplate: receipt,
  sendDocument: receipt,
};
