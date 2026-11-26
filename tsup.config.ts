import { defineConfig } from "tsup";

// Bundles the BullMQ worker into a single dist/worker.js for the production image.
// Everything is bundled except native/engine packages, which the Next standalone
// output already ships in node_modules (@prisma/client, @node-rs/argon2).
export default defineConfig({
  entry: { worker: "src/worker/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle everything except packages that load native engines/binaries from disk.
  // (tsup's noExternal wins over external, so the exclusion lives in the regex.)
  noExternal: [/^(?!@prisma\/client|\.prisma|@node-rs\/argon2)/],
  // Bundled CommonJS deps call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
