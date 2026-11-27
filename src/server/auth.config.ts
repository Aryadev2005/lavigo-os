/**
 * Auth.js config shared by the proxy (src/proxy.ts) and the full server config.
 * Keep it free of Node-only imports (no Prisma, no argon2): the proxy imports it.
 * The proxy is a convenience redirect only; real authorization is requireUser() in the data layer.
 */
import type { Role } from "@prisma/client";
import type { NextAuthConfig } from "next-auth";
import { getEnv } from "./env";

/** AUTH_SECRET from env.ts (which supplies the dev-only fallback outside production). */
export function authSecret(): string {
  return getEnv().secrets.AUTH_SECRET;
}

const PUBLIC_PREFIXES = ["/api/health", "/api/auth", "/api/webhooks"];

/** The login form is the only server action a signed-out browser may post; it's tiny. */
export const MAX_ANON_ACTION_BYTES = 16 * 1024;

/**
 * Server-action POSTs (header `Next-Action`) from signed-out callers are refused here, in the proxy,
 * before Next reads the body (the server-action body limit is 21 MB). Only /login may receive one,
 * and only with a declared Content-Length ≤ 16 KB. Returns a 401 Response, or null to continue.
 */
export function rejectAnonymousAction(request: Request, isLoggedIn: boolean, path: string): Response | null {
  if (isLoggedIn || request.method !== "POST" || !request.headers.has("next-action")) return null;
  const len = request.headers.get("content-length");
  const small = len !== null && /^\d+$/.test(len) && Number(len) <= MAX_ANON_ACTION_BYTES;
  if (path === "/login" && small) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { nextUrl } = request;
      const isLoggedIn = Boolean(auth?.user);
      const path = nextUrl.pathname;
      const refused = rejectAnonymousAction(request, isLoggedIn, path);
      if (refused) return refused;
      if (path === "/login") {
        return isLoggedIn ? Response.redirect(new URL("/today", nextUrl)) : true;
      }
      if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return true;
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id as string;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.uid as string;
      session.user.role = token.role as Role;
      return session;
    },
  },
} satisfies NextAuthConfig;
