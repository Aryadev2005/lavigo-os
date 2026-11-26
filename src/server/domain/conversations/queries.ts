/**
 * Inbox reads (INB-5, INB-6, INB-8). Customer conversations only: supplier threads go to the
 * Supplier desk. "Waiting for reply" comes from ./waiting.ts, the one definition shared with Today
 * and the sidebar badge.
 */
import { Prisma, type Channel, type ConversationStatus } from "@prisma/client";
import { db } from "../../db";
import { inr } from "../../money";
import { formatDate, formatIST, istDateString, todayIST } from "../../time";
import { seatsTaken } from "../inventory";
import { windowOpen, WINDOW_MS } from "../../channels/outbound";
import { waitingIds } from "./waiting";

export type InboxTab = "all" | "needs" | "paid" | "followup";
export type Pill = { label: string; cls: "p-b" | "p-l" | "p-w" | "p-ok" | "p-g" };

/** INB-5 status pill. Waiting beats everything except a finished (paid) deal. */
export function conversationPill(status: ConversationStatus, waiting: boolean): Pill {
  if (status === "PAID") return { label: "Paid", cls: "p-ok" };
  if (waiting) return { label: "Waiting for reply", cls: "p-b" };
  switch (status) {
    case "NEGOTIATING":
    case "AWAITING_OWNER":
      return { label: "Negotiating", cls: "p-w" };
    case "QUOTED":
      return { label: "Quote sent", cls: "p-l" };
    case "PAYMENT_PENDING":
      return { label: "Payment pending", cls: "p-w" };
    case "FOLLOW_UP":
      return { label: "Follow-up due", cls: "p-w" };
    case "CLOSED":
      return { label: "Closed", cls: "p-g" };
    case "NEW":
      return { label: "New lead", cls: "p-l" };
    default:
      return { label: "Replied", cls: "p-g" };
  }
}

export const CHANNEL_LABEL: Record<Channel, string> = { WHATSAPP: "WhatsApp", INSTAGRAM: "Instagram", SANDBOX: "Sandbox", EMAIL: "Email" };
export const CHANNEL_CLASS: Record<Channel, string> = { WHATSAPP: "wa", INSTAGRAM: "ig", SANDBOX: "sb", EMAIL: "em" };

export { waitingIds } from "./waiting";

/** "11:42 PM" today, "Yesterday", else "3 Nov". */
export function listTime(at: Date, now: Date = new Date()): string {
  const day = istDateString(at);
  if (day === istDateString(now)) return formatIST(at, "h:mm a");
  if (day === istDateString(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return formatIST(at, "d MMM");
}

export type ConversationRow = {
  id: string;
  name: string;
  channel: Channel;
  channelClass: string;
  preview: string;
  time: string;
  unread: number;
  pill: Pill;
};

const CUSTOMER_ONLY: Prisma.ConversationWhereInput = { customerId: { not: null }, supplierId: null };

export async function listConversations(tab: InboxTab, now: Date = new Date()): Promise<{ rows: ConversationRow[]; counts: Record<InboxTab, number> }> {
  const convs = await db.conversation.findMany({
    where: CUSTOMER_ONLY,
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    include: {
      customer: { select: { name: true, igUsername: true } },
      messages: { where: { kind: { not: "SYSTEM_NOTE" } }, orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, author: true } },
    },
  });
  const waiting = await waitingIds(convs.map((c) => c.id));
  const isNeeds = (c: (typeof convs)[number]) => waiting.has(c.id) || c.status === "AWAITING_OWNER";
  const counts: Record<InboxTab, number> = {
    all: convs.length,
    needs: convs.filter(isNeeds).length,
    paid: convs.filter((c) => c.status === "PAID").length,
    followup: convs.filter((c) => c.status === "FOLLOW_UP").length,
  };
  const filtered = convs.filter((c) =>
    tab === "needs" ? isNeeds(c) : tab === "paid" ? c.status === "PAID" : tab === "followup" ? c.status === "FOLLOW_UP" : true,
  );
  const rows = filtered.map((c) => {
    const last = c.messages[0];
    const who = !last ? "" : last.direction === "INBOUND" ? "" : last.author === "SYSTEM" ? "⚙️ " : "You: ";
    return {
      id: c.id,
      name: c.customer?.name ?? "Unknown",
      channel: c.channel,
      channelClass: CHANNEL_CLASS[c.channel],
      preview: last ? `${who}${last.body.replace(/\s+/g, " ").slice(0, 120)}` : c.sourceNote ? `New lead · ${c.sourceNote}` : "No messages yet",
      time: listTime(c.lastMessageAt, now),
      unread: c.unreadCount,
      pill: conversationPill(c.status, waiting.has(c.id)),
    };
  });
  return { rows, counts };
}

// ───────────────────────────── thread (INB-6) ─────────────────────────────

export type QuoteCard = {
  type: "quote";
  title: string;
  pax: number;
  listPricePerPax: number;
  discounts: { label: string; amountPerPax: number }[];
  pricePerPax: number;
  totalAmount: number;
  seatsLeft: number | null;
  validUntil: string | null;
};
export type LinkCard = { type: "link"; amount: number; url: string | null; label: string };
export type FileCard = { type: "file"; documentId: string | null; fileName: string; mime: string | null; error: string | null };
export type Card = QuoteCard | LinkCard | FileCard | { type: "template"; name: string };

export type ThreadMessage = {
  id: string;
  side: "c" | "a" | "sys";
  tag: string | null;
  body: string;
  card: Card | null;
  time: string;
  status: string;
  error: string | null;
};

type P0 = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function toCard(kind: string, payload: P0 | null, titles: Map<string, string>): Card | null {
  const p = payload ?? {};
  if (kind === "QUOTE") {
    const code = str(p.departure) ?? str(p.departureCode);
    return {
      type: "quote",
      title: str(p.title) ?? (code ? (titles.get(code) ?? code) : "Your trip"),
      pax: num(p.pax),
      listPricePerPax: num(p.listPricePerPax),
      discounts: Array.isArray(p.discounts) ? (p.discounts as P0[]).map((d) => ({ label: str(d.label) ?? "Offer", amountPerPax: num(d.amountPerPax) })) : [],
      pricePerPax: num(p.pricePerPax),
      totalAmount: num(p.totalAmount),
      seatsLeft: typeof p.seatsLeft === "number" ? p.seatsLeft : null,
      validUntil: str(p.validUntil),
    };
  }
  if (kind === "PAYMENT_LINK") {
    return { type: "link", amount: num(p.amount), url: str(p.url) ?? str(p.shortUrl), label: str(p.label) ?? "Pay securely" };
  }
  if (kind === "MEDIA") {
    const media = (p.media ?? {}) as P0;
    return {
      type: "file",
      documentId: str(p.documentId),
      fileName: str(p.fileName) ?? str(media.filename) ?? "Attachment",
      mime: str(p.mime) ?? str(media.mime),
      error: str(p.mediaError),
    };
  }
  if (kind === "TEMPLATE" && str(p.template)) return { type: "template", name: str(p.template)! };
  return null;
}

export type ThreadView = NonNullable<Awaited<ReturnType<typeof getThread>>>;

export async function getThread(conversationId: string, viewerId: string, now: Date = new Date()) {
  const c = await db.conversation.findFirst({
    where: { id: conversationId, ...CUSTOMER_ONLY },
    include: {
      customer: { select: { id: true, name: true, phone: true, igUsername: true, marketingOptIn: true, _count: { select: { bookings: true } } } },
      interestedDeparture: { select: { id: true, code: true, startDate: true, trip: { select: { title: true } } } },
    },
  });
  if (!c || !c.customer) return null;
  const raw = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { authorUser: { select: { name: true } } },
  });
  raw.reverse();

  const codes = new Set<string>();
  for (const m of raw) if (m.kind === "QUOTE") {
    const code = str((m.payload as P0 | null)?.departure);
    if (code) codes.add(code);
  }
  const titles = new Map(
    (await db.departure.findMany({ where: { code: { in: [...codes] } }, select: { code: true, startDate: true, trip: { select: { title: true } } } })).map((d) => [
      d.code,
      `${d.trip.title} · ${formatDate(d.startDate)}`,
    ]),
  );

  const today = istDateString(now);
  const messages: ThreadMessage[] = raw.map((m) => ({
    id: m.id,
    side: m.kind === "SYSTEM_NOTE" ? "sys" : m.direction === "INBOUND" ? "c" : "a",
    tag:
      m.direction === "INBOUND" || m.kind === "SYSTEM_NOTE"
        ? null
        : m.author === "SYSTEM"
          ? "⚙️ Lavigo"
          : m.authorUserId === viewerId
            ? "🙋 You"
            : (m.authorUser?.name ?? "Team"),
    body: m.body,
    card: toCard(m.kind, m.payload as P0 | null, titles),
    time: istDateString(m.createdAt) === today ? formatIST(m.createdAt, "h:mm a") : formatIST(m.createdAt, "d MMM, h:mm a"),
    status: m.status,
    error: m.error,
  }));

  const waiting = (await waitingIds([c.id])).has(c.id);
  const open = windowOpen(c.lastInboundAt, now);
  const contact =
    c.channel === "WHATSAPP" || (c.channel === "SANDBOX" && c.customer.phone)
      ? (c.customer.phone ?? c.externalThreadId)
      : c.channel === "INSTAGRAM"
        ? c.customer.igUsername
          ? `@${c.customer.igUsername}`
          : null
        : null;

  return {
    id: c.id,
    channel: c.channel,
    channelLabel: CHANNEL_LABEL[c.channel],
    customer: { id: c.customer.id, name: c.customer.name, firstName: c.customer.name.split(/\s+/)[0] ?? c.customer.name, bookings: c.customer._count.bookings, marketingOptIn: c.customer.marketingOptIn },
    contact: contact ? displayContact(contact) : null,
    sourceNote: c.sourceNote,
    pill: conversationPill(c.status, waiting),
    unread: c.unreadCount,
    window: {
      open,
      closesAt: open && c.lastInboundAt ? formatIST(new Date(c.lastInboundAt.getTime() + WINDOW_MS), "d MMM, h:mm a") : null,
      neverWrote: !c.lastInboundAt,
    },
    lead: {
      departureId: c.interestedDepartureId,
      tripLabel: c.interestedDeparture ? `${c.interestedDeparture.trip.title} · ${formatDate(c.interestedDeparture.startDate)}` : null,
      pax: c.paxCount,
      sourceNote: c.sourceNote,
      temp: c.leadTemp,
    },
    messages,
    lastMessageId: raw.at(-1)?.id ?? null,
  };
}

function displayContact(v: string) {
  const d = v.replace(/^\+91/, "");
  return /^\d{10}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : v;
}

// ───────────────────────────── composer support (INB-7, INB-11) ─────────────────────────────

export async function listOpenDepartures(now: Date = new Date()) {
  const deps = await db.departure.findMany({
    where: { status: "OPEN", startDate: { gte: todayIST(now) } },
    orderBy: { startDate: "asc" },
    select: { id: true, code: true, startDate: true, trip: { select: { title: true } } },
  });
  return deps.map((d) => ({ id: d.id, label: `${d.trip.title} · ${formatDate(d.startDate)}` }));
}

/** Editable quick-insert text for a departure: itinerary, inclusions and list price from the DB. */
export async function departureSnippet(departureId: string): Promise<string | null> {
  const d = await db.departure.findUnique({ where: { id: departureId }, include: { trip: true } });
  if (!d) return null;
  const left = Math.max(0, d.seatsTotal - (await seatsTaken(d.id)));
  const days = Array.isArray(d.trip.itinerary) ? (d.trip.itinerary as P0[]) : [];
  const lines = [
    `*${d.trip.title}* · ${formatDate(d.startDate)} to ${formatDate(d.endDate)} (${d.trip.nights}N/${d.trip.days}D)`,
    "",
    ...days.slice(0, 10).map((x) => `Day ${num(x.day) || "?"}: ${str(x.title) ?? ""}`),
  ];
  if (d.trip.inclusions.length) lines.push("", `Includes: ${d.trip.inclusions.join(", ")}`);
  lines.push("", `*${inr(d.pricePerPax)} per person* (incl. GST) · ${left} seat${left === 1 ? "" : "s"} left`);
  return lines.join("\n");
}

export async function listSendableTemplates(marketingOptIn: boolean) {
  const rows = await db.messageTemplate.findMany({ where: { metaStatus: "APPROVED" }, orderBy: { name: "asc" } });
  return rows
    .filter((t) => t.category !== "MARKETING" || marketingOptIn)
    .map((t) => ({ name: t.name, purpose: t.purpose, bodyPreview: t.bodyPreview, variables: t.variables }));
}
