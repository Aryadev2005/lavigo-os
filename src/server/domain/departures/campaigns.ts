/**
 * Fill seats campaigns (DEP-3, DEP-4). Preview → Campaign + recipients → campaign.send job, which
 * sends each recipient the approved MARKETING template through outbound.sendTemplate (provider
 * sends are rate-limited by the outbound.send worker). Attribution: a booking on the departure
 * within 7 days of the send, by a recipient, is credited to the campaign.
 */
import { audit } from "../../audit";
import { db } from "../../db";
import { env } from "../../env";
import { logger } from "../../logger";
import { inr } from "../../money";
import { renderTemplate, sendTemplate } from "../../channels/outbound";
import { publish } from "../../pubsub";
import { enqueue } from "../../queue";
import { formatDate, formatIST } from "../../time";
import { findAudience, reasonSummary, type Audience } from "./audience";

export const OFFER_TEMPLATE = "seat_fill_offer"; // with a limited-time discount
export const NUDGE_TEMPLATE = "seat_fill_nudge"; // no discount
export const ATTRIBUTION_DAYS = 7;

export type Actor = { id: string; role: "OWNER" | "STAFF" };

export class CampaignError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID" | "EMPTY" | "NO_TEMPLATE",
    message: string,
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export type FillOptions = { discountPerPax: number | null; validUntil: Date | null };

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

async function departureFacts(departureId: string) {
  const dep = await db.departure.findUnique({ where: { id: departureId }, include: { trip: { select: { title: true, name: true } } } });
  if (!dep) throw new CampaignError("NOT_FOUND", "Departure not found");
  const sold = (await db.booking.aggregate({ where: { departureId, status: { in: ["HELD", "CONFIRMED", "COMPLETED"] } }, _sum: { pax: true } }))._sum.pax ?? 0;
  return { dep, seatsLeft: Math.max(0, dep.seatsTotal - sold) };
}

function varsFor(name: string, f: Awaited<ReturnType<typeof departureFacts>>, opts: FillOptions): Record<string, string> {
  return {
    name: firstName(name),
    trip: f.dep.trip.title,
    date: formatDate(f.dep.startDate),
    seats_left: String(f.seatsLeft),
    discount: opts.discountPerPax ? inr(opts.discountPerPax) : "",
    valid_until: opts.validUntil ? formatIST(opts.validUntil, "EEEE d MMM") : "",
    link: `${env.PUBLIC_SITE_HOST}/${f.dep.code.toLowerCase()}`,
  };
}

function validate(opts: FillOptions, now: Date) {
  if (opts.discountPerPax !== null && (!Number.isSafeInteger(opts.discountPerPax) || opts.discountPerPax <= 0)) throw new CampaignError("INVALID", "Enter the discount in rupees");
  if (opts.discountPerPax && !opts.validUntil) throw new CampaignError("INVALID", "Pick until when the discount is valid");
  if (opts.validUntil && opts.validUntil <= now) throw new CampaignError("INVALID", "The offer must end in the future");
}

export type FillPreview = {
  departureId: string;
  total: number;
  reasons: string;
  byReason: Audience["byReason"];
  skippedNoOptIn: number;
  skippedNoPhone: number;
  template: string;
  /** The template body with real values ({name} stays a placeholder). */
  message: string;
  seatsLeft: number;
};

/** The panel: "Found N people likely to book", reasons and the rendered template. */
export async function previewFill(departureId: string, opts: FillOptions, now: Date = new Date()): Promise<FillPreview> {
  validate(opts, now);
  const [facts, audience] = await Promise.all([departureFacts(departureId), findAudience(departureId, now)]);
  const name = opts.discountPerPax ? OFFER_TEMPLATE : NUDGE_TEMPLATE;
  const template = await db.messageTemplate.findUnique({ where: { name } });
  if (!template) throw new CampaignError("NO_TEMPLATE", `The ${name} template isn't set up`);
  const message = renderTemplate(template, { ...varsFor("{name}", facts, opts), name: "{name}" });
  return {
    departureId,
    total: audience.recipients.length,
    reasons: reasonSummary(audience),
    byReason: audience.byReason,
    skippedNoOptIn: audience.skippedNoOptIn.length,
    skippedNoPhone: audience.skippedNoPhone.length,
    template: name,
    message,
    seatsLeft: facts.seatsLeft,
  };
}

/**
 * "Send to N people": one Campaign with its recipients, created under a per-departure advisory
 * lock so two clicks can't build two overlapping audiences. Anyone messaged for this departure in
 * the last 7 days is already outside the audience, so a second send never reaches them again.
 */
export async function createCampaign(departureId: string, opts: FillOptions, actor: Actor, now: Date = new Date()) {
  validate(opts, now);
  const facts = await departureFacts(departureId);
  const templateName = opts.discountPerPax ? OFFER_TEMPLATE : NUDGE_TEMPLATE;
  const template = await db.messageTemplate.findUnique({ where: { name: templateName } });
  if (!template || template.metaStatus !== "APPROVED" || template.category !== "MARKETING") throw new CampaignError("NO_TEMPLATE", `The ${templateName} template isn't approved`);

  const campaign = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign:${departureId}`}))`;
    const audience = await findAudience(departureId, now);
    if (!audience.recipients.length) throw new CampaignError("EMPTY", "Nobody new to message for this departure right now");
    const c = await tx.campaign.create({
      data: {
        departureId,
        name: `Fill seats · ${facts.dep.code} · ${formatIST(now, "d MMM")}`,
        templateName,
        discountPerPax: opts.discountPerPax,
        validUntil: opts.validUntil,
        audienceSpec: { pastTravellers: true, unconvertedEnquiries: true, waitlist: true, byReason: audience.byReason, skippedNoOptIn: audience.skippedNoOptIn.length },
        status: "SENDING",
        createdById: actor.id,
        sentAt: now,
      },
    });
    await tx.campaignRecipient.createMany({
      data: [
        ...audience.recipients.map((r) => ({ campaignId: c.id, customerId: r.customerId, reason: r.reason, status: "QUEUED" as const })),
        ...audience.skippedNoOptIn.map((r) => ({ campaignId: c.id, customerId: r.customerId, reason: r.reason, status: "SKIPPED_NO_OPTIN" as const })),
      ],
      skipDuplicates: true,
    });
    await audit({ userId: actor.id, action: "campaign.create", entityType: "Campaign", entityId: c.id, after: { departureId, templateName, recipients: audience.recipients.length, skippedNoOptIn: audience.skippedNoOptIn.length, discountPerPax: opts.discountPerPax } }, tx);
    return { ...c, recipients: audience.recipients.length };
  });
  await enqueue("campaign.send", { campaignId: campaign.id }, { jobId: `campaign-send-${campaign.id}` });
  return campaign;
}

/** Pause between recipients inside one job: provider sends are also limited by outbound.send. */
const PACE_MS = 150;

/**
 * campaign.send job. Each QUEUED recipient is claimed (QUEUED → SENT) before sending, so a rerun,
 * a retry or a second job for the same campaign never messages anyone twice.
 */
export async function sendCampaign(campaignId: string, opts: { paceMs?: number } = {}) {
  const c = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!c) return { sent: 0, failed: 0, skipped: "not found" };
  if (c.status === "CANCELLED") return { sent: 0, failed: 0, skipped: "cancelled" };
  const facts = await departureFacts(c.departureId);
  const pending = await db.campaignRecipient.findMany({ where: { campaignId, status: "QUEUED" }, include: { customer: { select: { name: true } } }, orderBy: { id: "asc" } });
  let sent = 0;
  let failed = 0;
  for (const r of pending) {
    const claim = await db.campaignRecipient.updateMany({ where: { id: r.id, status: "QUEUED" }, data: { status: "SENT" } });
    if (!claim.count) continue;
    try {
      const res = await sendTemplate({ customerId: r.customerId }, c.templateName, varsFor(r.customer.name, facts, { discountPerPax: c.discountPerPax, validUntil: c.validUntil }), {
        authorUserId: c.createdById,
      });
      if (res.sent) {
        await db.campaignRecipient.update({ where: { id: r.id }, data: { messageId: res.messageId } });
        sent += 1;
      } else {
        // NOT_OPTED_IN here means the customer opted out after the audience was built.
        await db.campaignRecipient.update({ where: { id: r.id }, data: { status: res.reason === "NOT_OPTED_IN" ? "SKIPPED_NO_OPTIN" : "FAILED" } });
        failed += 1;
      }
    } catch (err) {
      logger.warn({ campaignId, recipientId: r.id, err: String(err) }, "campaign send failed");
      await db.campaignRecipient.update({ where: { id: r.id }, data: { status: "FAILED" } });
      failed += 1;
    }
    if (opts.paceMs ?? PACE_MS) await new Promise((res) => setTimeout(res, opts.paceMs ?? PACE_MS));
  }
  if (!(await db.campaignRecipient.count({ where: { campaignId, status: "QUEUED" } }))) {
    await db.campaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "SENT" } });
  }
  if (sent) {
    const a = await db.activityEvent.create({
      data: { type: "campaign.sent", icon: "📣", text: `Fill seats: ${facts.dep.trip.name} ${formatDate(facts.dep.startDate)} offer sent to ${sent} people on WhatsApp`, actorType: "SYSTEM", entityType: "Campaign", entityId: campaignId },
    });
    await publish({ type: "activity.created", payload: { activityId: a.id, text: a.text, icon: a.icon } }).catch(() => undefined);
  }
  return { sent, failed };
}

/**
 * campaign.attribute job (DEP-4): a confirmed booking on a departure by someone a campaign for that
 * departure reached in the last 7 days is credited to the latest such campaign. Idempotent.
 */
export async function attributeBooking(bookingId: string, now: Date = new Date()) {
  const b = await db.booking.findUnique({ where: { id: bookingId }, select: { id: true, customerId: true, departureId: true, status: true } });
  if (!b?.departureId || (b.status !== "CONFIRMED" && b.status !== "COMPLETED")) return { attributed: false };
  if (await db.campaignRecipient.findFirst({ where: { convertedBookingId: b.id }, select: { id: true } })) return { attributed: true, already: true };
  const since = new Date(now.getTime() - ATTRIBUTION_DAYS * 86_400_000);
  const r = await db.campaignRecipient.findFirst({
    where: { customerId: b.customerId, status: "SENT", convertedBookingId: null, campaign: { departureId: b.departureId, sentAt: { gte: since, lte: now } } },
    orderBy: { campaign: { sentAt: "desc" } },
  });
  if (!r) return { attributed: false };
  const { count } = await db.campaignRecipient.updateMany({ where: { id: r.id, convertedBookingId: null }, data: { convertedBookingId: b.id } });
  return { attributed: count === 1, campaignId: r.campaignId };
}
