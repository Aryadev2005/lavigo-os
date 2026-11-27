/**
 * Authorization lint (NFR-4, AUTH-3; design §10). Runs in CI: `pnpm check:actions`.
 *
 * Lists every server action ("use server" file exports and inline "use server" functions), every
 * route handler (route.ts GET/POST/…) and every page, and fails when one doesn't call
 * requireUser()/currentUser() — directly or through a helper defined in the same file — or doesn't
 * require the OWNER role where the policy below says it must. Public entry points are an explicit
 * allowlist, each with the control that replaces the session check.
 *
 * It is a static check: it proves the call is present in the function body, not that every code
 * path reaches it. The data layer (requireUser in domain calls, assertOwner) is the second line.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "src/app");

type Kind = "action" | "route" | "page";
type Entry = { kind: Kind; file: string; name: string; calls: Set<string>; ownerRole: boolean; text: string };

/** Public entry points and what protects them instead of a session. */
const PUBLIC: Record<string, string> = {
  "src/app/(auth)/login/actions.ts#loginAction": "credentials check + rate limit/lockout (AUTH-2)",
  "src/app/(app)/actions.ts#signOutAction": "only clears the caller's own session",
  "src/app/(auth)/login/page.tsx#default": "login form",
  "src/app/page.tsx#default": "redirects to /today",
  "src/app/api/health/route.ts#GET": "DB/Redis liveness only, no data",
  "src/app/api/auth/[...nextauth]/route.ts#GET": "Auth.js",
  "src/app/api/auth/[...nextauth]/route.ts#POST": "Auth.js",
  "src/app/api/webhooks/whatsapp/route.ts#GET": "Meta verify-token handshake (constant-time compare)",
  "src/app/api/webhooks/whatsapp/route.ts#POST": "HMAC on the raw body",
  "src/app/api/webhooks/instagram/route.ts#GET": "Meta verify-token handshake (constant-time compare)",
  "src/app/api/webhooks/instagram/route.ts#POST": "HMAC on the raw body",
  "src/app/api/webhooks/razorpay/route.ts#POST": "HMAC on the raw body",
};

/** Public handlers must still contain their replacement control (a call whose name matches). */
const PUBLIC_MUST_CALL: Record<string, RegExp> = {
  // ingest*Webhook verifies the HMAC first (tests/integration/payment-webhook, inbound-dedupe).
  "src/app/api/webhooks/whatsapp/route.ts#POST": /^ingestMetaWebhook$/,
  "src/app/api/webhooks/instagram/route.ts#POST": /^ingestMetaWebhook$/,
  "src/app/api/webhooks/razorpay/route.ts#POST": /^ingestRazorpayWebhook$/,
  "src/app/api/webhooks/whatsapp/route.ts#GET": /^verifySubscription$/,
  "src/app/api/webhooks/instagram/route.ts#GET": /^verifySubscription$/,
  "src/app/(auth)/login/actions.ts#loginAction": /^signIn$/,
};

/** Entry points that must require OWNER: requireUser("OWNER") somewhere in their call chain. */
function mustBeOwner(e: Entry): boolean {
  const f = e.file;
  if (/\/(profit|rules)\//.test(f)) return true; // PRF-3, RUL-4: whole screens
  if (/\/approvals\//.test(f)) return true; // /approvals/[id]: owner decides (DESK-5)
  if (e.kind === "action" && /decide|approve|counter/i.test(e.name)) return true; // approval decisions
  if (e.kind === "action" && /^(cancelBooking|toggleReminderRule)/.test(e.name)) return true; // BKG-8, PAY-6
  return false;
}

const AUTH_CALLS = new Set(["requireUser", "currentUser"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const hasDirective = (body: ts.Block | ts.SourceFile | undefined, d: string) =>
  !!body &&
  body.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === d);

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Calls (identifier names) in a function, plus whether requireUser("OWNER") appears. */
function callsIn(node: ts.Node) {
  const calls = new Set<string>();
  let owner = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name) {
        calls.add(name);
        if (name === "requireUser" && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === "OWNER") owner = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { calls, owner };
}

function analyse(file: string): Entry[] {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fileUseServer = hasDirective(src, "use server");
  const isRoute = path.basename(file) === "route.ts";
  const isPage = path.basename(file) === "page.tsx";

  // Local functions by name, so a helper's auth call counts for the functions that call it.
  const locals = new Map<string, Fn>();
  const exported: { name: string; fn: Fn }[] = [];
  const inline: { name: string; fn: Fn }[] = [];

  const isExported = (n: ts.Node) => !!ts.getCombinedModifierFlags(n as ts.Declaration) && (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  const isDefault = (n: ts.Node) => (ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Default) !== 0;

  const visit = (n: ts.Node, topLevel: boolean) => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      locals.set(n.name.text, n);
      if (topLevel && isExported(n)) exported.push({ name: isDefault(n) ? "default" : n.name.text, fn: n });
      if (hasDirective(n.body, "use server")) inline.push({ name: n.name.text, fn: n });
    } else if (ts.isFunctionDeclaration(n) && !n.name && topLevel && isDefault(n)) {
      exported.push({ name: "default", fn: n });
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          locals.set(d.name.text, d.initializer);
          if (topLevel && isExported(n)) exported.push({ name: d.name.text, fn: d.initializer });
          if (ts.isBlock(d.initializer.body) && hasDirective(d.initializer.body, "use server")) inline.push({ name: d.name.text, fn: d.initializer });
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, false));
  };
  src.statements.forEach((s) => visit(s, true));

  // Transitive closure over same-file helpers.
  const closure = (fn: Fn, seen = new Set<Fn>()) => {
    const own = callsIn(fn);
    const calls = new Set(own.calls);
    let owner = own.owner;
    seen.add(fn);
    for (const c of own.calls) {
      const helper = locals.get(c);
      if (helper && !seen.has(helper)) {
        const sub = closure(helper, seen);
        sub.calls.forEach((x) => calls.add(x));
        owner ||= sub.owner;
      }
    }
    return { calls, owner };
  };

  const out: Entry[] = [];
  const add = (kind: Kind, name: string, fn: Fn) => {
    const { calls, owner } = closure(fn);
    out.push({ kind, file: rel, name, calls, ownerRole: owner, text: fn.getText(src) });
  };
  if (fileUseServer) exported.filter((e) => e.name !== "default").forEach((e) => add("action", e.name, e.fn));
  inline.forEach((e) => add("action", e.name, e.fn));
  if (isRoute) exported.filter((e) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(e.name)).forEach((e) => add("route", e.name, e.fn));
  if (isPage) exported.filter((e) => e.name === "default").forEach((e) => add("page", e.name, e.fn));
  return out;
}

/** Route handlers re-exported from a library (e.g. `export const { GET, POST } = handlers`). */
function reexportedHandlers(file: string): Entry[] {
  if (path.basename(file) !== "route.ts") return [];
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const text = readFileSync(file, "utf8");
  const m = /export const \{([^}]+)\}\s*=/.exec(text);
  if (!m) return [];
  return m[1]!.split(",").map((s) => s.trim()).filter((s) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(s)).map((name) => ({ kind: "route" as const, file: rel, name, calls: new Set<string>(), ownerRole: false, text }));
}

/** v1 has no AI/LLM features (CLAUDE.md, SRS §1.1): no LLM SDK, no AI env vars, no agent/llm dirs. */
const LLM_PACKAGES = /^(@anthropic-ai\/|anthropic$|openai$|@openai\/|langchain|@langchain\/|@google\/generative-ai|@google\/genai|cohere-ai|@mistralai\/|ollama|ai$|@ai-sdk\/|llamaindex)/;

function noLlmProblems(): string[] {
  const out: string[] = [];
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) if (LLM_PACKAGES.test(name)) out.push(`package.json ${field}: ${name} is an LLM dependency (v2 only)`);
  }
  const lock = readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8");
  for (const m of lock.matchAll(/^ {2}'?(@?[a-z0-9@/._-]+?)@\d/gm)) if (LLM_PACKAGES.test(m[1]!)) out.push(`pnpm-lock.yaml: ${m[1]} (LLM package, possibly transitive)`);
  for (const dir of ["src/server/agent", "src/server/llm"]) {
    try {
      statSync(path.join(ROOT, dir));
      out.push(`${dir} exists (v2 only)`);
    } catch {
      /* absent: good */
    }
  }
  const envTs = readFileSync(path.join(ROOT, "src/server/env.ts"), "utf8");
  for (const m of envTs.matchAll(/^\s+(ANTHROPIC_\w+|AI_\w+|OPENAI_\w+)\s*:/gm)) out.push(`src/server/env.ts declares ${m[1]} (v2 only)`);
  return out;
}

/** Pages under the authenticated (app) group also inherit (app)/layout.tsx's requireUser(). */
const LAYOUT_GUARDED = "src/app/(app)/";

function main() {
  const files = walk(APP);
  const entries = files.flatMap((f) => [...analyse(f), ...reexportedHandlers(f)]);
  const problems: string[] = [];
  const rows: string[] = [];

  for (const e of entries) {
    const key = `${e.file}#${e.name}`;
    const authed = [...AUTH_CALLS].some((c) => e.calls.has(c));
    const publicWhy = PUBLIC[key];
    let status: string;
    if (publicWhy) {
      const must = PUBLIC_MUST_CALL[key];
      if (must && ![...e.calls].some((c) => must.test(c))) problems.push(`${key}: public ${e.kind} lost its control (${publicWhy})`);
      status = `public: ${publicWhy}`;
    } else if (!authed && !(e.kind === "page" && e.file.startsWith(LAYOUT_GUARDED))) {
      problems.push(`${key}: ${e.kind} has no requireUser()/currentUser()`);
      status = "MISSING AUTH";
    } else {
      status = e.ownerRole ? "requireUser(OWNER)" : authed ? (e.calls.has("requireUser") ? "requireUser" : "currentUser") : "layout requireUser";
    }
    if (mustBeOwner(e) && !e.ownerRole) {
      problems.push(`${key}: must require the OWNER role`);
      status += " · NEEDS OWNER";
    }
    rows.push(`${e.kind.padEnd(6)} ${key.padEnd(72)} ${status}`);
  }
  for (const key of Object.keys(PUBLIC)) {
    if (!entries.some((e) => `${e.file}#${e.name}` === key)) problems.push(`${key}: allowlisted but not found (stale allowlist entry)`);
  }

  problems.push(...noLlmProblems());

  console.log(rows.sort().join("\n"));
  console.log(`\n${entries.filter((e) => e.kind === "action").length} server actions, ${entries.filter((e) => e.kind === "route").length} route handlers, ${entries.filter((e) => e.kind === "page").length} pages checked.`);
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("✓ every entry point checks the session (and OWNER where required); no LLM dependency");
}

main();
