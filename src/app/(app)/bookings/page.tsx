/** Bookings (SRS §4.5). Layout and copy from the demo's bookings() and openBk(). */
import Link from "next/link";
import { BookingDrawerContent } from "@/components/bookings/booking-drawer";
import { ClickRow, Drawer } from "@/components/bookings/drawer";
import { NewBookingSheet } from "@/components/bookings/new-booking-sheet";
import { LiveRefresh } from "@/components/live-refresh";
import { initials } from "@/lib/utils";
import { getBookingDetail, listBookableDepartures, listBookings, type BookingFilter, type BookingStatusPill } from "@/server/domain/bookings/queries";
import { inr } from "@/server/money";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Bookings" };
export const dynamic = "force-dynamic";

const PILL_CLASS: Record<BookingStatusPill["kind"], string> = {
  paid: "p-ok",
  late: "p-b",
  balance: "p-w",
  held: "p-l",
  cancelled: "p-g",
};

function href(params: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const s = q.toString();
  return s ? `/bookings?${s}` : "/bookings";
}

export default async function Page(props: PageProps<"/bookings">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const filter = (["all", "paid", "due"].includes(one(sp.f) ?? "") ? one(sp.f) : "all") as BookingFilter;
  const customer = one(sp.customer);
  const open = one(sp.b);
  const isNew = one(sp.new) === "1";
  const base = { f: filter === "all" ? undefined : filter, customer };

  const [{ rows, counts }, detail, departures] = await Promise.all([
    listBookings({ filter, customerId: customer }),
    open ? getBookingDetail(open, user.role) : Promise.resolve(null),
    isNew ? listBookableDepartures() : Promise.resolve([]),
  ]);

  return (
    <div className="wrap">
      <LiveRefresh types={["booking.updated", "payment.received"]} />
      <div className="card">
        <div className="pad h" style={{ margin: 0, borderBottom: "1px solid var(--line)" }}>
          <div className="chips">
            <Link className={`pill ${filter === "all" ? "p-l" : "p-g"}`} href={href({ customer })}>
              All {counts.all}
            </Link>
            <Link className={`pill ${filter === "paid" ? "p-l" : "p-g"}`} href={href({ f: "paid", customer })}>
              Paid in full {counts.paid}
            </Link>
            <Link className={`pill ${filter === "due" ? "p-l" : "p-g"}`} href={href({ f: "due", customer })}>
              Balance due {counts.due}
            </Link>
            {customer ? (
              <Link className="pill p-w" href={href({ f: base.f })}>
                {rows[0]?.customerName ?? "Customer"} ✕
              </Link>
            ) : null}
          </div>
          <Link className="btn b1 sm" href={href({ ...base, new: "1" })} scroll={false}>
            + New booking
          </Link>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="t">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Customer</th>
                <th>Trip</th>
                <th>Travellers</th>
                <th>Total</th>
                <th>Paid</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <ClickRow key={b.id} href={href({ ...base, b: b.code })}>
                  <td>
                    <b>{b.code}</b>
                    <br />
                    <small className="muted">{b.createdLabel}</small>
                  </td>
                  <td>
                    <div className="who">
                      <div className="av">{initials(b.customerName)}</div>
                      <div>
                        {b.customerName}
                        {b.phone ? <small>{b.phone}</small> : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    {b.tripTitle}
                    <br />
                    <small className="muted">{b.tripDate}</small>
                  </td>
                  <td>{b.pax}</td>
                  <td>{inr(b.total)}</td>
                  <td>{inr(b.paid)}</td>
                  <td>
                    <span className={`pill ${PILL_CLASS[b.pill.kind]}`}>{b.pill.label}</span>
                  </td>
                  <td>
                    <span className="pill p-g">{b.source}</span>
                  </td>
                </ClickRow>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 28 }}>
                    No bookings here yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {detail ? (
        <Drawer closeHref={href(base)}>
          <BookingDrawerContent detail={detail} role={user.role} closeHref={href(base)} />
        </Drawer>
      ) : null}
      {isNew ? (
        <Drawer closeHref={href(base)}>
          <NewBookingSheet role={user.role} departures={departures} closeHref={href(base)} />
        </Drawer>
      ) : null}
    </div>
  );
}
