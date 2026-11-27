#!/usr/bin/env node
/**
 * `pnpm seed` / `pnpm seed:prod` launcher. In the production image (NODE_ENV=production, no tsx)
 * it runs the tsup bundles dist/seed.js / dist/seed-prod.js; in dev it runs the TypeScript sources
 * with tsx. Extra arguments (--force, --approve-templates) are passed through.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [which, ...args] = process.argv.slice(2);
if (which !== "seed" && which !== "seed-prod") {
  console.error("usage: run-seed.mjs seed|seed-prod [args]");
  process.exit(2);
}
const bundle = `dist/${which}.js`;
const useBundle = process.env.NODE_ENV === "production" && existsSync(bundle);
const [cmd, cmdArgs] = useBundle ? [process.execPath, [bundle, ...args]] : ["tsx", [`prisma/${which}.ts`, ...args]];
const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
process.exit(r.status ?? 1);
