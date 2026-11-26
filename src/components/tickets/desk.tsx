"use client";
/**
 * Tickets desk (demo tickets(), tkBody(), tkBook()): three computed alert cards, plan chips, the
 * options table ranked by landed cost, the 14-day fare trend with the budget line (no prediction
 * line, TKT-4), the preview panel, the booking plan (PNR split) and the confirm-booking modal.
 * Extra profit arrives as null for STAFF and is then not rendered.
 */
import type { Role } from "@prisma/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmBookingAction } from "@/app/(app)/tickets/actions";
import { useToast } from "@/components/shell/toast";
import type { DeskAlerts, OptionView, PlanView } from "@/server/domain/tickets/queries";
import { inr, pct } from "@/server/money";

const IRCTC_URL = "https://www.irctc.co.in/nget/train-search";

type Desk = { plans: { id: string; label: string }[]; plan: PlanView | null; alerts: DeskAlerts };

export function TicketsDesk({ desk, role, base }: { desk: Desk; role: Role; base: string }) {
  const { plan, alerts } = desk;
  return (
    <>
      <AlertCards alerts={alerts} />
      <div className="chips" style={{ margin: "18px 0 12px", alignItems: "center" }}>
        {desk.plans.map((p) => (
          <Link key={p.id} href={`/tickets?plan=${p.id}`} scroll={false} className={`btn ${plan?.id === p.id ? "b1" : "b2"} sm`}>
            {p.label}
          </Link>
        ))}
        <Link href={`${base}${base.includes("?") ? "&" : "?"}edit=new`} scroll={false} className="btn b2 sm">
          + New plan
        </Link>
        {plan ? (
          <Link href={`${base}&edit=${plan.id}`} scroll={false} className="btn b2 sm" style={{ marginLeft: "auto" }}>
            Edit plan &amp; options
          </Link>
        ) : null}
      </div>
      {plan ? <PlanBody plan={plan} role={role} /> : <div className="card pad muted">No travel plans yet. Add one for a departure or a custom trip.</div>}
    </>
  );
}

// ───────────────────────────── alert cards ─────────────────────────────

function AlertCards({ alerts }: { alerts: DeskAlerts }) {
  const toast = useToast();
  const { window: w, fare, newTravellers: nt } = alerts;
  return (
    <div className="g4 g3">
      <div className="card pad">
        <div className="h" style={{ marginBottom: 6 }}>
          <b>🚆 Train window opens soon</b>
          <span className={`pill ${w ? "p-w" : "p-ok"}`}>{w ? (w.days === 0 ? "Today" : `${w.days} day${w.days === 1 ? "" : "s"}`) : "None soon"}</span>
        </div>
        <p className="muted" style={{ fontSize: 13.5 }}>
          {w ? (
            <>
              {w.title}: bookings open <b style={{ color: "var(--text)" }}>{w.opens}</b>.{" "}
              {w.ready >= w.total ? `${w.total} travellers' details are ready.` : `${w.ready} of ${w.total} travellers' details are ready.`}
            </>
          ) : (
            "No train booking window is waiting to open."
          )}
        </p>
        {w ? (
          <button type="button" className="btn b2 sm" style={{ marginTop: 10 }} onClick={() => toast(`Reminders go to you on ${w.remind}`, "⏰")}>
            Remind me
          </button>
        ) : null}
      </div>
      <div className="card pad">
        <div className="h" style={{ marginBottom: 6 }}>
          <b>✈ Fare is rising</b>
          <span className={`pill ${fare ? "p-b" : "p-ok"}`}>{fare ? `Up ${pct(fare.riseBps, 0)}` : "Steady"}</span>
        </div>
        <p className="muted" style={{ fontSize: 13.5 }}>
          {fare ? (
            <>
              {fare.text} went up <b style={{ color: "var(--text)" }}>{inr(fare.rise)}</b> in 2 weeks. {fare.underBudget ? "Still under budget today." : "Now over budget."}
            </>
          ) : (
            "No tracked fare has gone up 5% or more in the last 2 weeks."
          )}
        </p>
        {fare ? (
          <Link className="btn b2 sm" style={{ marginTop: 10 }} href={`/tickets?plan=${fare.planId}`} scroll={false}>
            Open
          </Link>
        ) : null}
      </div>
      <div className="card pad">
        <div className="h" style={{ marginBottom: 6 }}>
          <b>🎫 New travellers need tickets</b>
          <span className={`pill ${nt.count ? "p-l" : "p-ok"}`}>{nt.count || "All done"}</span>
        </div>
        <p className="muted" style={{ fontSize: 13.5 }}>
          {nt.text}
        </p>
        {nt.planId ? (
          <Link className="btn b2 sm" style={{ marginTop: 10 }} href={`/tickets?plan=${nt.planId}`} scroll={false}>
            Plan
          </Link>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────────── plan body ─────────────────────────────

const tagTone = (t: string) => (/Cheapest landed|Best value/.test(t) ? "p-ok" : /Too long|Comfort|Over|expensive/i.test(t) ? "p-b" : "p-l");

function PlanBody({ plan, role }: { plan: PlanView; role: Role }) {
  const [booking, setBooking] = useState<OptionView | null>(null);
  const best = plan.best;
  return (
    <div className="g2">
      <div>
        <div className="card">
          <div className="pad h" style={{ margin: 0, borderBottom: "1px solid var(--line)" }}>
            <div>
              <h3>{plan.label}</h3>
              <small className="muted">
                {plan.who} · {plan.dateLabel} · {plan.pax} traveller{plan.pax === 1 ? "" : "s"}
              </small>
            </div>
            <span className="pill p-l">Ranked by real cost, not ticket price</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Option</th>
                  <th>Ticket</th>
                  <th>Hidden extras</th>
                  <th>Real cost / person</th>
                  <th>vs budget</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plan.options.map((o) => (
                  <tr key={o.id} className={o.best ? "best" : undefined}>
                    <td>
                      <b>{o.title}</b>
                      <br />
                      <small className="muted">{o.details}</small>
                      {o.tags.length || o.disqualified ? (
                        <div className="chips" style={{ marginTop: 4 }}>
                          {o.tags.map((t) => (
                            <span key={t} className={`pill ${tagTone(t)}`}>
                              {t}
                            </span>
                          ))}
                          {o.disqualified && o.disqualifiedReason && !o.tags.includes(o.disqualifiedReason) ? <span className="pill p-b">{o.disqualifiedReason}</span> : null}
                        </div>
                      ) : null}
                    </td>
                    <td>{inr(o.ticketPerPax)}</td>
                    <td>
                      {o.extrasPerPax ? (
                        <>
                          {inr(o.extrasPerPax)}
                          {o.extrasNote ? (
                            <>
                              <br />
                              <small className="muted">{o.extrasNote}</small>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <b>{inr(o.landed)}</b>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <b style={{ color: o.vsBudget >= 0 ? "var(--ok)" : "var(--bad)" }}>
                        {o.vsBudget >= 0 ? "+" : "−"}
                        {inr(Math.abs(o.vsBudget))}
                      </b>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {o.booked ? (
                        <span className="pill p-ok">Booked ✓</span>
                      ) : plan.kind === "window" && o.mode === "TRAIN" && plan.windowOpens ? (
                        <span className="pill p-g">Opens {plan.windowOpens.short}</span>
                      ) : (
                        <button
                          type="button"
                          className={`btn ${o.best ? "b1" : "b2"} sm`}
                          disabled={plan.locked || plan.toTicket === 0}
                          title={plan.toTicket === 0 && !plan.locked ? "No confirmed travellers yet" : undefined}
                          onClick={() => setBooking(o)}
                        >
                          Book
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {plan.options.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No options yet. Use “Edit plan &amp; options” to add flights, trains or buses.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        {plan.trend ? <FareTrend plan={plan} /> : null}
      </div>

      <div>
        <div className="preview">
          <p>Travel budget in the price</p>
          <div className="big" style={{ fontSize: 26 }}>
            {inr(plan.budgetPerPax)} × {plan.pax} = {inr(plan.budgetPerPax * plan.pax)}
          </div>
          <p style={{ marginTop: 10 }}>
            {best ? (
              <>
                {plan.locked ? "Booked" : "Best option"}: <b style={{ color: "#fff" }}>{best.title.split(" · ")[0]}</b> at {inr(best.landed)} per person
              </>
            ) : (
              "No option qualifies yet."
            )}
          </p>
          {plan.extraProfit !== null && best ? (
            <div style={{ background: "rgba(255,255,255,.1)", borderRadius: 12, padding: 12, marginTop: 12 }}>
              <p style={{ fontSize: 13 }}>{plan.locked ? "Profit locked in" : "Extra profit if you book this"}</p>
              <div className="big" style={{ color: plan.extraProfit >= 0 ? "#7CF0B5" : "#FFB4A8" }}>
                {plan.extraProfit >= 0 ? "+" : "−"}
                {inr(Math.abs(plan.extraProfit))}
              </div>
            </div>
          ) : null}
          {plan.note ? <p style={{ fontSize: 12.5, marginTop: 10 }}>{plan.note}</p> : null}
        </div>
        {plan.kind !== "flight" && plan.split.length ? <BookingPlan plan={plan} /> : null}
        {plan.tickets.length ? <BookedTickets plan={plan} /> : null}
        <div className="card pad" style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 6 }}>How booking works</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {plan.kind === "flight"
              ? "Fares are entered here by hand for now (portal fares come later). Book on your B2B travel portal, then press Book to save the PNR and ticket PDF. The PDF goes to the customer on WhatsApp."
              : "Train tickets are booked by you on IRCTC. The desk tells you when bookings open, and which passengers go on which ticket. Then press Book to save the PNRs; the PDFs go to each family on WhatsApp."}
          </p>
        </div>
      </div>
      {booking ? <ConfirmModal plan={plan} option={booking} role={role} onClose={() => setBooking(null)} /> : null}
    </div>
  );
}

// ───────────────────────────── fare trend (TKT-4) ─────────────────────────────

function FareTrend({ plan }: { plan: PlanView }) {
  const t = plan.trend!;
  const w = 360;
  const h = 110;
  const lo = Math.min(...t.fares, plan.budgetPerPax) - 15_000;
  const hi = Math.max(...t.fares, plan.budgetPerPax) + 25_000;
  const X = (i: number) => 12 + (i / Math.max(1, t.fares.length - 1)) * (w - 40);
  const top = 16; // room for the budget label
  const Y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (h - top);
  const pts = t.fares.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const last = t.fares.length - 1;
  return (
    <div className="card pad" style={{ marginTop: 14 }}>
      <div className="h" style={{ marginBottom: 4 }}>
        <h3>Fare trend · {t.title}</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          last 14 days
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h + 20}`} style={{ width: "100%", height: "auto", maxHeight: 170 }} role="img" aria-label={`Fare over the last 14 days, today ${inr(t.today)}, budget ${inr(plan.budgetPerPax)}`}>
        <line x1="0" x2={w} y1={Y(plan.budgetPerPax)} y2={Y(plan.budgetPerPax)} stroke="#1E9E6A" strokeDasharray="4 4" />
        <text x={w - 4} y={Y(plan.budgetPerPax) - 5} textAnchor="end" fontSize="10" fill="#1E9E6A">
          your budget {inr(plan.budgetPerPax)}
        </text>
        <polyline points={pts} fill="none" stroke="#221944" strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx={X(last)} cy={Y(t.today)} r="4.5" fill="#221944" />
        <text x={X(last)} y={Y(t.today) + 18} textAnchor="end" fontSize="10.5" fontWeight="700" fill="#221944">
          today {inr(t.today)}
        </text>
      </svg>
      <p className="muted" style={{ fontSize: 12.5 }}>
        {t.rise > 0 ? `Up ${inr(t.rise)} in 14 days.` : t.rise < 0 ? `Down ${inr(-t.rise)} in 14 days.` : "No change in 14 days."}
        {plan.extraProfit !== null && !plan.locked && plan.extraProfit > 0 ? ` Booking today keeps ${inr(plan.extraProfit)} as profit.` : ""}
      </p>
    </div>
  );
}

// ───────────────────────────── booking plan (TKT-6) ─────────────────────────────

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function BookingPlan({ plan }: { plan: PlanView }) {
  const toast = useToast();
  const g = plan.split;
  const openIrctc = async () => {
    // Open first (still inside the click), then copy.
    window.open(IRCTC_URL, "_blank", "noopener,noreferrer");
    const ok = await copy(g.map((x) => x.text).join("\n\n"));
    toast(ok ? `Passenger list for ${g.length} ticket${g.length === 1 ? "" : "s"} copied · IRCTC opened` : "Couldn't copy. Use the copy buttons per ticket.", ok ? "📋" : "⚠️");
  };
  return (
    <div className="card pad" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 4 }}>
        Booking plan · {g.length} ticket{g.length > 1 ? "s" : ""} (max 6 people each)
      </h3>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Families stay on the same ticket so they sit together.
        {plan.status === "BOOKED" ? " These are the travellers not ticketed yet." : ""}
      </p>
      {g.map((x, i) => (
        <div key={i} className="kv" style={{ borderBottom: "1px dashed var(--line)", padding: "7px 0", alignItems: "center", gap: 8 }}>
          <span>
            Ticket {i + 1} · {x.label}
          </span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <b>
              {x.count} passenger{x.count > 1 ? "s" : ""}
            </b>
            <button
              type="button"
              className="btn b2 sm"
              style={{ padding: "3px 8px" }}
              aria-label={`Copy passenger list for ticket ${i + 1}`}
              onClick={async () => toast((await copy(x.text)) ? `Ticket ${i + 1} passenger list copied` : "Couldn't copy", "📋")}
            >
              Copy
            </button>
          </span>
        </div>
      ))}
      <button type="button" className="btn b2 sm" style={{ marginTop: 10 }} onClick={openIrctc}>
        Copy passenger list &amp; open IRCTC
      </button>
    </div>
  );
}

function BookedTickets({ plan }: { plan: PlanView }) {
  return (
    <div className="card pad" style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 4 }}>
        Tickets booked · {plan.tickets.length} ticket{plan.tickets.length > 1 ? "s" : ""}, {plan.ticketedPax} passenger{plan.ticketedPax === 1 ? "" : "s"}
      </h3>
      {plan.tickets.map((t) => (
        <div key={t.idx} className="kv" style={{ borderBottom: "1px dashed var(--line)", padding: "7px 0", gap: 8 }}>
          <span>
            Ticket {t.idx} · {t.label} · {t.count}
          </span>
          <b style={{ whiteSpace: "nowrap" }}>
            {t.pnr ? `PNR ${t.pnr}` : "—"}
            {t.documentId ? (
              <>
                {" "}
                ·{" "}
                <a href={`/api/files/${t.documentId}`} target="_blank" rel="noreferrer">
                  PDF
                </a>
              </>
            ) : null}
          </b>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── confirm booking (TKT-7, demo tkBook) ─────────────────────────────

function ConfirmModal({ plan, option, role, onClose }: { plan: PlanView; option: OptionView; role: Role; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const groups = plan.split;
  const pax = plan.toTicket;
  const flight = option.mode === "FLIGHT";

  const submit = (form: HTMLFormElement) => {
    setError(null);
    const fd = new FormData(form);
    fd.set("planId", plan.id);
    fd.set("optionId", option.id);
    fd.set("count", String(groups.length));
    start(async () => {
      const r = await confirmBookingAction(fd);
      if (!r.ok) return setError(r.error);
      const pnrs = [...new Set(r.pnrs)].join(", ");
      toast(
        `${r.pax} ticket${r.pax === 1 ? "" : "s"} booked · PNR ${pnrs}${r.withPdf ? ` · sending to ${flight ? "the customer" : "travellers"} on WhatsApp` : " · no PDFs to send yet"}`,
        "🎫",
      );
      onClose();
      router.refresh();
    });
  };

  return (
    <div
      className="drawer"
      style={{ alignItems: "center", justifyContent: "center" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <form
        className="card pad"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm booking"
        style={{ width: "min(480px, 94vw)", maxHeight: "92vh", overflowY: "auto" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget);
        }}
      >
        <h3 style={{ marginBottom: 6 }}>Confirm booking</h3>
        <p className="muted" style={{ fontSize: 13.5 }}>
          {option.title}
          <br />
          {option.details}
        </p>
        <div className="card pad" style={{ background: "var(--lav3)", margin: "12px 0" }}>
          <div className="kv">
            <span>Passengers</span>
            <b>{pax}</b>
          </div>
          <div className="kv">
            <span>Tickets total</span>
            <b>{inr(option.ticketPerPax * pax)}</b>
          </div>
          <div className="kv">
            <span>Book on</span>
            <b>{flight ? "Your B2B travel portal" : option.mode === "TRAIN" ? "IRCTC (your agent login)" : "The operator"}</b>
          </div>
          {role === "OWNER" ? (
            <div className="kv">
              <span>Extra profit vs budget</span>
              <b style={{ color: option.vsBudget >= 0 ? "var(--ok)" : "var(--bad)" }}>
                {option.vsBudget >= 0 ? "+" : "−"}
                {inr(Math.abs(option.vsBudget * pax))}
              </b>
            </div>
          ) : null}
        </div>

        {groups.map((g, i) => (
          <fieldset key={i} style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "8px 12px", marginBottom: 8 }}>
            <legend style={{ fontSize: 12.5, padding: "0 4px" }}>
              <b>Ticket {i + 1}</b> · {g.label} · {g.count} passenger{g.count > 1 ? "s" : ""}
            </legend>
            <div className="two">
              <div className="fld" style={{ marginBottom: 4 }}>
                <label htmlFor={`pnr-${i}`}>PNR</label>
                <input id={`pnr-${i}`} name={`pnr-${i}`} className="inp" required autoComplete="off" placeholder={flight ? "6E-QK7P2" : "2456130000"} style={{ textTransform: "uppercase" }} />
              </div>
              <div className="fld" style={{ marginBottom: 4 }}>
                <label htmlFor={`file-${i}`}>Ticket PDF</label>
                <input id={`file-${i}`} name={`file-${i}`} type="file" accept="application/pdf,.pdf" className="inp" style={{ padding: 6 }} />
              </div>
            </div>
          </fieldset>
        ))}

        <p className="muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>
          Book on {flight ? "the portal" : "IRCTC"} first, then save the PNRs here. Fares can change until the ticket is issued, so check the amount before you pay. PDFs (up to 10 MB each) go to each booking on WhatsApp.
        </p>
        {error ? (
          <p role="alert" style={{ color: "var(--bad)", fontSize: 13.5, marginBottom: 8 }}>
            {error}
          </p>
        ) : null}
        <div className="chips">
          <button type="submit" className="btn b1" disabled={pending}>
            {pending ? "Saving tickets…" : "Confirm & book"}
          </button>
          <button type="button" className="btn b2" disabled={pending} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
