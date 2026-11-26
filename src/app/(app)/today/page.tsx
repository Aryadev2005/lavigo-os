/** Today (SRS §4.2). Layout and copy from the demo's today(); AI wording replaced per SRS §1.1. */
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { NeedsYou } from "@/components/today/needs-you";
import { getActivity, getCollectedByMonth, getKpis, getNeedsYou, getUpcomingDepartures } from "@/server/domain/dashboard";
import { inr, pct } from "@/server/money";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Today" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();
  const now = new Date();
  const [k, needs, activity, bars, deps] = await Promise.all([
    getKpis(user.role, now),
    getNeedsYou(user.role, now),
    getActivity(20),
    getCollectedByMonth(6, now),
    getUpcomingDepartures(now, 4),
  ]);
  const change = k.collectedChangePct;

  return (
    <div className="wrap">
      <LiveRefresh types={["activity.created", "booking.updated", "payment.received", "approval.created", "approval.decided", "message.created"]} />
      <div className="g4">
        <div className="card pad kpi">
          <small>Collected in {k.monthName}</small>
          <b>{inr(k.collectedThisMonth)}</b>
          {change === null ? (
            <em>First month of collections</em>
          ) : (
            <em className={change < 0 ? "w" : undefined}>
              {change < 0 ? "▼" : "▲"} {Math.abs(change)}% vs {k.prevMonthName}
            </em>
          )}
        </div>
        <div className="card pad kpi">
          <small>Balance to collect</small>
          <b>{inr(k.balanceToCollect)}</b>
          <em className="w">
            {k.lateCount} payment{k.lateCount === 1 ? "" : "s"} late · reminders {k.remindersOn ? "on" : "off"}
          </em>
        </div>
        <div className="card pad kpi">
          <small>Enquiries today</small>
          <b>{k.enquiriesToday}</b>
          <em className={k.enquiriesWaiting > 0 ? "w" : undefined}>
            {k.enquiriesReplied} replied · {k.enquiriesWaiting} of today&apos;s still waiting
          </em>
        </div>
        {k.profit ? (
          <div className="card pad kpi">
            <small>Profit booked this month</small>
            <b>{inr(k.profit.bookedThisMonth)}</b>
            <em>avg margin {pct(k.profit.avgMarginBps)}</em>
          </div>
        ) : (
          <div className="card pad kpi">
            <small>Bookings this month</small>
            <b>{k.bookingsThisMonth.count}</b>
            <em>{k.bookingsThisMonth.travellers} travellers</em>
          </div>
        )}
      </div>

      <div className="g2" style={{ marginTop: 16 }}>
        <NeedsYou items={needs} />
        <div className="card pad">
          <div className="h">
            <h3>Live activity</h3>
            <span className="pill p-ok">
              <span className="pulse" />
              Live
            </span>
          </div>
          {activity.length ? (
            <ul className="feed">
              {activity.map((a) => (
                <li key={a.id}>
                  <time>{a.time}</time>
                  <span>{a.icon}</span>
                  <span>{a.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ fontSize: 13.5 }}>
              Payments, replies and reminders show up here as they happen.
            </p>
          )}
        </div>
      </div>

      <div className="g2" style={{ marginTop: 16 }}>
        <div className="card pad">
          <div className="h">
            <h3>Money collected</h3>
            <span className="muted" style={{ fontSize: 13 }}>
              Last 6 months
            </span>
          </div>
          <div className="bars">
            {bars.map((b) => (
              <div key={b.label} className={b.current ? "cur" : undefined} title={inr(b.amount)}>
                <small style={{ fontWeight: 600, color: "var(--text)" }}>{b.lakh}</small>
                <i style={{ height: `${b.heightPct}%` }} />
                <small>{b.label}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="card pad">
          <div className="h">
            <h3>Upcoming departures</h3>
            <Link className="btn b2 sm" href="/departures">
              All
            </Link>
          </div>
          {deps.length ? (
            deps.map((d) => (
              <div className="dep" key={d.id}>
                <div className="h" style={{ margin: "0 0 6px" }}>
                  <b>{d.title}</b>
                  <span className="muted">{d.dateLabel}</span>
                </div>
                <div className="fill">
                  <i style={{ width: `${Math.min(100, (d.sold / Math.max(1, d.seats)) * 100)}%` }} />
                </div>
                <small className="muted">
                  {d.sold}/{d.seats} seats · {d.daysToGo} days to go
                </small>
              </div>
            ))
          ) : (
            <p className="muted" style={{ fontSize: 13.5 }}>
              No departures scheduled yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
