/** INB-1: Meta webhooks are accepted only with a valid X-Hub-Signature-256 over the raw body. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signMetaBody, verifyMetaSignature } from "@/server/channels/verify";

const SECRET = "test-app-secret";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [{ id: "wamid.1" }] } }] }] });
const valid = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

describe("verifyMetaSignature", () => {
  it("accepts a valid signature (and signMetaBody produces it)", () => {
    expect(signMetaBody(BODY, SECRET)).toBe(valid);
    expect(verifyMetaSignature(BODY, valid, SECRET)).toBe(true);
    expect(verifyMetaSignature(BODY, valid.toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe(true);
  });

  it("rejects a signature for a different body, secret or a tampered digest", () => {
    expect(verifyMetaSignature(`${BODY} `, valid, SECRET)).toBe(false); // re-serialised body
    expect(verifyMetaSignature(BODY, valid, "other-secret")).toBe(false);
    const tampered = valid.slice(0, -1) + (valid.endsWith("0") ? "1" : "0");
    expect(verifyMetaSignature(BODY, tampered, SECRET)).toBe(false);
  });

  it("rejects malformed headers: wrong scheme, bare hex, truncated, non-hex", () => {
    const hex = valid.slice("sha256=".length);
    expect(verifyMetaSignature(BODY, `sha1=${hex}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, hex, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, valid.slice(0, -2), SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, `sha256=${"z".repeat(64)}`, SECRET)).toBe(false);
  });

  it("rejects a missing header or an empty secret", () => {
    expect(verifyMetaSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, signMetaBody(BODY, ""), "")).toBe(false);
  });
});
