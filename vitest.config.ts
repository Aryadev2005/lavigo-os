import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a SEPARATE database (<db>_test), dropped, recreated and migrated
 * once per run by tests/global-setup.ts. The dev database is never touched.
 */
function testDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) url.pathname = `/${name}_test`;
  return url.toString();
}

const TEST_DATABASE_URL = testDatabaseUrl();

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-guard.ts"],
    // Row-lock contention tests wait on each other; give them room.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      TZ: "Asia/Kolkata",
      ...(TEST_DATABASE_URL ? { DATABASE_URL: TEST_DATABASE_URL } : {}),
    },
  },
});
