/**
 * INB-8 right panel, below the lead: deal guardrail, approval card, quote + payment link, result,
 * and the conversation timeline (v1's replacement for the demo's "What the AI did").
 * Props are built per role by deals/queries.getDealPanel: a STAFF panel has no floor/cost/margin.
 */
import { inr, pct } from "@/server/money";
import type { DealPanel } from "@/server/domain/deals/queries";
import { ApprovalActions } from "./approval-actions";
import { FollowUpButton, PaymentLinkButton } from "./deal-actions";
import { GuardrailMeter } from "./guardrail-meter";

export function DealPanelView({ panel, conversationId }: { panel: DealPanel; conversationId: string }) {
  const a = panel.approval;
  return (
    <>
      <h4>Deal guardrail</h4>
      {panel.basis && panel.meter && panel.price ? (
        <>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {panel.basis.label} · {panel.basis.pax} traveller{panel.basis.pax > 1 ? "s" : ""}
            {panel.owner ? (
              <>
                <br />
                Your cost {inr(panel.owner.costPerPax)}/person · minimum margin {pct(panel.owner.floorMarginBps, 0)}
              </>
            ) : null}
          </div>
          <GuardrailMeter meter={panel.meter} />
          {panel.owner ? (
            <div className="kv">
              <span>Margin at current offer</span>
              <b style={{ color: panel.owner.marginBpsAtOffer >= panel.owner.floorMarginBps ? "var(--ok)" : "var(--bad)" }}>{pct(panel.owner.marginBpsAtOffer)}</b>
            </div>
          ) : null}
          <div className="kv">
            <span>Staff limit</span>
            <b>{inr(panel.price.staffLimit)}/person</b>
          </div>
        </>
      ) : (
        <div className="soon">Pick a trip and travellers in the lead (or build a quote) to see the guardrail.</div>
      )}
      <div className="kv">
        <span>Staff can give alone</span>
        <b>{panel.staffCanGive}</b>
      </div>

      {a ? (
        <div className="approval" id="appr">
          <div className="t1">🤝 {panel.role === "OWNER" ? "Needs your OK" : "Waiting for owner"}</div>
          <div style={{ fontSize: 13.5 }}>
            {a.customerFirst} asks <b>{a.requested != null ? inr(a.requested) : "–"}</b>/person for {a.pax ?? "?"}
            {a.trip ? ` (${a.trip})` : ""}.
            {a.owner && a.owner.belowFloor ? (
              <>
                {" "}
                That&apos;s below your floor of <b>{inr(a.owner.floor)}</b>.
              </>
            ) : null}
            {a.kind === "LARGE_GROUP" ? " Large group: always yours to decide." : null}
            {a.suggested != null ? (
              <>
                <br />
                <br />
                Suggested: <b>{inr(a.suggested)}</b>
                {a.owner ? (
                  <>
                    {" "}
                    · margin <b>{pct(a.owner.marginBpsAtSuggested)}</b>, {a.owner.marginBpsAtSuggested >= a.owner.floorMarginBps ? "above" : "below"} your {pct(a.owner.floorMarginBps, 0)} floor.
                  </>
                ) : null}
              </>
            ) : null}
          </div>
          {panel.role === "OWNER" ? (
            <ApprovalActions approvalId={a.id} suggested={a.suggested} counter={a.counter} />
          ) : (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>⏳ Asked at {a.createdAt}. The quote goes out automatically when the owner approves.</div>
          )}
        </div>
      ) : null}

      {panel.quote ? (
        <>
          <h4>Quote</h4>
          <div className="kv">
            <span>
              {panel.quote.pax} × {inr(panel.quote.pricePerPax)}
            </span>
            <b>{inr(panel.quote.totalAmount)}</b>
          </div>
          <div className="kv">
            <span>Valid till</span>
            <b style={{ color: panel.quote.valid ? undefined : "var(--bad)" }}>{panel.quote.valid ? panel.quote.validUntil : `expired ${panel.quote.validUntil}`}</b>
          </div>
          {panel.quote.valid ? (
            <div style={{ marginTop: 6 }}>
              <PaymentLinkButton key={panel.quote.id} conversationId={conversationId} quoteId={panel.quote.id} link={panel.quote.link} advance={panel.quote.advance} block />
            </div>
          ) : null}
        </>
      ) : null}
      {panel.followUpDue ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>No reply to the quote for 20 hours.</div>
          <FollowUpButton conversationId={conversationId} />
        </div>
      ) : null}

      {panel.result ? (
        <>
          <h4>Result</h4>
          <div className="kv">
            <span>Booking</span>
            <b>{panel.result.code}</b>
          </div>
          <div className="kv">
            <span>Deal value</span>
            <b>{inr(panel.result.dealValue)}</b>
          </div>
          <div className="kv">
            <span>Advance received</span>
            <b style={{ color: "var(--ok)" }}>{inr(panel.result.advanceReceived)}</b>
          </div>
        </>
      ) : null}

      <h4>Timeline</h4>
      {panel.timeline.length ? (
        <div>
          {panel.timeline.map((t) => (
            <div className="tl" key={`${t.ts}-${t.text}`}>
              <div className="d">{t.icon}</div>
              <div style={{ fontSize: 13 }}>
                {t.text}
                <small>
                  {t.at}
                  {t.sub ? ` · ${t.sub}` : ""}
                </small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="soon">Quotes, approvals, payment links and payments for this chat show here.</div>
      )}
    </>
  );
}
