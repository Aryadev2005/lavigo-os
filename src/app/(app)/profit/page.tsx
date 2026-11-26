/**
 * Profit (PRF-1 … PRF-3; demo profit()). OWNER only: requireUser("OWNER") here and assertOwner in
 * the query. KPIs, profit by trip with a planned/actual badge and margin bar, lowest-margin callout.
 */
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { getProfitBoard, LOW_MARGIN_BPS, type ProfitScope } from "@/server/domain/profit";
import { inr, pct } from "@/server/money";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Profit" };
export const dynamic = "force-dynamic";

const SCOPES: [ProfitScope, string][] = [
  ["upcoming", "Upcoming trips"],
  ["recent", "Last 90 days + upcoming"],
  ["all", "All time"],
];

export default async function Page(props: PageProps<"/profit">) {
  const user = await requireUser("OWNER");
  const sp = await props.searchParams;
  const raw = Array.isArray(sp.scope) ? sp.scope[0] : sp.scope;
  const scope: ProfitScope = raw === "recent" || raw === "all" ? raw : "upcoming";
  const b = await getProfitBoard(user, scope);
  const amber = (bps: number) => bps < LOW_MARGIN_BPS;

  return (
    <div className="wrap">
      <LiveRefresh types={["payment.received", "booking.updated"]} />
      <div className="g4">
        <div className="card pad kpi">
          <small>Revenue booked</small>
          <b>{inr(b.revenue)}</b>
        </div>
        <div className="card pad kpi">
          <small>Cost (hotels, travel, leader)</small>
          <b>{inr(b.cost)}</b>
        </div>
        <div className="card pad kpi">
          <small>Your profit</small>
          <b style={{ color: "var(--ok)" }}>{inr(b.profit)}</b>
        </div>
        <div className="card pad kpi">
          <small>Average margin</small>
          <b>{pct(b.marginBps)}</b>
          {b.lowest ? <em className={amber(b.lowest.marginBps) ? "w" : undefined}>Lowest: {b.lowest.title.replace(/^Custom · /, "")} {pct(b.lowest.marginBps)}</em> : null}
        </div>
      </div>

      {b.lowest && amber(b.lowest.marginBps) ? (
        <div className="card pad" style={{ marginTop: 16, borderLeft: "4px solid #E8A33D" }}>
          <b>
            {b.lowest.title} is your lowest margin at {pct(b.lowest.marginBps)}
          </b>
          <p className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>
            Below 20%. You make {inr(b.lowest.profit)} on {inr(b.lowest.revenue)} of bookings
            {b.lowest.basis === "planned" ? " (planned cost; bills not all in yet)" : ""}.
          </p>
        </div>
      ) : null}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="pad h" style={{ margin: 0, borderBottom: "1px solid var(--line)" }}>
          <h3>Profit by trip</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            Updates with every payment and supplier bill
          </span>
        </div>
        <div className="pad chips" style={{ paddingBottom: 0 }} role="tablist" aria-label="Which trips">
          {SCOPES.map(([k, label]) => (
            <Link key={k} href={k === "upcoming" ? "/profit" : `/profit?scope=${k}`} role="tab" aria-selected={scope === k} className={`pill ${scope === k ? "p-l" : "p-g"}`} style={{ textDecoration: "none" }}>
              {label}
            </Link>
          ))}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Trip</th>
                <th>Revenue</th>
                <th>Cost</th>
                <th>Profit</th>
                <th style={{ width: "30%" }}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {b.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No bookings in this range.
                  </td>
                </tr>
              ) : (
                b.rows.map((r) => {
                  const m = r.marginBps / 100;
                  return (
                    <tr key={r.key}>
                      <td>
                        <b>{r.title}</b>
                        <br />
                        <small className="muted">{r.sub}</small>
                      </td>
                      <td>{inr(r.revenue)}</td>
                      <td>
                        {inr(r.cost)}{" "}
                        <span className={`pill ${r.basis === "actual" ? "p-ok" : "p-g"}`} style={{ fontSize: 10.5 }} title={r.basis === "planned" && r.billed ? `${inr(r.billed)} billed so far` : undefined}>
                          {r.basis}
                        </span>
                        {r.basis === "planned" && r.billed ? (
                          <>
                            <br />
                            <small className="muted">{inr(r.billed)} billed so far</small>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <b style={{ color: r.profit >= 0 ? "var(--ok)" : "var(--bad)" }}>{inr(r.profit)}</b>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div className="fill" style={{ flex: 1 }}>
                            <i style={{ width: `${Math.max(0, Math.min(100, m * 3))}%`, background: amber(r.marginBps) ? "#E8A33D" : "var(--ok)" }} />
                          </div>
                          <b>{pct(r.marginBps)}</b>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
