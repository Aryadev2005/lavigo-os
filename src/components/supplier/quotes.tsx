"use client";
/**
 * SUP-4 … SUP-7 quotes table (demo sendRfq()/pick()): waiting rows with animated dots, parsed rates,
 * "Needs check" with the raw text and one-click candidates, best row, savings banner, Add quote, Book.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addQuoteAction, bookQuoteAction, confirmQuoteAction } from "@/app/(app)/supplier/actions";
import { useToast } from "@/components/shell/toast";
import type { QuoteRowView, RfqView } from "@/server/domain/suppliers/queries";
import { inr } from "@/server/money";

function Waiting({ text }: { text: string }) {
  return (
    <span className="st">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>{" "}
      {text}
    </span>
  );
}

const via = (r: QuoteRowView) => (r.channel === "EMAIL" ? "by email" : "on WhatsApp");

function NeedsCheck({ row, disabled }: { row: QuoteRowView; disabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [other, setOther] = useState("");
  const q = row.quote!;
  const confirm = (rupees: string) =>
    start(async () => {
      const r = await confirmQuoteAction(q.id, rupees);
      if (!r.ok) toast(r.error, "⚠️");
      else router.refresh();
    });
  return (
    <td colSpan={4}>
      <span className="pill p-w" style={{ marginRight: 6 }}>
        Needs check
      </span>
      <q className="muted" style={{ fontSize: 12.5 }}>
        {q.rawText}
      </q>
      <div className="chips" style={{ marginTop: 6, alignItems: "center" }}>
        {q.candidates.map((c) => (
          <button key={c} type="button" className="btn b2 sm" disabled={pending || disabled} onClick={() => confirm(String(c / 100))} title="Use this as the rate per room per night">
            {inr(c)}/night
          </button>
        ))}
        <input
          className="inp"
          style={{ width: 110, padding: "6px 10px" }}
          inputMode="numeric"
          placeholder="Other ₹"
          aria-label={`Rate for ${row.supplierName}`}
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
        <button type="button" className="btn b2 sm" disabled={pending || disabled || !other.trim()} onClick={() => confirm(other)}>
          Use
        </button>
      </div>
    </td>
  );
}

function Row({ row, rfq }: { row: QuoteRowView; rfq: RfqView }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const q = row.quote;
  const booked = rfq.status === "BOOKED";
  const name = (
    <td>
      <b>{row.supplierName}</b>
      {q?.inclusions && !q.needsCheck ? (
        <>
          <br />
          <small className="muted">{q.inclusions}</small>
        </>
      ) : null}
    </td>
  );
  let cells: React.ReactNode;
  if (row.status === "DECLINED") cells = <td colSpan={4} className="muted">Declined · can&apos;t do these dates</td>;
  else if (q && q.needsCheck) cells = <NeedsCheck row={row} disabled={booked} />;
  else if (q) {
    cells = (
      <>
        <td>
          <b>{inr(q.ratePerRoomNight)}</b>
          {q.source === "MANUAL" ? <small className="muted"> · added by hand</small> : null}
        </td>
        <td>{inr(q.totalAmount)}</td>
        <td>{row.repliedIn ?? "—"}</td>
        <td>
          {q.status === "BOOKED" ? (
            <button type="button" className="btn bok sm" disabled>
              Booked ✓
            </button>
          ) : (
            <button
              type="button"
              className="btn b2 sm"
              disabled={pending || booked}
              onClick={() =>
                start(async () => {
                  const r = await bookQuoteAction(q.id);
                  if (!r.ok) toast(r.error, "⚠️");
                  else {
                    toast(`Booked ${row.supplierName} · confirmation sent, hotel cost added to the departure`, "🏨");
                    router.refresh();
                  }
                })
              }
            >
              Book
            </button>
          )}
        </td>
      </>
    );
  } else if (row.status === "QUEUED") cells = <td colSpan={4}><Waiting text="Sending…" /></td>;
  else if (row.status === "SENT") cells = <td colSpan={4}><Waiting text={`Sent ${via(row)} · waiting`} /></td>;
  else if (row.status === "NUDGED") cells = <td colSpan={4}><Waiting text={`Nudged ${via(row)} · waiting`} /></td>;
  else if (row.status === "NO_REPLY") cells = <td colSpan={4} className="muted">No reply in 24 hours</td>;
  else if (row.status === "FAILED") cells = <td colSpan={4} style={{ color: "var(--bad)" }}>Couldn&apos;t send · check their contact</td>;
  else cells = <td colSpan={4} className="muted">—</td>;
  return (
    <tr className={row.best ? "best" : undefined}>
      {name}
      {cells}
    </tr>
  );
}

function AddQuote({ rfq, suppliers }: { rfq: RfqView; suppliers: { id: string; name: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"paste" | "type">("paste");
  const ordered = [...rfq.rows.map((r) => ({ id: r.supplierId, name: r.supplierName })), ...suppliers.filter((s) => !rfq.rows.some((r) => r.supplierId === s.id))];
  const [supplierId, setSupplierId] = useState(ordered[0]?.id ?? "");
  const [text, setText] = useState("");
  const [rate, setRate] = useState("");
  const [incl, setIncl] = useState("");
  const [pending, start] = useTransition();
  if (rfq.status !== "SENT") return null;
  if (!open)
    return (
      <button type="button" className="btn b2 sm" onClick={() => setOpen(true)}>
        + Add quote
      </button>
    );
  const submit = () =>
    start(async () => {
      const r = await addQuoteAction(mode === "paste" ? { rfqId: rfq.id, supplierId, text } : { rfqId: rfq.id, supplierId, rate, inclusions: incl });
      if (!r.ok) return toast(r.error, "⚠️");
      toast(r.outcome === "declined" ? "Saved as declined" : r.outcome === "needs check" ? "Saved · needs a quick check" : "Quote added", "🏨");
      setText("");
      setRate("");
      setIncl("");
      setOpen(false);
      router.refresh();
    });
  return (
    <div className="card pad" style={{ marginTop: 12, background: "var(--lav3, #F6F3FE)" }}>
      <div className="h" style={{ marginBottom: 8 }}>
        <b>Add a quote from email or phone</b>
        <button type="button" className="btn b2 sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="two">
        <div className="fld">
          <label htmlFor="aq-s">Supplier</label>
          <select id="aq-s" className="inp" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {ordered.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label>How</label>
          <div className="chips">
            {(
              [
                ["paste", "Paste their reply"],
                ["type", "Type the rate"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={`pill ${mode === k ? "p-l" : "p-g"}`} style={{ border: 0 }} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === "paste" ? (
        <div className="fld">
          <label htmlFor="aq-t">Their reply</label>
          <textarea id="aq-t" className="inp" rows={3} placeholder="e.g. Rs.2,600/- per night MAP" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      ) : (
        <div className="two">
          <div className="fld">
            <label htmlFor="aq-r">Rate per room per night (₹)</label>
            <input id="aq-r" className="inp" inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="aq-i">Inclusions</label>
            <input id="aq-i" className="inp" placeholder="Breakfast incl." value={incl} onChange={(e) => setIncl(e.target.value)} />
          </div>
        </div>
      )}
      <button type="button" className="btn b1 sm" disabled={pending || !supplierId || (mode === "paste" ? !text.trim() : !rate.trim())} onClick={submit}>
        {pending ? "Saving…" : "Save quote"}
      </button>
    </div>
  );
}

function waitingSentence(rfq: RfqView): string {
  if (!rfq.waiting.length) return "";
  const names = rfq.waiting.map((w) => w.name);
  const who = names.length === 1 ? `${names[0]} hasn't` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} haven't`;
  const first = rfq.waiting.find((w) => w.nudgeIn);
  if (first) return ` ${who} replied, and we'll nudge ${names.length === 1 ? "them" : "them"} in ${first.nudgeIn}.`;
  return ` ${who} replied yet (nudged; marked "no reply" after 24 hours).`;
}

export function QuotesCard({ rfq, recent, suppliers }: { rfq: RfqView | null; recent: { id: string; label: string }[]; suppliers: { id: string; name: string }[] }) {
  const router = useRouter();
  const status = !rfq
    ? "Not sent yet"
    : rfq.status === "BOOKED"
      ? "Booked"
      : rfq.replied === 0
        ? "Waiting for replies…"
        : `${rfq.replied} of ${rfq.rows.length} replied`;
  return (
    <div className="card">
      <div className="pad h" style={{ margin: 0, borderBottom: "1px solid var(--line)", gap: 8, flexWrap: "wrap" }}>
        <h3>Quotes</h3>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 13 }}>
            {status}
          </span>
          {recent.length > 1 && rfq ? (
            <select className="inp" style={{ width: "auto", padding: "4px 8px", fontSize: 12.5 }} aria-label="Rate request" value={rfq.id} onChange={(e) => router.push(`/supplier?rfq=${e.target.value}`, { scroll: false })}>
              {recent.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      </div>
      {rfq ? (
        <>
          <p className="muted" style={{ fontSize: 12.5, padding: "8px 16px 0" }}>
            {rfq.destination} · check-in {rfq.checkInLabel} · {rfq.rooms} rooms × {rfq.nights} nights{rfq.departureCode ? ` · for ${rfq.departureCode}` : ""}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="t sup">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Rate / room / night</th>
                  <th>
                    For {rfq.rooms} rooms × {rfq.nights} nights
                  </th>
                  <th>Replied in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rfq.rows.map((r) => (
                  <Row key={r.recipientId} row={r} rfq={rfq} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="pad">
            {rfq.best ? (
              <div className="save" style={{ display: "block" }}>
                Best quote: <b>{rfq.best.supplierName}</b> at {inr(rfq.best.rate)}.
                {rfq.savings ? (
                  <>
                    {" "}
                    That saves <b>{inr(rfq.savings.total)}</b> on this trip vs your usual rate ({Math.round(rfq.savings.pctBps / 100)}% cheaper).
                  </>
                ) : null}
                {rfq.status === "SENT" ? waitingSentence(rfq) : null}
              </div>
            ) : rfq.status === "SENT" && rfq.waiting.length ? (
              <p className="muted" style={{ fontSize: 13 }}>
                Replies land here as they come in.{waitingSentence(rfq)}
              </p>
            ) : null}
            <div style={{ marginTop: 12 }}>
              <AddQuote rfq={rfq} suppliers={suppliers} />
            </div>
          </div>
        </>
      ) : (
        <p className="pad muted">Send a rate request and the replies appear here, best rate first.</p>
      )}
    </div>
  );
}
