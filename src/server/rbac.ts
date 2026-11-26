/**
 * Authorization in the data layer (AUTH-3). Every page, server action and query calls
 * requireUser(role?) — the proxy redirect is only a convenience (see CVE-2025-29927).
 */
import type { Role } from "@prisma/client";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { db } from "./db";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  phone: string | null;
};

/** The signed-in, still-active user, or null. Re-checks the DB so deactivation takes effect at once. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, phone: true, active: true },
  });
  if (!user?.active) return null;
  const { active: _active, ...rest } = user;
  return rest;
});

/** OWNER satisfies any requirement; STAFF only satisfies STAFF. */
export function hasRole(user: Pick<SessionUser, "role">, required: Role): boolean {
  return required === "STAFF" || user.role === "OWNER";
}

/**
 * Require a signed-in user (and optionally a role).
 * Not signed in → redirect to /login. Wrong role → 403 (forbidden.tsx).
 */
export async function requireUser(role?: Role): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (role && !hasRole(user, role)) forbidden();
  return user;
}
