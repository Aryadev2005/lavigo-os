/**
 * Validated environment. Fails fast on bad config.
 *
 * - Development / test: empty provider keys mean "use the fake adapter".
 * - Production: every provider key is required and the process refuses to boot without it.
 *
 * v1 has no AI/LLM features, so there are deliberately no LLM provider or AI_* variables here.
 *
 * Access is lazy (`env.X` parses on first use) so `next build` can import modules
 * without a full runtime environment. Call `assertEnv()` at process start
 * (instrumentation.ts and the worker) to fail fast.
 */
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const boolString = z
  .preprocess(emptyToUndefined, z.enum(["true", "false", "1", "0"]).optional())
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  TZ: z.string().default("Asia/Kolkata"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  AUTH_SECRET: z.string().min(1),

  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default("ap-south-1"),
  S3_BUCKET: z.string().default("lavigo"),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,

  SMTP_URL: optionalString,
  MAIL_FROM: z.string().default("Lavigo Travel <noreply@lavigo.in>"),

  META_APP_SECRET: optionalString,
  GRAPH_API_VERSION: optionalString,
  WA_PHONE_NUMBER_ID: optionalString,
  WA_ACCESS_TOKEN: optionalString,
  WA_VERIFY_TOKEN: optionalString,
  IG_ACCOUNT_ID: optionalString,
  IG_ACCESS_TOKEN: optionalString,
  FEATURE_INSTAGRAM: boolString,

  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,

  PUBLIC_SITE_HOST: z.string().default("lavigo.in"),
  IRCTC_ARP_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(365).default(60)),
  SENTRY_DSN: optionalString,
});

type RawEnv = z.infer<typeof schema>;

/** Keys each real adapter needs. Empty in dev/test → fake adapter. */
const PROVIDER_KEYS = {
  whatsapp: ["META_APP_SECRET", "GRAPH_API_VERSION", "WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN", "WA_VERIFY_TOKEN"],
  instagram: ["META_APP_SECRET", "GRAPH_API_VERSION", "IG_ACCOUNT_ID", "IG_ACCESS_TOKEN"],
  razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
  smtp: ["SMTP_URL"],
  storage: ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
} as const satisfies Record<string, readonly (keyof RawEnv)[]>;

export type Provider = keyof typeof PROVIDER_KEYS;
export type ProviderMode = "real" | "fake";

export type Env = RawEnv & {
  isProd: boolean;
  isTest: boolean;
  providers: Record<Provider, ProviderMode>;
};

const WEAK_SECRETS = new Set(["change-me", "changeme", "secret"]);

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const raw = parsed.data;
  const isProd = raw.NODE_ENV === "production";

  const has = (k: keyof RawEnv) => raw[k] !== undefined && raw[k] !== "";
  const providers = {} as Record<Provider, ProviderMode>;
  const missing: string[] = [];

  for (const [provider, keys] of Object.entries(PROVIDER_KEYS) as [Provider, readonly (keyof RawEnv)[]][]) {
    const allSet = keys.every(has);
    if (provider === "instagram" && !raw.FEATURE_INSTAGRAM) {
      providers[provider] = allSet ? "real" : "fake";
      continue;
    }
    if (isProd && !allSet) missing.push(...keys.filter((k) => !has(k)));
    providers[provider] = allSet ? "real" : "fake";
  }

  if (isProd) {
    if (raw.AUTH_SECRET.length < 32 || WEAK_SECRETS.has(raw.AUTH_SECRET)) missing.push("AUTH_SECRET (≥ 32 random chars)");
    if (missing.length > 0) {
      throw new Error(`Refusing to boot in production. Missing or weak: ${[...new Set(missing)].join(", ")}`);
    }
  }

  return { ...raw, isProd, isTest: raw.NODE_ENV === "test", providers };
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Call once at process start to fail fast. */
export function assertEnv(): Env {
  return getEnv();
}

/** Lazy accessor: `env.DATABASE_URL`. Parses on first property access. */
export const env: Env = new Proxy({} as Env, {
  get: (_t, prop) => getEnv()[prop as keyof Env],
});
