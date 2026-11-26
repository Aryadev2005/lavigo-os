"use client";
/**
 * Plan + options sheet (TKT-1, TKT-2): create/edit a plan for a departure or a custom booking, and
 * add/edit/delete its options. Pax is never typed: it comes from the bookings. Fare edits are
 * recorded as fare snapshots on the server.
 */
import type { TravelMode } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteOptionAction, deletePlanAction, saveOptionAction, savePlanAction } from "@/app/(app)/tickets/actions";
import { useToast } from "@/components/shell/toast";
import type { OptionView, PlanForm, PlanView } from "@/server/domain/tickets/queries";
import { inr } from "@/server/money";

const MODES: [TravelMode, string][] = [
  ["FLIGHT", "Flight"],
  ["TRAIN", "Train"],
  ["BUS", "Bus"],
  ["OTHER", "Other"],
];
const rupeesOf = (paise: number | null | undefined) => (paise ? String(Math.round(paise / 100)) : "");

export function PlanSheet({ form, plan, closeHref }: { form: PlanForm; plan: PlanView | null; closeHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [forKind, setForKind] = useState<"departure" | "booking">(plan?.bookingId ? "booking" : "departure");
  const [d, setD] = useState({
    label: plan?.label ?? "",
    departureId: plan?.departureId ?? "",
    bookingId: plan?.bookingId ?? "",
    origin: plan?.origin ?? "Ranchi",
    destination: plan?.destination ?? "",
    travelDate: plan?.travelDate ?? "",
    budget: rupeesOf(plan?.budgetPerPax),
    note: plan?.note ?? "",
  });
  const set = (k: keyof typeof d, v: string) => setD((x) => ({ ...x, [k]: v }));

  const pickDeparture = (idValue: string) => {
    const dep = form.departures.find((x) => x.id === idValue);
    setD((x) => ({
      ...x,
      departureId: idValue,
      travelDate: dep?.startDate ?? x.travelDate,
      destination: x.destination || (dep?.destination ?? ""),
      budget: x.budget || rupeesOf(dep?.budget),
      label: x.label || (dep ? `${dep.label.split(" · ")[0]} · group` : ""),
    }));
  };
  const pickBooking = (idValue: string) => {
    const b = form.bookings.find((x) => x.id === idValue);
    setD((x) => ({ ...x, bookingId: idValue, travelDate: b?.startDate ?? x.travelDate, label: x.label || (b ? `${b.label.replace(/\s*\(.*\)$/, "")} · custom` : "") }));
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = await savePlanAction(plan?.id ?? null, {
        label: d.label,
        departureId: forKind === "departure" ? d.departureId || null : null,
        bookingId: forKind === "booking" ? d.bookingId || null : null,
        origin: d.origin,
        destination: d.destination,
        travelDate: d.travelDate,
        budget: d.budget,
        note: d.note || null,
      });
      if (!r.ok) return setError(r.error);
      toast(plan ? "Plan saved" : "Plan added. Now add options.", "🎫");
      router.push(`/tickets?plan=${r.id}&edit=${r.id}`, { scroll: false });
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      if (!plan || !confirm(`Delete ${plan.label} and its options?`)) return;
      const r = await deletePlanAction(plan.id);
      if (!r.ok) return setError(r.error);
      toast("Plan deleted", "🗑️");
      router.push("/tickets", { scroll: false });
    });

  return (
    <>
      <div className="h">
        <div>
          <span className="muted">Tickets desk</span>
          <h2 style={{ fontSize: 22 }}>{plan ? plan.label : "New travel plan"}</h2>
        </div>
        <button type="button" className="btn b2 sm" onClick={() => router.push(closeHref, { scroll: false })}>
          Close
        </button>
      </div>

      <div className="card pad" style={{ margin: "12px 0" }}>
        <b>Plan</b>
        <div className="chips" style={{ margin: "10px 0" }} role="radiogroup" aria-label="Plan for">
          {(["departure", "booking"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={forKind === k}
              disabled={plan?.status === "BOOKED"}
              className={`pill ${forKind === k ? "p-l" : "p-g"}`}
              style={{ border: 0, cursor: "pointer" }}
              onClick={() => setForKind(k)}
            >
              {k === "departure" ? "Group departure" : "Custom booking"}
            </button>
          ))}
        </div>
        {forKind === "departure" ? (
          <div className="fld">
            <label htmlFor="tp-dep">Departure</label>
            <select id="tp-dep" className="inp" value={d.departureId} disabled={plan?.status === "BOOKED"} onChange={(e) => pickDeparture(e.target.value)}>
              <option value="">Choose…</option>
              {form.departures.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
              {plan?.departureId && !form.departures.some((x) => x.id === plan.departureId) ? <option value={plan.departureId}>{plan.label}</option> : null}
            </select>
          </div>
        ) : (
          <div className="fld">
            <label htmlFor="tp-bk">Custom booking</label>
            <select id="tp-bk" className="inp" value={d.bookingId} disabled={plan?.status === "BOOKED"} onChange={(e) => pickBooking(e.target.value)}>
              <option value="">Choose…</option>
              {form.bookings.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
              {plan?.bookingId && !form.bookings.some((x) => x.id === plan.bookingId) ? <option value={plan.bookingId}>{plan.label}</option> : null}
            </select>
          </div>
        )}
        <div className="fld">
          <label htmlFor="tp-l">Name</label>
          <input id="tp-l" className="inp" placeholder="Goa family · custom" value={d.label} onChange={(e) => set("label", e.target.value)} />
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="tp-o">From</label>
            <input id="tp-o" className="inp" value={d.origin} onChange={(e) => set("origin", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="tp-to">To</label>
            <input id="tp-to" className="inp" value={d.destination} onChange={(e) => set("destination", e.target.value)} />
          </div>
        </div>
        <div className="two">
          <div className="fld">
            <label htmlFor="tp-dt">Travel date</label>
            <input id="tp-dt" type="date" className="inp" value={d.travelDate} onChange={(e) => set("travelDate", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="tp-b">Travel budget per person (₹)</label>
            <input id="tp-b" className="inp" inputMode="numeric" value={d.budget} onChange={(e) => set("budget", e.target.value)} />
          </div>
        </div>
        <div className="fld">
          <label htmlFor="tp-n">Note</label>
          <input id="tp-n" className="inp" value={d.note} onChange={(e) => set("note", e.target.value)} />
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Travellers come from the {forKind === "departure" ? "confirmed bookings on the departure" : "booking"}; you don&apos;t enter them here.
        </p>
        {error ? (
          <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
            {error}
          </p>
        ) : null}
        <div className="chips" style={{ marginTop: 12 }}>
          <button type="button" className="btn b1 sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : plan ? "Save plan" : "Add plan"}
          </button>
          {plan && plan.status !== "BOOKED" && plan.tickets.length === 0 ? (
            <button type="button" className="btn b2 sm" disabled={pending} onClick={remove}>
              Delete plan
            </button>
          ) : null}
        </div>
      </div>

      {plan ? <Options plan={plan} /> : null}
    </>
  );
}

type OptDraft = {
  mode: TravelMode;
  title: string;
  details: string;
  ticket: string;
  extras: string;
  extrasNote: string;
  tags: string;
  disqualified: boolean;
  disqualifiedReason: string;
};
const blank: OptDraft = { mode: "FLIGHT", title: "", details: "", ticket: "", extras: "", extrasNote: "", tags: "", disqualified: false, disqualifiedReason: "" };
const toDraft = (o: OptionView): OptDraft => ({
  mode: o.mode,
  title: o.title,
  details: o.details,
  ticket: rupeesOf(o.ticketPerPax),
  extras: rupeesOf(o.extrasPerPax),
  extrasNote: o.extrasNote ?? "",
  tags: o.tags.join(", "),
  disqualified: o.disqualified,
  disqualifiedReason: o.disqualifiedReason ?? "",
});

function Options({ plan }: { plan: PlanView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<string | "new" | null>(plan.options.length ? null : "new");
  const [o, setO] = useState<OptDraft>(blank);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof OptDraft>(k: K, v: OptDraft[K]) => setO((x) => ({ ...x, [k]: v }));

  const edit = (opt: OptionView | null) => {
    setError(null);
    setEditing(opt ? opt.id : "new");
    setO(opt ? toDraft(opt) : blank);
  };
  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveOptionAction(plan.id, editing === "new" ? null : editing, {
        mode: o.mode,
        title: o.title,
        details: o.details,
        ticket: o.ticket,
        extras: o.extras,
        extrasNote: o.extrasNote || null,
        tags: o.tags.split(",").map((t) => t.trim()).filter(Boolean),
        disqualified: o.disqualified,
        disqualifiedReason: o.disqualifiedReason || null,
      });
      if (!r.ok) return setError(r.error);
      toast(r.snapshot ? "Option saved · fare recorded for the trend" : "Option saved", "🎫");
      setEditing(null);
      router.refresh();
    });
  const remove = (opt: OptionView) =>
    start(async () => {
      if (!confirm(`Delete ${opt.title}?`)) return;
      const r = await deleteOptionAction(opt.id);
      if (!r.ok) return toast(r.error, "⚠️");
      router.refresh();
    });

  return (
    <div className="card pad">
      <div className="h" style={{ marginBottom: 8 }}>
        <b>Options</b>
        <button type="button" className="btn b2 sm" onClick={() => edit(null)}>
          + Add option
        </button>
      </div>

      {editing ? (
        <div className="card pad" style={{ background: "var(--lav3)", marginBottom: 12 }}>
          <div className="two">
            <div className="fld">
              <label htmlFor="op-m">Mode</label>
              <select id="op-m" className="inp" value={o.mode} onChange={(e) => set("mode", e.target.value as TravelMode)}>
                {MODES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="op-t">Ticket per person (₹)</label>
              <input id="op-t" className="inp" inputMode="numeric" value={o.ticket} onChange={(e) => set("ticket", e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="op-n">Option</label>
            <input id="op-n" className="inp" placeholder="IndiGo · Ranchi → Mumbai → Goa (GOI)" value={o.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="op-d">Details</label>
            <input id="op-d" className="inp" placeholder="07:05 → 13:40 · 1 stop · 6h 35m" value={o.details} onChange={(e) => set("details", e.target.value)} />
          </div>
          <div className="two">
            <div className="fld">
              <label htmlFor="op-x">Hidden extras per person (₹)</label>
              <input id="op-x" className="inp" inputMode="numeric" placeholder="0" value={o.extras} onChange={(e) => set("extras", e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="op-xn">What the extras are</label>
              <input id="op-xn" className="inp" placeholder="Extra hotel night, longer cab" value={o.extrasNote} onChange={(e) => set("extrasNote", e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <label htmlFor="op-tg">Tags (comma separated)</label>
            <input id="op-tg" className="inp" placeholder="Cheapest landed" value={o.tags} onChange={(e) => set("tags", e.target.value)} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
            <input type="checkbox" checked={o.disqualified} onChange={(e) => set("disqualified", e.target.checked)} /> Not suitable (never picked as best)
          </label>
          {o.disqualified ? (
            <div className="fld" style={{ marginTop: 8 }}>
              <label htmlFor="op-r">Why</label>
              <input id="op-r" className="inp" placeholder="Too long for a 5-day trip" value={o.disqualifiedReason} onChange={(e) => set("disqualifiedReason", e.target.value)} />
            </div>
          ) : null}
          {error ? (
            <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginTop: 8 }}>
              {error}
            </p>
          ) : null}
          <div className="chips" style={{ marginTop: 12 }}>
            <button type="button" className="btn b1 sm" disabled={pending} onClick={save}>
              {pending ? "Saving…" : "Save option"}
            </button>
            <button type="button" className="btn b2 sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <table className="t">
        <thead>
          <tr>
            <th>Option</th>
            <th>Ticket</th>
            <th>Extras</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plan.options.map((opt) => (
            <tr key={opt.id} style={opt.disqualified ? { opacity: 0.6 } : undefined}>
              <td>
                <b>{opt.title}</b>
                <br />
                <small className="muted">
                  {MODES.find(([m]) => m === opt.mode)?.[1]}
                  {opt.disqualified ? ` · not suitable: ${opt.disqualifiedReason}` : ""}
                </small>
              </td>
              <td>{inr(opt.ticketPerPax)}</td>
              <td>{opt.extrasPerPax ? inr(opt.extrasPerPax) : "—"}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button type="button" className="btn b2 sm" onClick={() => edit(opt)}>
                  Edit
                </button>{" "}
                {opt.booked || plan.status === "BOOKED" ? null : (
                  <button type="button" className="btn b2 sm" disabled={pending} onClick={() => remove(opt)}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
