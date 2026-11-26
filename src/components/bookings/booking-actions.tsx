"use client";
/** Interactive parts of the booking drawer. Each calls a server action that re-checks auth. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/shell/toast";
import {
  addTravellerAction,
  cancelBookingAction,
  recordPaymentAction,
  renderDocumentAction,
  sendLinkAction,
} from "@/app/(app)/bookings/actions";
import { sendVouchersAction } from "@/app/(app)/supplier/actions";

export function BookingActions(props: {
  bookingId: string;
  customerName: string;
  canSendLink: boolean;
  invoiceDocumentId: string | null;
  itineraryDocumentId: string | null;
  hasDeparture: boolean;
  /** Hotels for this departure were booked through the Supplier desk. */
  hotelsBooked?: boolean;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  const render = (kind: "invoice" | "itinerary") =>
    start(async () => {
      const r = await renderDocumentAction(props.bookingId, kind);
      toast(r.ok ? `${kind === "invoice" ? "Invoice" : "Itinerary"} is being prepared · it appears here in a moment` : r.error, r.ok ? "📄" : "⚠️");
    });

  return (
    <div className="chips" style={{ marginTop: 8 }}>
      {props.canSendLink ? (
        <button
          type="button"
          className="btn b1 sm"
          disabled={pending || sent}
          onClick={() =>
            start(async () => {
              const r = await sendLinkAction(props.bookingId);
              if (r.ok) {
                setSent(true);
                toast(`UPI link sent to ${props.customerName} on WhatsApp`, "💬");
              } else toast(r.error, "⚠️");
            })
          }
        >
          {sent ? "Sent ✓" : "Send balance link"}
        </button>
      ) : null}
      {props.invoiceDocumentId ? (
        <a className="btn b2 sm" href={`/api/files/${props.invoiceDocumentId}`} target="_blank" rel="noreferrer">
          Invoice
        </a>
      ) : (
        <button type="button" className="btn b2 sm" disabled={pending} onClick={() => render("invoice")}>
          Invoice
        </button>
      )}
      <button
        type="button"
        className="btn b2 sm"
        disabled={pending || !props.hotelsBooked}
        title={props.hotelsBooked ? "Hotel voucher PDF to the customer on WhatsApp" : "Available once hotels are booked through the Supplier desk"}
        onClick={() =>
          start(async () => {
            const r = await sendVouchersAction(props.bookingId);
            toast(r.ok ? `Hotel voucher is being prepared for ${props.customerName}` : r.error, r.ok ? "🏨" : "⚠️");
          })
        }
      >
        Send vouchers
      </button>
      {props.hasDeparture ? (
        props.itineraryDocumentId ? (
          <a className="btn b2 sm" href={`/api/files/${props.itineraryDocumentId}`} target="_blank" rel="noreferrer">
            Itinerary PDF
          </a>
        ) : (
          <button type="button" className="btn b2 sm" disabled={pending} onClick={() => render("itinerary")}>
            Itinerary PDF
          </button>
        )
      ) : null}
    </div>
  );
}

export function CopyLink({ url }: { url: string }) {
  const toast = useToast();
  return (
    <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
      <a href={url} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
        {url.replace(/^https?:\/\//, "")}
      </a>
      <button
        type="button"
        className="btn b2 sm"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          toast("Link copied");
        }}
      >
        Copy
      </button>
    </span>
  );
}

export function RecordPaymentForm({ bookingId, balance }: { bookingId: string; balance: number }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState(String(balance / 100));
  const [method, setMethod] = useState<"CASH" | "BANK_TRANSFER" | "UPI" | "CARD">("CASH");
  const [note, setNote] = useState("");

  if (!open)
    return (
      <button type="button" className="btn b2 sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        Record a payment
      </button>
    );
  return (
    <form
      className="card pad"
      style={{ marginTop: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await recordPaymentAction({ bookingId, amount, method, note: note || undefined });
          if (r.ok) {
            toast("Payment recorded · receipt on its way", "💸");
            setOpen(false);
            router.refresh();
          } else toast(r.error, "⚠️");
        });
      }}
    >
      <h3 style={{ marginBottom: 10 }}>Record a payment</h3>
      <div className="fld">
        <label htmlFor="pay-amount">Amount received (₹)</label>
        <input id="pay-amount" className="inp" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </div>
      <div className="fld">
        <label htmlFor="pay-method">Method</label>
        <select id="pay-method" className="inp" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="CASH">Cash</option>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="UPI">UPI (outside the link)</option>
          <option value="CARD">Card (at office)</option>
        </select>
      </div>
      <div className="fld">
        <label htmlFor="pay-note">Note (optional)</label>
        <input id="pay-note" className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Paid at the Ranchi office" />
      </div>
      <div className="chips">
        <button type="submit" className="btn b1 sm" disabled={pending}>
          {pending ? "Saving…" : "Save payment"}
        </button>
        <button type="button" className="btn b2 sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AddTravellerForm({ bookingId }: { bookingId: string }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState<"" | "M" | "F" | "O">("");
  return (
    <form
      style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addTravellerAction(bookingId, { fullName: name, age: age ? Number(age) : null, gender: gender || null });
          if (r.ok) {
            setName("");
            setAge("");
            setGender("");
            router.refresh();
          } else toast(r.error, "⚠️");
        });
      }}
    >
      <input className="inp" style={{ flex: "2 1 160px" }} placeholder="Full name as on ID" value={name} onChange={(e) => setName(e.target.value)} aria-label="Traveller full name" required />
      <input className="inp" style={{ flex: "0 1 70px" }} placeholder="Age" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))} aria-label="Age" />
      <select className="inp" style={{ flex: "0 1 80px" }} value={gender} onChange={(e) => setGender(e.target.value as typeof gender)} aria-label="Gender">
        <option value="">–</option>
        <option value="F">F</option>
        <option value="M">M</option>
        <option value="O">Other</option>
      </select>
      <button type="submit" className="btn b2 sm" disabled={pending}>
        Add traveller
      </button>
    </form>
  );
}

export function CancelBooking({ bookingId, code, paid }: { bookingId: string; code: string; paid: number }) {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  if (!open)
    return (
      <button type="button" className="btn b2 sm" style={{ marginTop: 18, color: "var(--bad)" }} onClick={() => setOpen(true)}>
        Cancel booking…
      </button>
    );
  return (
    <div className="card pad" style={{ marginTop: 18, borderColor: "var(--bad)" }}>
      <b>Cancel {code}?</b>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 10px" }}>
        The seats go back on sale.{paid > 0 ? " Any refund is recorded manually in v1." : ""} This is logged.
      </p>
      <input className="inp" placeholder="Reason (e.g. customer cancelled by phone)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Cancellation reason" />
      <div className="chips" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sm"
          style={{ background: "var(--bad)", color: "#fff" }}
          disabled={pending || reason.trim().length < 3}
          onClick={() =>
            start(async () => {
              const r = await cancelBookingAction(bookingId, reason);
              if (r.ok) {
                toast(`${code} cancelled · seats released`);
                setOpen(false);
                router.refresh();
              } else toast(r.error, "⚠️");
            })
          }
        >
          Yes, cancel booking
        </button>
        <button type="button" className="btn b2 sm" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
    </div>
  );
}
