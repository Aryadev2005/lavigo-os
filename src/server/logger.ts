/**
 * Structured JSON logs (pino). Tokens, secrets, OTPs, passwords, phone numbers and webhook
 * payloads are redacted (design §10, NFR-4):
 *  - by key, at the top level and one/two levels down (REDACT_PATHS);
 *  - inside strings: error messages/stacks and log messages are scrubbed of phone numbers,
 *    bearer tokens, access_token query params and long hex/base64 secrets (scrub()).
 */
import pino, { type Logger } from "pino";

export const REDACT_PATHS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "otp",
  "phone",
  "email",
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "headers['x-hub-signature-256']",
  "headers['x-razorpay-signature']",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.secret",
  "*.otp",
  "*.phone",
  "*.email",
  "*.authorization",
  "*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  // Recipients, template variables and webhook bodies carry phone numbers and names.
  "to",
  "*.to",
  "vars",
  "*.vars",
  "payload",
  "*.payload",
  "body",
  "*.body",
  "raw",
  "rawBody",
  "*.raw",
  "headers['x-razorpay-signature']",
  "*.*.phone",
  "*.*.token",
  "*.*.authorization",
  "*.*.password",
  "*.*.secret",
  "*.*.accessToken",
  "*.*.access_token",
  "access_token",
  "*.access_token",
];

const PHONE = /(?<![\w])\+?\d[\d\s-]{8,13}\d(?![\w])/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_TOKEN = /\b(access_token|token|signature|secret|key)=([^&\s"']+)/gi;
const LONG_SECRET = /\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9_-]{60,}\b/g;

/** Mask phone numbers (keeping the last 4 digits), bearer tokens and secrets inside a string. */
export function scrub(text: string): string {
  return text
    .replace(BEARER, "$1 [redacted]")
    .replace(QUERY_TOKEN, "$1=[redacted]")
    .replace(LONG_SECRET, "[redacted]")
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      // Dates (2026-11-28) and short numbers are not phone numbers.
      if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) || digits.length < 10 || digits.length > 13) return m;
      return `[phone …${digits.slice(-4)}]`;
    });
}

function errSerializer(err: unknown) {
  const out = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  for (const k of ["message", "stack"]) if (typeof out[k] === "string") out[k] = scrub(out[k] as string);
  // Provider SDK errors attach the request/response (URLs with tokens, bodies with phones): drop them.
  for (const k of ["config", "request", "response", "body", "payload", "headers"]) delete out[k];
  return out;
}

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

const globalForLogger = globalThis as unknown as { __lavigoLogger?: Logger };

export const logger: Logger =
  globalForLogger.__lavigoLogger ??
  pino({
    level,
    base: { service: process.env.LAVIGO_SERVICE ?? (process.argv[1]?.includes("worker") ? "worker" : "web") },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { err: errSerializer, error: errSerializer },
    hooks: {
      // Scrub the message string too: logger.warn({ … }, `send to ${phone} failed`).
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === "string" ? scrub(a) : a)) as Parameters<typeof method>);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

if (process.env.NODE_ENV !== "production") globalForLogger.__lavigoLogger = logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
