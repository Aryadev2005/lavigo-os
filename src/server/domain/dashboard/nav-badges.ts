/** Counts for the sidebar badges (TOD-7). Live queries; no stored counters. */
import { db } from "@/server/db";
import { getDuesBoard } from "@/server/domain/dues";
import { waitingConversations } from "../conversations/waiting";
import { ticketBadgeCount } from "../tickets/needs-you";

export type NavBadgeCounts = { inbox: number; dues: number; tickets: number };

export async function getNavBadges(now: Date = new Date()): Promise<NavBadgeCounts> {
  const [waiting, approvals, dues, tickets] = await Promise.all([
    // Unanswered: the customer spoke last (any age).
    waitingConversations(),
    db.approval.count({ where: { status: "PENDING" } }),
    getDuesBoard(now),
    ticketBadgeCount(now),
  ]);
  return { inbox: waiting.length + approvals, dues: dues.lateCount, tickets };
}
