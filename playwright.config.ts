/**
 * E2E smoke (design §13): one spec against a running production-mode stack (prod image, prod
 * compose, DEMO_FAKES). Not part of `pnpm test`. Locally: `make prod-local-up prod-local-seed`, then
 *   E2E_STAFF_PASSWORD=… E2E_OWNER_PASSWORD=… pnpm e2e
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    trace: "off",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
});
