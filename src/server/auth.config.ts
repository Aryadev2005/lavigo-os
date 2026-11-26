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

export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = Boolean(auth?.user);
      const path = nextUrl.pathname;
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
