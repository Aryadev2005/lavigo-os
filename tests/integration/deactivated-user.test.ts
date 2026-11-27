/**
 * AUTH-3: route handlers use currentUser(), which re-reads the user from the DB on every request,
 * so a deactivated user with a still-valid session cookie is treated as signed out (401), the same
 * as requireUser() for pages and actions.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

let sessionUserId: string | null = null;
vi.mock("@/server/auth", () => ({ auth: vi.fn(async () => (sessionUserId ? { user: { id: sessionUserId } } : null)) }));
vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined), subscribe: vi.fn() }));

const { db } = await import("@/server/db");
const { currentUser } = await import("@/server/rbac");
const travellers = await import("@/app/api/departures/[id]/travellers/route");
const files = await import("@/app/api/files/[id]/route");

afterAll(() => db.$disconnect());

describe("deactivated users", () => {
  it("currentUser() is null and route handlers answer 401 once the user is deactivated", async () => {
    const u = await db.user.create({ data: { email: `staff-${randomBytes(4).toString("hex")}@test.local`, name: "Staff", role: "STAFF", passwordHash: "x" } });
    sessionUserId = u.id;
    expect((await currentUser())?.id).toBe(u.id);

    await db.user.update({ where: { id: u.id }, data: { active: false } });
    expect(await currentUser()).toBeNull();
    const ctx = { params: Promise.resolve({ id: "missing" }) };
    expect((await travellers.GET(new Request("http://localhost/api/departures/missing/travellers"), ctx as never)).status).toBe(401);
    expect((await files.GET(new Request("http://localhost/api/files/missing"), ctx as never)).status).toBe(401);
  });
});
