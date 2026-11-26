/**
 * Deal guardrail meter, exactly like the demo (INB-8): red below the floor (owner) or the staff
 * limit (staff), amber up to the auto offer, green above. Offer marker on top, asked marker below.
 * Props come from deals/meter.ts, which never carries the floor for STAFF.
 */
import type { CSSProperties } from "react";
import type { Meter } from "@/server/domain/deals/meter";

export function GuardrailMeter({ meter }: { meter: Meter }) {
  const label = meter.floor ?? meter.limit;
  const ask = meter.asked;
  return (
    <>
      <div className="meter" style={{ "--fl": `${meter.redTo}%`, "--gp": `${meter.greenFrom}%` } as CSSProperties}>
        <div className="tr" />
        <div className="mk" style={{ left: `${meter.offer.pct}%` }}>
          <b>{meter.offer.label}</b>
          <i />
        </div>
        {ask ? (
          <div className="mk" style={{ left: `${ask.pct}%`, top: 44, flexDirection: "column-reverse" }}>
            <b style={{ background: "var(--bad)" }}>{ask.label}</b>
            <i style={{ background: "var(--bad)", height: 10 }} />
          </div>
        ) : null}
        {label ? (
          <div className="lb" style={{ left: `${label.pct}%`, top: ask ? 72 : 26 }}>
            {label.label}
          </div>
        ) : null}
      </div>
      <div style={{ height: ask ? 44 : 6 }} />
    </>
  );
}
