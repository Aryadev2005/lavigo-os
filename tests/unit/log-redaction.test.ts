/** Log redaction (design §10 "Secrets leakage", NFR-4): tokens, phones and webhook payloads never reach logs. */
import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS, scrub } from "@/server/logger";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  return { log: pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, stream), lines };
}

describe("scrub", () => {
  it("masks phone numbers, keeping the last 4 digits", () => {
    expect(scrub("send to +919835011223 failed")).toBe("send to [phone …1223] failed");
    expect(scrub("call 98350 11223")).toBe("call [phone …1223]");
  });
  it("masks bearer tokens, token query params and long secrets", () => {
    expect(scrub("Authorization: Bearer EAAGm0PX4ZCpsBA.xyz")).toBe("Authorization: Bearer [redacted]");
    expect(scrub("GET /v21.0/media?access_token=EAAG123&x=1")).toBe("GET /v21.0/media?access_token=[redacted]&x=1");
    expect(scrub(`sig ${"a1".repeat(32)}`)).toBe("sig [redacted]");
  });
  it("leaves amounts, booking codes and dates alone", () => {
    expect(scrub("LVG-24901 paid ₹19,799 on 2026-11-28")).toBe("LVG-24901 paid ₹19,799 on 2026-11-28");
  });
});

describe("REDACT_PATHS", () => {
  it("redacts tokens, phones, recipients, template vars and webhook payloads by key", () => {
    const { log, lines } = capture();
    log.info({ to: "+919835011223", vars: { name: "Riya" }, payload: { entry: [] }, body: "{...}", customer: { phone: "+91983" }, accessToken: "EAAG", headers: { authorization: "Bearer x" }, a: { b: { token: "t" } } }, "x");
    const out = JSON.parse(lines[0]!);
    expect(out.to).toBe("[redacted]");
    expect(out.vars).toBe("[redacted]");
    expect(out.payload).toBe("[redacted]");
    expect(out.body).toBe("[redacted]");
    expect(out.customer.phone).toBe("[redacted]");
    expect(out.accessToken).toBe("[redacted]");
    expect(out.headers.authorization).toBe("[redacted]");
    expect(out.a.b.token).toBe("[redacted]");
  });
});
