/**
 * Tickets desk worker jobs: tickets.send (PDFs to each booking's chat) and
 * tickets.windowReminders (TKT-5 owner reminders at T−1 21:00 and T 07:45 IST).
 */
import { getAdapter } from "../../channels";
import { sendDocument } from "../../channels/outbound";
import { db } from "../../db";
import { logger } from "../../logger";
import { publish } from "../../pubsub";
import { formatDate, formatIST } from "../../time";
import { windowReminderTimes } from "./core";

// ───────────────────────────── tickets.send (TKT-7) ─────────────────────────────

export type TicketSendJob = { planId: string; docs: { documentId: string; bookingId: string; groupIndex: number; pnr: string }[] };

/**
 * Each booking's copy of its ticket PDF goes to the lead traveller's WhatsApp chat (the booking's
 * chat, else the customer's latest). Outside the 24-hour window it stays on the booking, with a note.
 */
export async function sendTickets(job: TicketSendJob) {
  const plan = await db.travelPlan.findUnique({ where: { id: job.planId }, select: { label: true } });
  const results: { documentId: string; sent: boolean; reason?: string }[] = [];
  for (const d of job.docs) {
    const doc = await db.document.findUnique({ where: { id: d.documentId }, select: { id: true, sentAt: true } });
    if (!doc) continue;
    if (doc.sentAt) {
      results.push({ documentId: doc.id, sent: true, reason: "already sent" });
      continue;
    }
    const b = await db.booking.findUnique({ where: { id: d.bookingId }, select: { code: true, customerId: true, conversationId: true } });
    if (!b) continue;
    const conv =
      (b.conversationId ? await db.conversation.findUnique({ where: { id: b.conversationId } }) : null) ??
      (await db.conversation.findFirst({ where: { customerId: b.customerId, channel: "WHATSAPP" }, orderBy: { lastMessageAt: "desc" } }));
    if (!conv) {
      results.push({ documentId: doc.id, sent: false, reason: "no WhatsApp chat" });
      continue;
    }
    const r = await sendDocument(conv.id, doc.id, "SYSTEM", `🎫 Your tickets for ${plan?.label ?? "your trip"} · PNR ${d.pnr}`);
    if (r.status === "BLOCKED") {
      await db.message.create({
        data: {
          conversationId: conv.id,
          direction: "OUTBOUND",
          author: "SYSTEM",
          kind: "SYSTEM_NOTE",
          status: "SENT",
          body: `🎫 Ticket PDF (PNR ${d.pnr}) is saved on booking ${b.code} but wasn't sent (${r.reason === "WINDOW_CLOSED" ? "the 24-hour window is closed" : r.reason}). Download it from the booking.`,
        },
      });
      await publish({ type: "conversation.updated", payload: { conversationId: conv.id } }).catch(() => undefined);
      results.push({ documentId: doc.id, sent: false, reason: r.reason });
    } else {
      await db.document.update({ where: { id: doc.id }, data: { sentAt: new Date() } });
      results.push({ documentId: doc.id, sent: true });
    }
  }
  const sent = results.filter((r) => r.sent).length;
  logger.info({ planId: job.planId, sent, total: results.length }, "tickets.send");
  return { sent, total: results.length };
}

// ───────────────────────────── tickets.windowReminders (TKT-5) ─────────────────────────────

/** Optional owner WhatsApp template: {{1}} plan, {{2}} when bookings open. Skipped unless APPROVED. */
export const WINDOW_TEMPLATE = "ticket_window";
/** A reminder is still useful until shortly after the window opens. */
const GRACE_MS = 30 * 60_000;

export async function windowReminders(now: Date = new Date()) {
  // Opened windows: the plan is bookable now.
  await db.travelPlan.updateMany({ where: { status: "WINDOW_PENDING", windowOpensAt: { lte: now } }, data: { status: "PLANNING" } });

  const plans = await db.travelPlan.findMany({
    where: { status: { not: "BOOKED" }, windowOpensAt: { gt: new Date(now.getTime() - GRACE_MS), lt: new Date(now.getTime() + 2 * 86_400_000) } },
    select: { id: true, label: true, travelDate: true, windowOpensAt: true },
  });
  let sent = 0;
  for (const p of plans) {
    const opens = p.windowOpensAt!;
    for (const r of windowReminderTimes(opens)) {
      if (now < r.at || now.getTime() > opens.getTime() + GRACE_MS) continue;
      const type = `tickets.window_reminder.${r.kind}`;
      const text =
        r.kind === "eve"
          ? `Train bookings for ${p.label} (${formatDate(p.travelDate)}) open tomorrow, ${formatIST(opens, "EEE d MMM")}, at 8:00 AM`
          : `Train bookings for ${p.label} (${formatDate(p.travelDate)}) open at 8:00 AM. Log in to IRCTC now`;
      // One reminder per plan and kind, even if two cron runs overlap.
      const created = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${type}:${p.id}`}))`;
        if (await tx.activityEvent.findFirst({ where: { type, entityId: p.id }, select: { id: true } })) return null;
        return tx.activityEvent.create({ data: { type, icon: "⏰", text, actorType: "SYSTEM", entityType: "TravelPlan", entityId: p.id } });
      });
      if (!created) continue;
      sent += 1;
      await publish({ type: "activity.created", payload: { activityId: created.id, text, icon: "⏰" } }).catch(() => undefined);
      await publish({ type: "toast", payload: { text, icon: "⏰", audience: "OWNER" } }).catch(() => undefined);
      await whatsappOwners(p.label, formatIST(opens, "EEE d MMM, h:mm a")).catch((err) => logger.warn({ err: String(err), planId: p.id }, "ticket window template failed"));
    }
  }
  return { reminders: sent };
}

async function whatsappOwners(plan: string, opens: string) {
  const template = await db.messageTemplate.findUnique({ where: { name: WINDOW_TEMPLATE } });
  if (!template || template.metaStatus !== "APPROVED") return 0;
  const owners = await db.user.findMany({ where: { role: "OWNER", active: true, phone: { not: null } }, select: { phone: true } });
  const vars: Record<string, string> = { plan, opens };
  const adapter = getAdapter("WHATSAPP");
  for (const o of owners) await adapter.sendTemplate(o.phone!, template.name, template.language, template.variables.map((v) => vars[v] ?? ""));
  return owners.length;
}
