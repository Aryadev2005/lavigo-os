/**
 * WhatsApp templates: prisma/seed.ts is the single source of truth (design §7).
 *  - every template name used in src/ is seeded, and every seeded template is used;
 *  - bodies follow Meta's rules (sequential {{n}} matching the variables, never starting or ending
 *    with a variable, one sample per variable);
 *  - docs/META-TEMPLATES.md is regenerated from the seed (`pnpm templates:doc`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REMINDER_RULES, TEMPLATES } from "../../prisma/seed";
import { META_TEMPLATES_PATH, renderMetaTemplates } from "../../scripts/gen-meta-templates";

const ROOT = path.resolve(import.meta.dirname, "../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** snake_case string literals on lines that talk about templates (sendTemplate, *_TEMPLATE, name: …). */
function templateNamesUsedInSrc(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sources(path.join(ROOT, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/template/i.test(line)) return;
      for (const m of line.matchAll(/["'`]([a-z]+(?:_[a-z]+)+)["'`]/g)) used.set(m[1]!, `${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  return used;
}

const seeded = new Set(TEMPLATES.map((t) => t.name));

describe("templates", () => {
  it("every template name used in code is seeded", () => {
    const missing = [...templateNamesUsedInSrc()].filter(([name]) => !seeded.has(name)).map(([name, at]) => `${name} (${at})`);
    expect(missing).toEqual([]);
  });

  it("every seeded template is used (in code or by a reminder rule)", () => {
    const used = new Set([...templateNamesUsedInSrc().keys(), ...REMINDER_RULES.flatMap((r) => ("templateName" in r ? [r.templateName] : []))]);
    expect([...seeded].filter((n) => !used.has(n))).toEqual([]);
  });

  it("names are unique and bodies follow Meta's placeholder rules", () => {
    expect(seeded.size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(nums, t.name).toEqual(t.variables.map((_, i) => i + 1));
      expect(t.samples, t.name).toHaveLength(t.variables.length);
      expect(t.body.trim(), `${t.name} starts with a variable`).not.toMatch(/^\{\{\d+\}\}/);
      expect(t.body.trim(), `${t.name} ends with a variable`).not.toMatch(/\{\{\d+\}\}[.!?]?$/);
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{0,511}$/);
      expect(t.body.length, t.name).toBeLessThanOrEqual(1024);
    }
  });

  it("docs/META-TEMPLATES.md is up to date (run `pnpm templates:doc`)", () => {
    expect(readFileSync(META_TEMPLATES_PATH, "utf8")).toBe(renderMetaTemplates());
  });
});
