/** Counts for the sidebar badges. Cheap aggregate queries; no stored counters. */
import { db } from "@/server/db";
import { todayIST } from "@/server/time";

export type NavBadgeCounts = { inbox: number; dues: number };

export async function getNavBadges(now: Date = new Date()): Promise<NavBadgeCounts> {
  const [inbox, dues] = await Promise.all([
    // Conversations waiting on the team: unread, or brand new.
    db.conversation.count({
      where: { customerId: { not: null }, OR: [{ unreadCount: { gt: 0 } }, { status: "NEW" }] },
    }),
    // Bookings whose balance due date has passed with money still owed.
    db.booking.count({
      where: {
        status: { in: ["HELD", "CONFIRMED"] },
        balanceDueDate: { lt: todayIST(now) },
        paidAmount: { lt: db.booking.fields.totalAmount },
      },
    }),
  ]);
  return { inbox, dues };
}
