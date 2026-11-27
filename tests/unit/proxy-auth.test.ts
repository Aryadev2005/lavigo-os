/**
 * Proxy guard (NFR-4): a signed-out server-action POST is refused with 401 before Next reads the
 * body (limit 21 MB). Only /login may receive one, with a declared Content-Length ≤ 16 KB.
 */
import { describe, expect, it } from "vitest";
import { MAX_ANON_ACTION_BYTES, rejectAnonymousAction } from "@/server/auth.config";

const post = (path: string, headers: Record<string, string>) => new Request(`http://localhost${path}`, { method: "POST", headers });

describe("rejectAnonymousAction", () => {
  it("401s a signed-out server action on any app page", () => {
    for (const path of ["/inbox", "/", "/dev/pay/plink_x", "/rules"]) {
      const r = rejectAnonymousAction(post(path, { "next-action": "abc", "content-length": "20" }), false, path);
      expect(r?.status).toBe(401);
    }
  });
  it("lets the small login action through, but not a big or undeclared body", () => {
    expect(rejectAnonymousAction(post("/login", { "next-action": "abc", "content-length": "300" }), false, "/login")).toBeNull();
    expect(rejectAnonymousAction(post("/login", { "next-action": "abc", "content-length": String(MAX_ANON_ACTION_BYTES + 1) }), false, "/login")?.status).toBe(401);
    expect(rejectAnonymousAction(post("/login", { "next-action": "abc", "content-length": String(21 * 1024 * 1024) }), false, "/login")?.status).toBe(401);
    expect(rejectAnonymousAction(post("/login", { "next-action": "abc" }), false, "/login")?.status).toBe(401);
  });
  it("ignores signed-in callers and requests that aren't server actions", () => {
    expect(rejectAnonymousAction(post("/inbox", { "next-action": "abc" }), true, "/inbox")).toBeNull();
    expect(rejectAnonymousAction(post("/inbox", {}), false, "/inbox")).toBeNull();
    expect(rejectAnonymousAction(new Request("http://localhost/inbox"), false, "/inbox")).toBeNull();
  });
});
