/** Payments & dues (SRS §4.6). Layout and copy from the demo's dues(). */
import { LiveRefresh } from "@/components/live-refresh";
import { ReminderPreviewBubble } from "@/components/dues/preview";
import { RemindAllButton, RuleToggle, SendLinkButton } from "@/components/dues/dues-actions";
import { initials } from "@/lib/utils";
import { displayPhone } from "@/server/domain/bookings/queries";
import { getDuesBoard, getReminderPreview, listReminderRules } from "@/server/domain/dues";
import { inr } from "@/server/money";
import { requireUser } from "@/server/rbac";
import { formatDate } from "@/server/time";

export const metadata = { title: "Payments & dues" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser();
  const [board, rules, preview] = await Promise.all([getDuesBoard(), listReminderRules(), getReminderPreview()]);
  const aging: [string, number, string][] = [
    ["Not due yet", board.aging.notDue, "var(--ok)"],
    ["1–7 days late", board.aging.late1to7, "#E8A33D"],
    ["8+ days late", board.aging.late8plus, "var(--bad)"],
    ["Collected this week", board.aging.collectedThisWeek, "var(--ink)"],
  ];

  return (
    <div className="wrap">
      <LiveRefresh types={["booking.updated", "payment.received", "activity.created"]} />
      <div className="age">
        {aging.map(([label, amount, color]) => (
          <div className="card" key={label}>
            <small>{label}</small>
            <b>{inr(amount)}</b>
            <div className="bar" style={{ background: color }} />
          </div>
        ))}
      </div>

      <div className="g2">
        <div className="card">
          <div className="pad h" style={{ margin: 0, borderBottom: "1px solid var(--line)" }}>
            <h3>Who owes you</h3>
            <RemindAllButton lateCount={board.lateCount} />
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Trip</th>
                  <th>Balance</th>
                  <th>Due</th>
                  <th>Reminders</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.bookingId}>
                    <td>
                      <div className="who">
                        <div className="av">{initials(r.customerName)}</div>
                        <div>
                          {r.customerName}
                          {r.phone ? <small>{displayPhone(r.phone)}</small> : null}
                        </div>
                      </div>
                    </td>
                    <td>{r.tripName}</td>
                    <td>
                      <b>{inr(r.balance)}</b>
                    </td>
                    <td>
                      {r.daysLate > 0 ? (
                        <span className="pill p-b">{r.daysLate}d late</span>
                      ) : (
                        <span className="pill p-g">{r.balanceDueDate ? formatDate(r.balanceDueDate) : "—"}</span>
                      )}
                    </td>
                    <td className="muted">{r.remindersSent > 0 ? `${r.remindersSent} sent` : "Scheduled"}</td>
                    <td>
                      <SendLinkButton bookingId={r.bookingId} customerName={r.customerName} />
                    </td>
                  </tr>
                ))}
                {board.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 28 }}>
                      Nobody owes you anything right now ✓
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card pad">
          <h3 style={{ marginBottom: 6 }}>Automatic reminders</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
            The software chases payments politely so you don&apos;t have to.
            {user.role !== "OWNER" ? " Only the owner can change these." : ""}
          </p>
          {rules.map((r) => (
            <div className="rule" style={{ padding: "10px 0" }} key={r.key}>
              <div>
                <b style={{ fontSize: 14 }}>{r.name}</b>
                <small>{r.description}</small>
              </div>
              <RuleToggle ruleKey={r.key} name={r.name} enabled={r.enabled} canEdit={user.role === "OWNER"} />
            </div>
          ))}
          {preview ? <ReminderPreviewBubble preview={preview} /> : null}
        </div>
      </div>
    </div>
  );
}
