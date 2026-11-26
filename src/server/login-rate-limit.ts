/**
 * AUTH-2: 5 failed logins per 15 minutes per email+IP, then a 15-minute lockout.
 * Keys hold a hash of email+IP, never the raw email.
 */
import { createHash } from "node:crypto";
import { redis } from "./redis";

export const MAX_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;
export const LOCKOUT_SECONDS = 15 * 60;

function subject(email: string, ip: string): string {
  return createHash("sha256").update(`${email.trim().toLowerCase()}|${ip}`).digest("hex").slice(0, 32);
}

const failKey = (s: string) => `auth:fail:${s}`;
const lockKey = (s: string) => `auth:lock:${s}`;

export async function isLockedOut(email: string, ip: string): Promise<boolean> {
  return (await redis.exists(lockKey(subject(email, ip)))) === 1;
}

/** Records a failure. Returns true when this failure triggered the lockout. */
export async function recordLoginFailure(email: string, ip: string): Promise<boolean> {
  const s = subject(email, ip);
  const results = await redis.multi().incr(failKey(s)).expire(failKey(s), WINDOW_SECONDS, "NX").exec();
  const count = Number(results?.[0]?.[1] ?? 0);
  if (count >= MAX_FAILURES) {
    await redis.multi().set(lockKey(s), "1", "EX", LOCKOUT_SECONDS).del(failKey(s)).exec();
    return true;
  }
  return false;
}

export async function clearLoginFailures(email: string, ip: string): Promise<void> {
  await redis.del(failKey(subject(email, ip)));
}
