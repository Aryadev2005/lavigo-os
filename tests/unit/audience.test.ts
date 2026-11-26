/** Fill seats audience (DEP-3): dedupe across reasons and the opt-in split. */
import { describe, expect, it } from "vitest";
import { buildAudience, reasonSummary, type Candidate } from "@/server/domain/departures/audience";

const c = (customerId: string, reason: Candidate["reason"], optedIn = true, hasPhone = true): Candidate => ({ customerId, reason, optedIn, hasPhone });

describe("buildAudience", () => {
  it("counts a person once, under their strongest reason, keeping every reason", () => {
    const a = buildAudience([c("amit", "PAST_TRAVELLER"), c("amit", "UNCONVERTED_ENQUIRY"), c("amit", "WAITLIST"), c("sneha", "PAST_TRAVELLER"), c("sneha", "PAST_TRAVELLER")]);
    expect(a.recipients).toHaveLength(2);
    expect(a.recipients.find((r) => r.customerId === "amit")).toEqual({ customerId: "amit", reason: "WAITLIST", reasons: ["WAITLIST", "UNCONVERTED_ENQUIRY", "PAST_TRAVELLER"] });
    expect(a.byReason).toEqual({ WAITLIST: 1, UNCONVERTED_ENQUIRY: 0, PAST_TRAVELLER: 1 });
  });

  it("leaves out anyone without marketing opt-in, and counts them as skipped", () => {
    const a = buildAudience([c("riya", "UNCONVERTED_ENQUIRY", false), c("riya", "PAST_TRAVELLER", false), c("deepak", "PAST_TRAVELLER")]);
    expect(a.recipients.map((r) => r.customerId)).toEqual(["deepak"]);
    expect(a.skippedNoOptIn.map((r) => r.customerId)).toEqual(["riya"]);
    expect(a.byReason.UNCONVERTED_ENQUIRY).toBe(0);
  });

  it("skips opted-in people with no WhatsApp number, and excluded ids (already booked or messaged)", () => {
    const a = buildAudience([c("nophone", "WAITLIST", true, false), c("booked", "PAST_TRAVELLER"), c("ok", "PAST_TRAVELLER")], new Set(["booked"]));
    expect(a.recipients.map((r) => r.customerId)).toEqual(["ok"]);
    expect(a.skippedNoPhone.map((r) => r.customerId)).toEqual(["nophone"]);
  });

  it("summarises reasons for the panel", () => {
    const a = buildAudience([c("a", "PAST_TRAVELLER"), c("b", "PAST_TRAVELLER"), c("e", "UNCONVERTED_ENQUIRY"), c("w", "WAITLIST")]);
    expect(reasonSummary(a)).toBe("2 past travellers, 1 enquiry that didn't book, 1 on the waitlist");
    expect(reasonSummary(buildAudience([]))).toBe("Nobody matches yet");
  });
});
