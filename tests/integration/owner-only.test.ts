/**
 * Owner-only domain guards (PRF-3, RUL-4): staff can't read profit or change pricing rules even if
 * they reach the domain without the page/action guard. Rejections only: nothing here writes the
 * shared settings row that other test files read in parallel.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/pubsub", () => ({ publish: vi.fn(async () => undefined) }));

const { db } = await import("@/server/db");
const { ForbiddenError, getProfitBoard } = await import("@/server/domain/profit");
const { getRulesView, saveRules } = await import("@/server/domain/settings/rules");
const { ensureSettings } = await import("./fixtures");

afterAll(() => db.$disconnect());

describe("owner-only", () => {
  it("staff can't read profit or the rules view", async () => {
    await expect(getProfitBoard({ role: "STAFF" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getRulesView({ role: "STAFF" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a staff save is rejected before anything is written or audited", async () => {
    const before = await ensureSettings();
    const staff = await db.user.create({ data: { email: `staff-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, name: "Staff", role: "STAFF", passwordHash: "x" } });
    await expect(
      saveRules({ floorMarginBps: 800, soloDiscountPerPax: 150_000, stackOffers: true, escalateGroupSizeAtLeast: 200, offers: [] }, { id: staff.id, role: "STAFF" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const after = await db.agentSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(after.floorMarginBps).toBe(before.floorMarginBps);
    expect(await db.auditLog.count({ where: { userId: staff.id } })).toBe(0);
  });
});
