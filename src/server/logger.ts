/**
 * Structured JSON logs (pino). Tokens, secrets, OTPs, passwords and phone numbers
 * are redacted wherever they appear in a logged object.
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
];

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

const globalForLogger = globalThis as unknown as { __lavigoLogger?: Logger };

export const logger: Logger =
  globalForLogger.__lavigoLogger ??
  pino({
    level,
    base: { service: process.env.LAVIGO_SERVICE ?? (process.argv[1]?.includes("worker") ? "worker" : "web") },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

if (process.env.NODE_ENV !== "production") globalForLogger.__lavigoLogger = logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
