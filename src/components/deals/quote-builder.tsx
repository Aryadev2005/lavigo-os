"use client";
/**
 * Quote builder (DESK-1): departure, travellers, optional "customer asked" → live previewQuote.
 * Shows applied offers, offer price, decision and the guardrail meter. "Send" is enabled only when
 * canQuote passes for this role; otherwise "Ask owner" with the engine's suggested counter.
 * Everything here is advisory: the server re-derives and re-checks the price on send.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { askOwnerAction, previewQuoteAction, sendQuoteAction } from "@/app/(app)/inbox/actions";
import { useToast } from "@/components/shell/toast";
import type { QuotePreview } from "@/server/domain/deals";
import { buildMeter } from "@/server/domain/deals/meter";
import { inr, paiseFromRupeeInput, pct, toBps } from "@/server/money";
import { GuardrailMeter } from "./guardrail-meter";

export type BuilderDeparture = { id: string; code: string; label: string };

const DECISION: Record<QuotePreview["price"]["decision"], { label: string; cls: string }> = {
  ACCEPT_AUTO: { label: "At the offer ✓", cls: "p-ok" },
  ACCEPT_WITHIN_AUTONOMY: { label: "Within staff limit", cls: "p-ok" },
  NEEDS_APPROVAL: { label: "Needs approval", cls: "p-w" },
  BELOW_FLOOR: { label: "BELOW_FLOOR", cls: "p-b" },
  LARGE_GROUP: { label: "Large group: owner decides", cls: "p-w" },
};

export function QuoteBuilder(props: {
  conversationId: string;
  departures: BuilderDeparture[];
  defaultCode: string | null;
  defaultPax: number | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(props.defaultCode ?? props.departures[0]?.code ?? "");
  const [pax, setPax] = useState(props.defaultPax ? String(props.defaultPax) : "2");
  const [asked, setAsked] = useState("");
  const [preview, setPreview] = useState<QuotePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const seq = useRef(0);

  const paxN = Number(pax);
  const askedPaise = asked.trim() ? paiseFromRupeeInput(asked) : null;
  const askedBad = asked.trim() !== "" && !askedPaise;

  useEffect(() => {
    if (!code || !Number.isInteger(paxN) || paxN < 1 || askedBad) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await previewQuoteAction({ conversationId: props.conversationId, code, pax: paxN, requestedPricePerPax: askedPaise });
      if (n !== seq.current) return;
      setConfirming(false);
      if (r.ok) {
        setPreview(r.data);
        setError(null);
      } else {
        setPreview(null);
        setError(r.error);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [code, paxN, askedPaise, askedBad, props.conversationId]);

  const p = preview?.price;
  const send = (confirmBelowFloor = false) =>
    start(async () => {
      if (!preview) return;
      const r = await sendQuoteAction({ conversationId: props.conversationId, code, pax: paxN, pricePerPax: preview.send.pricePerPax, confirmBelowFloor });
      if (!r.ok) {
        if (r.reason === "BELOW_FLOOR_NEEDS_CONFIRMATION") return setConfirming(true);
        toast(r.error, "⚠️");
        return;
      }
      toast(`Quote sent: ${inr(r.data.totalAmount)}`, "🧾");
      props.onClose();
      router.refresh();
    });
  const ask = () =>
    start(async () => {
      const r = await askOwnerAction({ conversationId: props.conversationId, code, pax: paxN, requestedPricePerPax: askedPaise, note: note || null });
      if (!r.ok) {
        toast(r.error, "⚠️");
        return;
      }
      toast("Sent to the owner for approval", "🤝");
      props.onClose();
      router.refresh();
    });

  return (
    <div className="qpop qbuilder" role="dialog" aria-label="Quote builder">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>🧾 Quote builder</b>
        <button type="button" className="ib2" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div className="qb-row">
        <div className="fld" style={{ flex: "2 1 200px", marginBottom: 0 }}>
          <label htmlFor="qb-dep">Trip</label>
          <select id="qb-dep" className="inp" value={code} onChange={(e) => setCode(e.target.value)}>
            {props.departures.map((d) => (
              <option key={d.code} value={d.code}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fld" style={{ flex: "0 1 90px", marginBottom: 0 }}>
          <label htmlFor="qb-pax">Travellers</label>
          <input id="qb-pax" className="inp" inputMode="numeric" value={pax} onChange={(e) => setPax(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </div>
        <div className="fld" style={{ flex: "1 1 130px", marginBottom: 0 }}>
          <label htmlFor="qb-ask">Customer asked (₹/person)</label>
          <input id="qb-ask" className="inp" inputMode="numeric" placeholder="optional" value={asked} onChange={(e) => setAsked(e.target.value)} aria-invalid={askedBad} />
        </div>
      </div>

      {error ? <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>⚠ {error}</div> : null}
      {p && preview ? (
        <div style={{ marginTop: 10 }}>
          <div className="kv">
            <span>List price × {p.pax}</span>
            <b>{inr(p.listPrice * p.pax)}</b>
          </div>
          {p.appliedOffers.map((o) => (
            <div className="kv" key={o.name}>
              <span>{o.name}</span>
              <b style={{ color: "var(--ok)" }}>−{inr(o.amountPerPax)}/person</b>
            </div>
          ))}
          <div className="kv">
            <span>Offer price</span>
            <b>
              {inr(p.autoOffer)}/person · {inr(p.autoOffer * p.pax)}
            </b>
          </div>
          {preview.approved ? (
            <div className="kv">
              <span>Owner approved</span>
              <b style={{ color: "var(--ok)" }}>{inr(preview.approved.pricePerPax)}/person</b>
            </div>
          ) : null}
          <div className="kv" style={{ alignItems: "center" }}>
            <span>Decision</span>
            <span className={`pill ${DECISION[p.decision].cls}`}>{DECISION[p.decision].label}</span>
          </div>
          <GuardrailMeter
            meter={buildMeter({
              // The price on the table: what we'd send if allowed, else the current offer (approved or auto).
              offer: preview.send.ok || preview.send.needsConfirm ? preview.send.pricePerPax : (preview.approved?.pricePerPax ?? p.autoOffer),
              asked: p.requestedPricePerPax,
              staffLimit: p.staffLimit,
              autoOffer: p.autoOffer,
              listPrice: p.listPrice,
              floor: p.role === "OWNER" ? p.floor : null,
            })}
          />
          {p.role === "OWNER" ? (
            <div className="kv">
              <span>Margin at {inr(preview.send.pricePerPax)}</span>
              <b>{pct(toBps(preview.send.pricePerPax - p.costPerPax, preview.send.pricePerPax))}</b>
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 12, margin: "4px 0 10px" }}>
            {preview.departure.seatsLeft} seats left · advance to lock seats {inr(preview.advanceAmount)}
          </div>

          {confirming ? (
            <div className="approval" style={{ marginTop: 0 }}>
              <div className="t1">⚠ Below your floor</div>
              <div style={{ fontSize: 13.5 }}>
                {inr(preview.send.pricePerPax)} is below your floor{p.role === "OWNER" ? ` of ${inr(p.floor)}` : ""}. It will be logged. Send anyway?
              </div>
              <div className="acts">
                <button type="button" className="btn b1 sm" disabled={busy} onClick={() => send(true)}>
                  Yes, send {inr(preview.send.totalAmount)}
                </button>
                <button type="button" className="btn b2 sm" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : preview.send.ok || preview.send.needsConfirm ? (
            <button type="button" className="btn b1" style={{ width: "100%" }} disabled={busy} onClick={() => send(false)}>
              {busy ? "Sending…" : `Send quote · ${p.pax} × ${inr(preview.send.pricePerPax)} = ${inr(preview.send.totalAmount)}`}
            </button>
          ) : (
            <>
              <button type="button" className="btn b1" style={{ width: "100%" }} disabled title="Below what you can give alone">
                Send quote (needs the owner)
              </button>
              {preview.askOwner.allowed ? (
                <div style={{ marginTop: 8 }}>
                  {preview.pendingApprovalId ? <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>An approval request is already open; asking again replaces it.</div> : null}
                  <input className="inp" placeholder="Note for the owner (optional)" aria-label="Note for the owner" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                  <button type="button" className="btn b3" style={{ width: "100%", marginTop: 6 }} disabled={busy} onClick={ask}>
                    {busy ? "Asking…" : `🤝 Ask owner · suggest ${inr(preview.askOwner.suggestedPricePerPax ?? 0)}`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : !error ? (
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>Pricing…</div>
      ) : null}
    </div>
  );
}
