/**
 * Today → Needs you (TOD-2) source for the supplier desk (SUP-6): an RFQ whose recipients have all
 * replied or timed out. "N hotel quotes in for <dest>, <date> · Best ₹X/room/night, Y% below your usual rate".
 */
import type { NeedItem } from "../dashboard";
import { db } from "../../db";
import { inr } from "../../money";
import { formatDate } from "../../time";
import { bestRow, HIGH_CONFIDENCE_BPS, savings } from "./compare";
import { timedOut } from "./queries";

const OPEN: readonly string[] = ["QUEUED", "SENT", "NUDGED"];

export async function rfqNeeds(now: Date = new Date()): Promise<NeedItem[]> {
  const rfqs = await db.rfq.findMany({
    where: { status: "SENT" },
    include: { recipients: { include: { quotes: { orderBy: { createdAt: "desc" }, take: 1 } } } },
    orderBy: { createdAt: "desc" },
  });
  const out: NeedItem[] = [];
  for (const rfq of rfqs) {
    if (!rfq.recipients.length) continue;
    if (rfq.recipients.some((r) => OPEN.includes(r.status) && !timedOut(r, now))) continue;
    const quoted = rfq.recipients.filter((r) => r.status === "REPLIED" && r.quotes[0]);
    if (!quoted.length) continue;
    const best = bestRow(
      quoted.map((r) => ({
        id: r.id,
        ratePerRoomNight: r.quotes[0]!.ratePerRoomNight > 0 ? r.quotes[0]!.ratePerRoomNight : null,
        declined: false,
        confidenceBps: r.quotes[0]!.confidenceBps,
      })),
    );
    const bestRate = best?.ratePerRoomNight ?? null;
    const save = savings(rfq.baselineRatePerRoomNight, bestRate, rfq.rooms, rfq.nights);
    const pctBelow = save ? `, ${Math.round(save.pctBps / 100)}% below your usual rate` : "";
    const unchecked = quoted.filter((r) => r.quotes[0]!.confidenceBps !== null && r.quotes[0]!.confidenceBps < HIGH_CONFIDENCE_BPS).length;
    out.push({
      key: `rfq:${rfq.id}`,
      icon: "🏨",
      tone: "ok",
      title: `${quoted.length} hotel quote${quoted.length === 1 ? "" : "s"} in for ${rfq.destination}, ${formatDate(rfq.checkIn)}`,
      detail: bestRate !== null ? `Best ${inr(bestRate)}/room/night${pctBelow}` : `${unchecked} need${unchecked === 1 ? "s" : ""} a quick check`,
      action: { label: "Compare", href: `/supplier?rfq=${rfq.id}`, primary: true },
    });
  }
  return out;
}
