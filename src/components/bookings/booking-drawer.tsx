/** Booking drawer (BKG-5): summary, journey timeline from real data, actions. */
import Link from "next/link";
import type { Role } from "@prisma/client";
import type { BookingDetail } from "@/server/domain/bookings/queries";
import { inr } from "@/server/money";
import { AddTravellerForm, BookingActions, CancelBooking, CopyLink, RecordPaymentForm } from "./booking-actions";

const METHOD: Record<string, string> = { UPI: "UPI", CARD: "Card", NETBANKING: "Net banking", CASH: "Cash", BANK_TRANSFER: "Bank transfer", OTHER: "Other" };
const DOC: Record<string, string> = { PENDING: "ID pending", RECEIVED: "ID received", VERIFIED: "ID verified", REJECTED: "ID rejected" };

export function BookingDrawerContent({ detail: d, role, closeHref, hotelsBooked }: { detail: BookingDetail; role: Role; closeHref: string; hotelsBooked?: boolean }) {
  const cancelled = d.status === "CANCELLED";
  return (
    <>
      <div className="h">
        <div>
          <span className="muted">{d.code}</span>
          <h2 style={{ fontSize: 22 }}>{d.customerName}</h2>
        </div>
        <Link className="btn b2 sm" href={closeHref} scroll={false}>
          Close
        </Link>
      </div>

      {cancelled ? (
        <div className="card pad" style={{ background: "var(--badbg)", color: "var(--bad)", marginBottom: 12, fontSize: 13.5 }}>
          Cancelled{d.cancelReason ? `: ${d.cancelReason}` : ""}. Seats released.
        </div>
      ) : null}

      <div className="card pad" style={{ background: "var(--lav3)" }}>
        <div className="kv">
          <span>Trip</span>
          <b>{d.tripLine}</b>
        </div>
        <div className="kv">
          <span>Travellers</span>
          <b>{d.pax}</b>
        </div>
        <div className="kv">
          <span>Total</span>
          <b>{inr(d.total)}</b>
        </div>
        <div className="kv">
          <span>Paid</span>
          <b style={{ color: "var(--ok)" }}>{inr(d.paid)}</b>
        </div>
        <div className="kv">
          <span>Balance</span>
          <b style={{ color: d.balance ? "var(--warn)" : "var(--ok)" }}>{inr(d.balance)}</b>
        </div>
        {d.profit !== null ? (
          <div className="kv">
            <span>Your profit on this booking</span>
            <b>{inr(d.profit)}</b>
          </div>
        ) : null}
      </div>

      <h3 style={{ margin: "18px 0 10px" }}>Journey</h3>
      {d.journey.map((s) => (
        <div className="tl" key={s.title}>
          <div className="d" style={s.done ? { background: "var(--okbg)", color: "var(--ok)" } : undefined}>
            {s.done ? "✓" : "…"}
          </div>
          <div>
            <b>{s.title}</b>
            <small>{s.detail}</small>
          </div>
        </div>
      ))}

      <BookingActions
        bookingId={d.id}
        customerName={d.customerName}
        canSendLink={!cancelled && d.balance > 0}
        invoiceDocumentId={d.invoiceDocumentId}
        itineraryDocumentId={d.itineraryDocumentId}
        hasDeparture={!!d.departureId}
        hotelsBooked={hotelsBooked}
      />

      {d.links.length ? (
        <>
          <h3 style={{ margin: "18px 0 8px" }}>Open payment links</h3>
          {d.links.map((l) => (
            <div className="kv" key={l.id} style={{ alignItems: "center", gap: 8 }}>
              <span>
                {l.purpose === "ADVANCE" ? "Advance" : l.purpose === "BALANCE" ? "Balance" : "Full"} {inr(l.amount)}
                {l.expiresLabel ? <small className="muted"> · until {l.expiresLabel}</small> : null}
              </span>
              <CopyLink url={l.shortUrl} />
            </div>
          ))}
        </>
      ) : null}

      {d.payments.length ? (
        <>
          <h3 style={{ margin: "18px 0 8px" }}>Payments</h3>
          {d.payments.map((p) => (
            <div className="kv" key={p.id}>
              <span>
                {p.when} · {METHOD[p.method] ?? p.method}
                {p.provider === "MANUAL" ? " · recorded by team" : ""}
              </span>
              <b>{inr(p.amount)}</b>
            </div>
          ))}
          {d.receipts.length ? (
            <div className="chips" style={{ marginTop: 6 }}>
              {d.receipts.map((r) => (
                <a key={r.id} className="pill p-g" href={`/api/files/${r.id}`} target="_blank" rel="noreferrer">
                  📄 {r.fileName}
                </a>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {!cancelled && d.balance > 0 ? <RecordPaymentForm bookingId={d.id} balance={d.balance} /> : null}

      <h3 style={{ margin: "18px 0 8px" }}>
        Travellers{" "}
        <small className="muted" style={{ fontWeight: 500 }}>
          {d.travellers.length} of {d.pax}
        </small>
      </h3>
      {d.travellers.map((t) => (
        <div className="kv" key={t.id}>
          <span>
            {t.fullName}
            {t.isLead ? " · lead" : ""}
            {t.age != null ? ` · ${t.age}` : ""}
            {t.gender ? ` · ${t.gender}` : ""}
          </span>
          <span className={`pill ${t.docStatus === "VERIFIED" ? "p-ok" : t.docStatus === "REJECTED" ? "p-b" : t.docStatus === "RECEIVED" ? "p-l" : "p-g"}`}>
            {DOC[t.docStatus] ?? t.docStatus}
          </span>
        </div>
      ))}
      {!cancelled && d.travellers.length < d.pax ? <AddTravellerForm bookingId={d.id} /> : null}

      {role === "OWNER" && d.canCancel ? <CancelBooking bookingId={d.id} code={d.code} paid={d.paid} /> : null}
    </>
  );
}
