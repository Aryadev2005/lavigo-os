import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

/**
 * Bundled deps that read data files relative to their own module at runtime
 * (`new URL("./x", import.meta.url)`). After bundling, that URL resolves inside dist/,
 * so the files are copied there. The build fails if a file can't be found unambiguously.
 */
const RUNTIME_ASSETS: { pkg: string; file: string; to: string }[] = [
  { pkg: "unicode-properties", file: "data.trie", to: "data.trie" }, // @react-pdf text layout
  { pkg: "pdfkit", file: "js/data/sRGB_IEC61966_2_1.icc", to: "data/sRGB_IEC61966_2_1.icc" },
];

function copyRuntimeAssets() {
  const store = path.join("node_modules", ".pnpm");
  const dirs = readdirSync(store);
  for (const a of RUNTIME_ASSETS) {
    const matches = dirs.filter((d) => d.startsWith(`${a.pkg}@`));
    if (matches.length !== 1) throw new Error(`tsup: expected exactly one ${a.pkg} in ${store}, found ${matches.length}`);
    const src = path.join(store, matches[0]!, "node_modules", a.pkg, a.file);
    const dest = path.join("dist", a.to);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

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
  onSuccess: async () => copyRuntimeAssets(),
});
