/**
 * Meta webhook authenticity (INB-1, INB-2): `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`
 * keyed with the app secret. Constant-time compare; a missing secret or header always fails.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";

/** Dev/test only: lets scripts/simulate-inbound.ts sign payloads without real Meta keys. */
export const DEV_META_APP_SECRET = "dev-meta-app-secret";
export const DEV_WA_VERIFY_TOKEN = "dev-wa-verify-token";

export function metaAppSecret(): string {
  if (env.META_APP_SECRET) return env.META_APP_SECRET;
  if (env.isProd) throw new Error("META_APP_SECRET is not set"); // env.ts already refuses to boot
  return DEV_META_APP_SECRET;
}

export function waVerifyToken(): string {
  if (env.WA_VERIFY_TOKEN) return env.WA_VERIFY_TOKEN;
  if (env.isProd) throw new Error("WA_VERIFY_TOKEN is not set");
  return DEV_WA_VERIFY_TOKEN;
}

export function signMetaBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyMetaSignature(rawBody: string | Buffer, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const value = header.trim();
  if (!value.startsWith("sha256=")) return false;
  const hex = value.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(hex, "hex"), expected);
}

/** Constant-time string compare for the GET verify token. */
export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
