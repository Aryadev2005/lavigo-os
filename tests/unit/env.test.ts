/** Production refuses to boot without its secrets; dev fallbacks never apply there (CLAUDE.md, §11). */
import { describe, expect, it } from "vitest";
import { parseEnv } from "@/server/env";

const PROD: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@db:5432/lavigo",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(40),
  S3_ENDPOINT: "https://s3.example.com",
  S3_ACCESS_KEY: "ak",
  S3_SECRET_KEY: "sk",
  SMTP_URL: "smtp://mail:25",
  META_APP_SECRET: "meta-secret",
  GRAPH_API_VERSION: "v21.0",
  WA_PHONE_NUMBER_ID: "123",
  WA_ACCESS_TOKEN: "wa-token",
  WA_VERIFY_TOKEN: "verify-token",
  RAZORPAY_KEY_ID: "rzp_live_x",
  RAZORPAY_KEY_SECRET: "rzp-secret",
  RAZORPAY_WEBHOOK_SECRET: "rzp-webhook-secret",
};

describe("parseEnv in production", () => {
  it("boots with every secret set, using exactly those values", () => {
    const env = parseEnv(PROD);
    expect(env.secrets).toEqual({
      AUTH_SECRET: PROD.AUTH_SECRET,
      META_APP_SECRET: "meta-secret",
      WA_VERIFY_TOKEN: "verify-token",
      RAZORPAY_WEBHOOK_SECRET: "rzp-webhook-secret",
    });
  });

  it.each(["META_APP_SECRET", "WA_VERIFY_TOKEN", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "AUTH_SECRET"])(
    "throws without %s",
    (key) => {
      const { [key]: _gone, ...rest } = PROD;
      expect(() => parseEnv(rest)).toThrow(new RegExp(`Refusing to boot in production.*${key}`));
      expect(() => parseEnv({ ...rest, [key]: "" })).toThrow(/Refusing to boot/);
    },
  );

  it("rejects a weak AUTH_SECRET", () => {
    expect(() => parseEnv({ ...PROD, AUTH_SECRET: "change-me" })).toThrow(/AUTH_SECRET/);
  });
});

describe("parseEnv in development", () => {
  it("falls back to dev-only secrets and fake providers when keys are empty", () => {
    const env = parseEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@db/x" });
    expect(env.providers.whatsapp).toBe("fake");
    expect(env.providers.razorpay).toBe("fake");
    for (const v of Object.values(env.secrets)) expect(v.length).toBeGreaterThan(0);
  });
});
