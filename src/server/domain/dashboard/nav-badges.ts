/** Counts for the sidebar badges (TOD-7). Live queries; no stored counters. */
import { db } from "@/server/db";
import { getDuesBoard } from "@/server/domain/dues";
import { waitingConversations } from "./index";

export type NavBadgeCounts = { inbox: number; dues: number };

export async function getNavBadges(now: Date = new Date()): Promise<NavBadgeCounts> {
  const [waiting, approvals, dues] = await Promise.all([
    // Unanswered: the customer spoke last (any age).
    waitingConversations(now),
    db.approval.count({ where: { status: "PENDING" } }),
    getDuesBoard(now),
  ]);
  return { inbox: waiting.length + approvals, dues: dues.lateCount };
}
