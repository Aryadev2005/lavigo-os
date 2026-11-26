/**
 * Media download safety (system design §10): fetch only from Meta's hosts, follow redirects only to
 * those hosts, cap the size, and accept only jpg/png/webp/pdf identified by their magic bytes.
 */
import { ChannelSendError } from "./types";

export const MEDIA_HOST_ALLOWLIST = new Set(["graph.facebook.com", "lookaside.fbsbx.com"]);
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MEDIA = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
} as const;
export type AllowedMime = keyof typeof ALLOWED_MEDIA;

/** Identify a file by its first bytes; never trust the declared type. */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

function assertAllowedHost(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ChannelSendError("media url is not a URL", false);
  }
  if (u.protocol !== "https:" || !MEDIA_HOST_ALLOWLIST.has(u.hostname)) {
    throw new ChannelSendError(`media host not allowed: ${u.hostname}`, false);
  }
  return u;
}

/** GET with the allowlist enforced on the URL and on every redirect hop (max 3). */
export async function fetchAllowedMedia(url: string, headers: Record<string, string>): Promise<{ bytes: Buffer; mime: AllowedMime }> {
  let current = assertAllowedHost(url).toString();
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ChannelSendError("media redirect without location", false);
      current = assertAllowedHost(new URL(loc, current).toString()).toString();
      continue;
    }
    if (!res.ok) throw new ChannelSendError(`media download HTTP ${res.status}`, res.status >= 500 || res.status === 429, res.status);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_MEDIA_BYTES) throw new ChannelSendError("media too large", false);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new ChannelSendError("media too large", false);
    const mime = sniffMime(bytes);
    if (!mime) throw new ChannelSendError("media type not allowed", false);
    return { bytes, mime };
  }
  throw new ChannelSendError("too many media redirects", false);
}
