"use client";
/** INB-8 right panel: editable lead; deal guardrail, approval and timeline arrive with the deal desk (P4). */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateLeadAction } from "@/app/(app)/inbox/actions";
import { useToast } from "@/components/shell/toast";

type Lead = { departureId: string | null; tripLabel: string | null; pax: number | null; sourceNote: string | null; temp: "NEW" | "COLD" | "WARM" | "HOT" };
const TEMP: Record<Lead["temp"], string> = { NEW: "New", COLD: "🧊 Cold", WARM: "🌤 Warm", HOT: "🔥 Hot" };

export function LeadPanel({ conversationId, lead, departures, channelLabel }: { conversationId: string; lead: Lead; departures: { id: string; label: string }[]; channelLabel: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [departureId, setDepartureId] = useState(lead.departureId ?? "");
  const [pax, setPax] = useState(lead.pax ? String(lead.pax) : "");
  const [source, setSource] = useState(lead.sourceNote ?? "");
  const [temp, setTemp] = useState(lead.temp);
  const dirty = departureId !== (lead.departureId ?? "") || pax !== (lead.pax ? String(lead.pax) : "") || source !== (lead.sourceNote ?? "") || temp !== lead.temp;
  // A past departure stays selectable for this lead even though it's no longer on sale.
  const options = lead.departureId && !departures.some((d) => d.id === lead.departureId) ? [{ id: lead.departureId, label: lead.tripLabel ?? "Earlier trip" }, ...departures] : departures;

  return (
    <div className="ipanel">
      <h4>Lead</h4>
      <div className="fld">
        <label htmlFor="lead-trip">Trip</label>
        <select id="lead-trip" className="inp" value={departureId} onChange={(e) => setDepartureId(e.target.value)}>
          <option value="">Not decided</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div className="fld" style={{ flex: 1 }}>
          <label htmlFor="lead-pax">Travellers</label>
          <input id="lead-pax" className="inp" inputMode="numeric" placeholder="–" value={pax} onChange={(e) => setPax(e.target.value.replace(/\D/g, "").slice(0, 3))} />
        </div>
        <div className="fld" style={{ flex: 1 }}>
          <label htmlFor="lead-temp">Temperature</label>
          <select id="lead-temp" className="inp" value={temp} onChange={(e) => setTemp(e.target.value as Lead["temp"])}>
            {(Object.keys(TEMP) as Lead["temp"][]).map((t) => (
              <option key={t} value={t}>
                {TEMP[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="fld">
        <label htmlFor="lead-src">Source</label>
        <input id="lead-src" className="inp" placeholder={`${channelLabel} enquiry`} value={source} onChange={(e) => setSource(e.target.value)} maxLength={120} />
      </div>
      {dirty ? (
        <button
          type="button"
          className="btn b1 sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await updateLeadAction(conversationId, {
                departureId: departureId || null,
                pax: pax ? Number(pax) : null,
                sourceNote: source || null,
                temp,
              });
              if (r.ok) {
                toast("Lead updated");
                router.refresh();
              } else toast(r.error, "⚠️");
            })
          }
        >
          {pending ? "Saving…" : "Save lead"}
        </button>
      ) : null}

      <h4>Deal guardrail</h4>
      <div className="soon">The quote builder and price guardrail arrive with the deal desk.</div>
      <h4>Approval</h4>
      <div className="soon">Owner approvals for prices below the staff limit show here.</div>
      <h4>Timeline</h4>
      <div className="soon">Quotes, approvals, payment links and payments for this chat will be listed here.</div>
    </div>
  );
}
