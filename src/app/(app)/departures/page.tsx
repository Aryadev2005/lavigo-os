/**
 * Departures (DEP-1 … DEP-6; demo departures() + fill()). Cards with the hero photo, status pill,
 * fill bar and revenue; Fill seats panel; traveller CSV; document checklist. The trip + departure
 * sheet opens at ?edit=new|<departureId>.
 */
import Link from "next/link";
import { Drawer } from "@/components/bookings/drawer";
import { DepartureActions } from "@/components/departures/card-actions";
import { DepartureSheet } from "@/components/departures/sheet";
import { LiveRefresh } from "@/components/live-refresh";
import { listDepartureCards, getDepartureSheet } from "@/server/domain/departures/queries";
import { inr } from "@/server/money";
import { requireUser } from "@/server/rbac";
import { addDays, istDateStringOf, todayIST } from "@/server/time";

export const metadata = { title: "Departures" };
export const dynamic = "force-dynamic";

const PILL = {
  NEEDS_SEATS: ["p-b", "Needs seats"],
  FILLING_WELL: ["p-ok", "Filling well"],
  ON_TRACK: ["p-w", "On track"],
} as const;

export default async function Page(props: PageProps<"/departures">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const edit = first(sp.edit) ?? null;
  const focus = first(sp.d) ?? null;
  const cards = await listDepartureCards();
  const sheet = edit ? await getDepartureSheet(edit === "new" ? null : edit, user) : null;
  const defaultValidUntil = istDateStringOf(addDays(todayIST(), 3));

  return (
    <div className="wrap">
      <LiveRefresh types={["booking.updated", "payment.received", "activity.created"]} />
      <div className="h" style={{ marginBottom: 14 }}>
        <span className="muted" style={{ fontSize: 13.5 }}>
          {cards.length} upcoming departure{cards.length === 1 ? "" : "s"}
        </span>
        {user.role === "OWNER" ? (
          <Link className="btn b2 sm" href="/departures?edit=new" scroll={false}>
            + New departure
          </Link>
        ) : null}
      </div>
      {cards.length === 0 ? (
        <div className="card pad muted">No upcoming departures yet.</div>
      ) : (
        <div className="deps">
          {cards.map((d) => {
            const [pill, label] = PILL[d.health];
            const pct = d.seats > 0 ? Math.min(100, (d.sold / d.seats) * 100) : 0;
            return (
              <div className="card depc" key={d.id} id={d.code} style={focus === d.code ? { outline: "2px solid var(--ink3)" } : undefined}>
                <div
                  className="ph"
                  style={{ backgroundImage: `linear-gradient(180deg,transparent 30%,rgba(20,14,45,.7))${d.image ? `,url(${d.image})` : ""}` }}
                >
                  <b>{d.name}</b>
                  <span className={`pill ${pill}`}>{label}</span>
                </div>
                <div className="pad">
                  <div className="h" style={{ marginBottom: 6 }}>
                    <b>{d.title}</b>
                    <span className="muted">
                      {d.dateLabel} · {d.daysToGo} days
                    </span>
                  </div>
                  <div className="fill" role="progressbar" aria-valuenow={d.sold} aria-valuemin={0} aria-valuemax={d.seats} aria-label={`${d.sold} of ${d.seats} seats sold`}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <div className="h" style={{ margin: "8px 0 12px" }}>
                    <small className="muted">
                      {d.sold} of {d.seats} seats sold
                      {d.campaign && d.campaign.converted > 0 ? ` · +${d.campaign.converted} from this campaign` : ""}
                    </small>
                    <small className="muted">Revenue {inr(d.revenue)}</small>
                  </div>
                  <DepartureActions
                    departureId={d.id}
                    code={d.code}
                    name={d.name}
                    primary={d.health === "NEEDS_SEATS"}
                    seatsLeft={Math.max(0, d.seats - d.sold)}
                    confirmedBookings={d.confirmedBookings}
                    travellers={d.travellers}
                    lastCampaign={d.campaign}
                    defaultValidUntil={defaultValidUntil}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {sheet && (edit === "new" ? user.role === "OWNER" : sheet.departure) ? (
        <Drawer closeHref="/departures">
          <DepartureSheet key={edit ?? "new"} trips={sheet.trips} departure={sheet.departure} isOwner={user.role === "OWNER"} closeHref="/departures" />
        </Drawer>
      ) : null}
    </div>
  );
}
