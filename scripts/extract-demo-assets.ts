/**
 * One-off: pulls the embedded assets out of docs/reference/lavigo-os-demo.html
 * into public/ so the app serves real files instead of base64 blobs.
 *
 *   docker compose run --rm --no-deps web pnpm extract-assets
 *
 * Idempotent: re-running overwrites the same files.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEMO = path.join(ROOT, "docs/reference/lavigo-os-demo.html");

type Asset = { name: string; pattern: RegExp; out: string };

const B64 = "([A-Za-z0-9+/=]+)";
const ASSETS: Asset[] = [
  {
    name: "Italiana font",
    pattern: new RegExp(`font-family:"Italiana";src:url\\(data:font/woff2;base64,${B64}\\)`),
    out: "public/fonts/Italiana-Regular.woff2",
  },
  {
    name: "Lavigo logo",
    pattern: new RegExp(`class="brand"><img src="data:image/webp;base64,${B64}"`),
    out: "public/images/logo.webp",
  },
  ...(
    [
      ["nepal", "nepal"],
      ["darj", "darjeeling"],
      ["sikkim", "sikkim"],
      ["net", "netarhat"],
    ] as const
  ).map(([key, file]) => ({
    name: `departure image ${file}`,
    pattern: new RegExp(`[{,]${key}:"data:image/jpeg;base64,${B64}"`),
    out: `public/images/departures/${file}.jpg`,
  })),
];

async function main() {
  const html = await readFile(DEMO, "utf8");
  for (const asset of ASSETS) {
    const match = asset.pattern.exec(html);
    if (!match?.[1]) throw new Error(`Not found in demo HTML: ${asset.name}`);
    const bytes = Buffer.from(match[1], "base64");
    const target = path.join(ROOT, asset.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`${asset.out.padEnd(42)} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  (${asset.name})`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
