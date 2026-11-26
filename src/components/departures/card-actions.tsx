"use client";
/** Card buttons + the Fill seats panel (DEP-3 … DEP-6). Rule-based audience; no LLM. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { previewFillAction, sendChecklistAction, sendFillAction } from "@/app/(app)/departures/actions";
import { useToast } from "@/components/shell/toast";
import type { FillPreview } from "@/server/domain/departures/campaigns";

type Props = {
  departureId: string;
  code: string;
  name: string;
  primary: boolean;
  seatsLeft: number;
  confirmedBookings: number;
  travellers: number;
  lastCampaign: { sentTo: number; converted: number; sentLabel: string } | null;
  defaultValidUntil: string;
};

export function DepartureActions(p: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<FillPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discount, setDiscount] = useState("500");
  const [validUntil, setValidUntil] = useState(p.defaultValidUntil);
  const [sent, setSent] = useState<number | null>(null);
  const [sending, setSending] = useState(false);

  const load = (opts = { discount, validUntil }) =>
    start(async () => {
      setError(null);
      const r = await previewFillAction(p.departureId, opts);
      if (!r.ok) return setError(r.error);
      setPreview(r.preview);
    });

  const openPanel = () => {
    setOpen(true);
    setSent(null);
    load();
  };

  const send = () =>
    start(async () => {
      setError(null);
      setSending(true);
      const r = await sendFillAction(p.departureId, { discount, validUntil });
      setSending(false);
      if (!r.ok) return setError(r.error);
      setSent(r.recipients);
      toast(`Sending to ${r.recipients} people on WhatsApp`, "📣");
      router.refresh();
    });

  const checklist = () =>
    start(async () => {
      if (!confirm(`Send the document checklist to the lead traveller of ${p.confirmedBookings} confirmed booking${p.confirmedBookings === 1 ? "" : "s"} on ${p.name}?`)) return;
      const r = await sendChecklistAction(p.departureId);
      if (!r.ok) return toast(r.error, "⚠️");
      toast(`Document checklist sent to ${r.sent} booking${r.sent === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} couldn't be sent)` : ""}`, "📄");
    });

  return (
    <>
      <div className="chips">
        <button type="button" className={`btn ${p.primary ? "b1" : "b2"} sm`} disabled={open || pending || p.seatsLeft === 0} onClick={openPanel}>
          ✨ Fill seats
        </button>
        <a className="btn b2 sm" href={`/api/departures/${p.departureId}/travellers`} download>
          Traveller list
        </a>
        <button type="button" className="btn b2 sm" disabled={pending || p.confirmedBookings === 0} onClick={checklist}>
          Send checklist
        </button>
        <Link className="btn b2 sm" href={`/departures?edit=${p.departureId}`} scroll={false}>
          Edit
        </Link>
      </div>
      {p.lastCampaign && !open ? (
        <small className="muted" style={{ display: "block", marginTop: 8 }}>
          Last Fill seats: {p.lastCampaign.sentLabel}, sent to {p.lastCampaign.sentTo} · {p.lastCampaign.converted} booked
        </small>
      ) : null}
      {open ? (
        <div className="card pad" style={{ marginTop: 12, background: "var(--lav3)" }}>
          {preview ? (
            <>
              <b>
                Found {preview.total} {preview.total === 1 ? "person" : "people"} likely to book
              </b>
              <p className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>
                {preview.reasons}.
                {preview.skippedNoOptIn ? ` ${preview.skippedNoOptIn} skipped (no opt-in).` : ""}
                {preview.skippedNoPhone ? ` ${preview.skippedNoPhone} skipped (no WhatsApp number).` : ""}
              </p>
              <div className="two" style={{ marginBottom: 8 }}>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor={`fd-${p.code}`}>Limited-time discount per person (₹, optional)</label>
                  <input id={`fd-${p.code}`} className="inp" inputMode="numeric" value={discount} disabled={sent !== null} onChange={(e) => setDiscount(e.target.value)} onBlur={() => load()} />
                </div>
                <div className="fld" style={{ margin: 0 }}>
                  <label htmlFor={`fv-${p.code}`}>Offer valid until</label>
                  <input id={`fv-${p.code}`} type="date" className="inp" value={validUntil} disabled={!discount.trim() || sent !== null} onChange={(e) => { setValidUntil(e.target.value); load({ discount, validUntil: e.target.value }); }} />
                </div>
              </div>
              <div className="m a" style={{ maxWidth: "100%", animation: "none" }}>
                <div className="tag">📣 Message preview · {preview.template}</div>
                {preview.message}
              </div>
            </>
          ) : (
            <p className="muted">{error ? "" : "Finding people…"}</p>
          )}
          {error ? (
            <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
              {error}
            </p>
          ) : null}
          <div className="chips" style={{ marginTop: 10 }}>
            {sent !== null ? (
              <button type="button" className="btn b1 sm" disabled>
                Sent ✓ to {sent}
              </button>
            ) : (
              <button type="button" className="btn b1 sm" disabled={pending || !preview || preview.total === 0} onClick={send}>
                {sending ? "Sending…" : `Send to ${preview?.total ?? 0} ${preview?.total === 1 ? "person" : "people"}`}
              </button>
            )}
            <button type="button" className="btn b2 sm" onClick={() => { setOpen(false); setPreview(null); setError(null); }}>
              {sent !== null ? "Close" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
