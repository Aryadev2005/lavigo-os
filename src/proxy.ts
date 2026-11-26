/**
 * Convenience redirect to /login for signed-out users. NOT the security boundary:
 * pages, actions and queries enforce auth with requireUser() (src/server/rbac.ts).
 */
import NextAuth from "next-auth";
import type { NextFetchEvent, NextRequest } from "next/server";
import { authConfig } from "@/server/auth.config";

// Called with a request, Auth.js's auth() runs the `authorized` callback in auth.config.ts.
const authMiddleware = NextAuth(authConfig).auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

// A plain function export so Next's build can statically detect the proxy.
export function proxy(request: NextRequest, event: NextFetchEvent) {
  return authMiddleware(request, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images/|fonts/|api/health|api/webhooks|dev/pay).*)"],
};
