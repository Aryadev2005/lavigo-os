/**
 * Fresh integration database per run: DROP/CREATE <db>_test, then `prisma migrate deploy`
 * (the same migrations CI and production apply, including the raw-SQL sequence).
 * Skipped when only unit tests are selected and no DATABASE_URL is configured.
 */
import { execFileSync } from "node:child_process";

export default function setup() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.warn("[global-setup] DATABASE_URL not set: integration tests will fail");
    return;
  }
  const testUrl = new URL(raw);
  const dbName = testUrl.pathname.replace(/^\//, "");
  const name = dbName.endsWith("_test") ? dbName : `${dbName}_test`;
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Unsafe test database name: ${name}`);
  testUrl.pathname = `/${name}`;
  const adminUrl = new URL(raw);
  adminUrl.pathname = "/postgres";

  const run = (args: string[], input?: string, url = adminUrl.toString()) =>
    execFileSync("pnpm", ["exec", "prisma", ...args], {
      input,
      env: { ...process.env, DATABASE_URL: url },
      stdio: input ? ["pipe", "ignore", "inherit"] : ["ignore", "ignore", "inherit"],
    });

  run(["db", "execute", "--stdin", "--url", adminUrl.toString()], `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  run(["db", "execute", "--stdin", "--url", adminUrl.toString()], `CREATE DATABASE "${name}";`);
  run(["migrate", "deploy"], undefined, testUrl.toString());
}
