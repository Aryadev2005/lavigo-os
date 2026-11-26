/**
 * Auth.js v5: email + password (argon2id), JWT session carrying the user's role.
 */
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { audit } from "./audit";
import { authConfig, authSecret } from "./auth.config";
import { db } from "./db";
import { clearLoginFailures, isLockedOut, recordLoginFailure } from "./login-rate-limit";
import { logger } from "./logger";
import { verifyAgainstDummy, verifyPassword } from "./password";

export class LockedOutError extends CredentialsSignin {
  code = "locked";
}

const credentialsSchema = z.object({
  email: z.email().max(200).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

/**
 * Client IP for rate limiting (AUTH-2).
 *
 * TRUST ASSUMPTION: exactly one trusted proxy (Caddy) sits in front of web and appends the
 * real client IP to X-Forwarded-For, and the web port is never exposed directly in prod.
 * So the LAST hop is the one Caddy wrote; earlier hops are client-supplied and could be
 * rotated to dodge the lockout. If a second proxy/CDN is ever added, revisit this.
 */
export function clientIp(headers: Headers): string {
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) ?? headers.get("x-real-ip") ?? "unknown";
}

// Lazy config: the secret is resolved from env.ts per request (dev fallback lives only there).
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  ...authConfig,
  secret: authSecret(),
  providers: [
    Credentials({
      credentials: { email: { type: "email" }, password: { type: "password" } },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const ip = clientIp(request.headers);

        if (await isLockedOut(email, ip)) throw new LockedOutError();

        const user = await db.user.findUnique({ where: { email } });
        const ok = user?.active ? await verifyPassword(user.passwordHash, password) : await verifyAgainstDummy(password);

        if (!ok || !user) {
          const lockedNow = await recordLoginFailure(email, ip);
          if (lockedNow) {
            logger.warn({ ip }, "login locked out after repeated failures");
            if (user) await audit({ userId: user.id, action: "auth.login_locked", entityType: "User", entityId: user.id, ip });
            throw new LockedOutError();
          }
          return null;
        }

        await clearLoginFailures(email, ip);
        await audit({ userId: user.id, action: "auth.login", entityType: "User", entityId: user.id, ip });
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
}));
