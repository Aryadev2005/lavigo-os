/**
 * Fill seats audience (DEP-3). Rule-based, no LLM:
 *  - past travellers: CONFIRMED/COMPLETED bookings on other departures (with a tag in common with
 *    the trip, when the trip has tags);
 *  - unconverted enquiries: chats about this departure, or quotes for it, in the last 180 days,
 *    with no booking;
 *  - the waitlist.
 * Everyone already booked on the departure is left out. People are deduped across reasons, then
 * split into who can get a marketing message (opted in, has a WhatsApp number) and who is skipped.
 */
import type { AudienceReason } from "@prisma/client";
import { db } from "../../db";

export const ENQUIRY_LOOKBACK_DAYS = 180;
/** Nobody gets a second Fill seats message for the same departure within this many days. */
export const RECENTLY_MESSAGED_DAYS = 7;

/** Strongest reason first: it's the one a person is counted under. */
const PRIORITY: AudienceReason[] = ["WAITLIST", "UNCONVERTED_ENQUIRY", "PAST_TRAVELLER"];

export type Candidate = { customerId: string; reason: AudienceReason; optedIn: boolean; hasPhone: boolean };

export type AudienceMember = { customerId: string; reason: AudienceReason; reasons: AudienceReason[] };

export type Audience = {
  /** Opted in, with a WhatsApp number: these get the message. */
  recipients: AudienceMember[];
  /** Matched but not opted in to marketing (DEP-3 "skipped (no opt-in)"). */
  skippedNoOptIn: AudienceMember[];
  /** Opted in but no number to message. */
  skippedNoPhone: AudienceMember[];
  /** Recipients by their main reason. */
  byReason: Record<AudienceReason, number>;
};

/** PURE: dedupe across reasons (one entry per person, under their strongest reason), then split. */
export function buildAudience(candidates: readonly Candidate[], exclude: ReadonlySet<string> = new Set()): Audience {
  const people = new Map<string, { reasons: Set<AudienceReason>; optedIn: boolean; hasPhone: boolean }>();
  for (const c of candidates) {
    if (exclude.has(c.customerId)) continue;
    const p = people.get(c.customerId) ?? { reasons: new Set<AudienceReason>(), optedIn: c.optedIn, hasPhone: c.hasPhone };
    p.reasons.add(c.reason);
    people.set(c.customerId, p);
  }
  const out: Audience = { recipients: [], skippedNoOptIn: [], skippedNoPhone: [], byReason: { WAITLIST: 0, UNCONVERTED_ENQUIRY: 0, PAST_TRAVELLER: 0 } };
  for (const [customerId, p] of [...people.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const reasons = PRIORITY.filter((r) => p.reasons.has(r));
    const member = { customerId, reason: reasons[0]!, reasons };
    if (!p.optedIn) out.skippedNoOptIn.push(member);
    else if (!p.hasPhone) out.skippedNoPhone.push(member);
    else {
      out.recipients.push(member);
      out.byReason[member.reason] += 1;
    }
  }
  return out;
}

/** Load candidates for a departure from the DB and build the audience. */
export async function findAudience(departureId: string, now: Date = new Date()): Promise<Audience> {
  const dep = await db.departure.findUniqueOrThrow({ where: { id: departureId }, include: { trip: { select: { tags: true } } } });
  const since = new Date(now.getTime() - ENQUIRY_LOOKBACK_DAYS * 86_400_000);
  const recent = new Date(now.getTime() - RECENTLY_MESSAGED_DAYS * 86_400_000);
  const customer = { select: { id: true, marketingOptIn: true, phone: true } } as const;

  const [booked, past, chats, quotes, waitlist, messaged] = await Promise.all([
    db.booking.findMany({ where: { departureId, status: { not: "CANCELLED" } }, select: { customerId: true } }),
    db.booking.findMany({
      where: {
        departureId: { not: null, notIn: [departureId] },
        status: { in: ["CONFIRMED", "COMPLETED"] },
        ...(dep.trip.tags.length ? { customer: { tags: { hasSome: dep.trip.tags } } } : {}),
      },
      select: { customer },
    }),
    db.conversation.findMany({ where: { interestedDepartureId: departureId, customerId: { not: null }, lastMessageAt: { gte: since } }, select: { customer } }),
    db.quote.findMany({ where: { departureId, createdAt: { gte: since } }, select: { customer } }),
    db.waitlistEntry.findMany({ where: { departureId }, select: { customer } }),
    // Already messaged (or queued) for this departure recently: not again.
    db.campaignRecipient.findMany({ where: { status: { in: ["QUEUED", "SENT"] }, campaign: { departureId, createdAt: { gte: recent } } }, select: { customerId: true } }),
  ]);

  const c = (reason: AudienceReason) => (r: { customer: { id: string; marketingOptIn: boolean; phone: string | null } | null }): Candidate[] =>
    r.customer ? [{ customerId: r.customer.id, reason, optedIn: r.customer.marketingOptIn, hasPhone: !!r.customer.phone }] : [];
  const candidates = [
    ...past.flatMap(c("PAST_TRAVELLER")),
    ...chats.flatMap(c("UNCONVERTED_ENQUIRY")),
    ...quotes.flatMap(c("UNCONVERTED_ENQUIRY")),
    ...waitlist.flatMap(c("WAITLIST")),
  ];
  return buildAudience(candidates, new Set([...booked.map((b) => b.customerId), ...messaged.map((m) => m.customerId)]));
}

/** "Past travellers who liked hill trips, enquiries that didn't book, and the waitlist." */
export function reasonSummary(a: Audience): string {
  const parts: string[] = [];
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (a.byReason.PAST_TRAVELLER) parts.push(n(a.byReason.PAST_TRAVELLER, "past traveller", "past travellers"));
  if (a.byReason.UNCONVERTED_ENQUIRY) parts.push(n(a.byReason.UNCONVERTED_ENQUIRY, "enquiry that didn't book", "enquiries that didn't book"));
  if (a.byReason.WAITLIST) parts.push(n(a.byReason.WAITLIST, "on the waitlist", "on the waitlist"));
  return parts.length ? parts.join(", ") : "Nobody matches yet";
}
