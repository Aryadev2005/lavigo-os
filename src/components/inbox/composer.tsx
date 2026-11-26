"use client";
/**
 * INB-7 / INB-11 composer: Enter to send (Shift+Enter = new line), quick-insert of departure info,
 * attachments. Outside the 24h window free text is replaced by an approved-template picker.
 * The server enforces the same rules; this only offers the right controls.
 */
import type { Channel } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { departureSnippetAction, sendAttachmentAction, sendTemplateAction, sendTextAction } from "@/app/(app)/inbox/actions";
import { QuoteBuilder } from "@/components/deals/quote-builder";
import { useToast } from "@/components/shell/toast";

export type ComposerDeparture = { id: string; code: string; label: string };
export type ComposerTemplate = { name: string; purpose: string; bodyPreview: string; variables: string[] };

const VAR_LABEL: Record<string, string> = {
  name: "Customer name",
  trip: "Trip",
  amount: "Amount",
  due_date: "Due date",
  pay_link: "Payment link",
  booking_code: "Booking code",
  days_late: "Days late",
  date: "Date",
};

function fill(t: ComposerTemplate, vars: Record<string, string>) {
  return t.bodyPreview.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[t.variables[Number(n) - 1] ?? ""] || `[${t.variables[Number(n) - 1]}]`);
}

export function Composer(props: {
  conversationId: string;
  channel: Channel;
  window: { open: boolean; closesAt: string | null; neverWrote: boolean };
  firstName: string;
  tripLabel: string | null;
  departureCode: string | null;
  pax: number | null;
  departures: ComposerDeparture[];
  templates: ComposerTemplate[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [quick, setQuick] = useState(false);
  const [builder, setBuilder] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const [tplName, setTplName] = useState("");
  const [vars, setVars] = useState<Record<string, string>>({});
  const tpl = props.templates.find((t) => t.name === tplName);

  const after = (r: { ok: true } | { ok: false; error: string }) => {
    if (!r.ok) {
      toast(r.error, "⚠️");
      return false;
    }
    router.refresh();
    return true;
  };

  const sendText = () => {
    const body = text.trim();
    if (!body || pending) return;
    start(async () => {
      if (after(await sendTextAction(props.conversationId, body))) setText("");
    });
  };

  const attach = (file: File) => {
    const form = new FormData();
    form.set("conversationId", props.conversationId);
    form.set("file", file);
    if (text.trim()) form.set("caption", text.trim());
    start(async () => {
      if (after(await sendAttachmentAction(form))) setText("");
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  const insertDeparture = (departureId: string) => {
    setQuick(false);
    start(async () => {
      const snippet = await departureSnippetAction(departureId);
      if (!snippet) return;
      setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${snippet}` : snippet));
      taRef.current?.focus();
    });
  };

  const pickTemplate = (name: string) => {
    setTplName(name);
    const t = props.templates.find((x) => x.name === name);
    if (!t) return;
    const trip = props.tripLabel?.split(" · ")[0] ?? "";
    setVars(Object.fromEntries(t.variables.map((v) => [v, v === "name" ? props.firstName : v === "trip" ? trip : ""])));
  };

  // ── Window closed: templates only (INB-11).
  if (!props.window.open) {
    if (props.channel === "INSTAGRAM") {
      return (
        <div className="wclosed">
          Instagram only allows replies within 24 hours of the customer&apos;s last message. You can reply as soon as they write again.
        </div>
      );
    }
    return (
      <div className="wclosed">
        <b>{props.window.neverWrote ? "This customer hasn't messaged you yet." : "The 24-hour window is closed."}</b> WhatsApp only allows approved templates
        until the customer writes again.
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select className="inp" style={{ flex: "1 1 200px" }} value={tplName} onChange={(e) => pickTemplate(e.target.value)} aria-label="Template">
            <option value="">Choose a template…</option>
            {props.templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        {tpl ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 6, marginTop: 8 }}>
              {tpl.variables.map((v) => (
                <input
                  key={v}
                  className="inp"
                  placeholder={VAR_LABEL[v] ?? v.replace(/_/g, " ")}
                  aria-label={VAR_LABEL[v] ?? v}
                  value={vars[v] ?? ""}
                  onChange={(e) => setVars((x) => ({ ...x, [v]: e.target.value }))}
                />
              ))}
            </div>
            <div className="m a" style={{ maxWidth: "100%", marginTop: 8, animation: "none" }}>
              <div className="body">{fill(tpl, vars)}</div>
            </div>
            <button
              type="button"
              className="btn b1 sm"
              style={{ marginTop: 8 }}
              disabled={pending || tpl.variables.some((v) => !vars[v]?.trim())}
              onClick={() =>
                start(async () => {
                  if (after(await sendTemplateAction(props.conversationId, tpl.name, vars))) setTplName("");
                })
              }
            >
              {pending ? "Sending…" : "Send template"}
            </button>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {builder ? (
        <QuoteBuilder
          conversationId={props.conversationId}
          departures={props.departures}
          defaultCode={props.departures.some((d) => d.code === props.departureCode) ? props.departureCode : null}
          defaultPax={props.pax}
          onClose={() => setBuilder(false)}
        />
      ) : null}
      {quick ? (
        <div className="qpop">
          <b style={{ fontSize: 13 }}>Insert trip details</b>
          <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
            Itinerary, inclusions and the list price from your catalogue. You can edit it before sending.
          </p>
          <div style={{ maxHeight: 220, overflow: "auto" }}>
            {props.departures.map((d) => (
              <button key={d.id} type="button" className="btn b2 sm" style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 4 }} onClick={() => insertDeparture(d.id)}>
                {d.label}
              </button>
            ))}
            {props.departures.length === 0 ? <span className="muted">No open departures.</span> : null}
          </div>
        </div>
      ) : null}
      <div className="compose">
        <button type="button" className="ib2" title="Insert trip details" aria-label="Insert trip details" onClick={() => {
            setQuick((q) => !q);
            setBuilder(false);
          }}>
          🧳
        </button>
        <button type="button" className="ib2" title="Build a quote" aria-label="Build a quote" onClick={() => {
            setBuilder((b) => !b);
            setQuick(false);
          }}>
          🧾
        </button>
        <button type="button" className="ib2" title="Attach a photo or PDF" aria-label="Attach a photo or PDF" disabled={pending} onClick={() => fileRef.current?.click()}>
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attach(f);
          }}
        />
        <textarea
          ref={taRef}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder="Type a reply"
          title="Enter to send, Shift+Enter for a new line"
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendText();
            }
          }}
        />
        <button type="button" className="ib2" aria-label="Send" title="Send" disabled={pending || !text.trim()} onClick={sendText}>
          ➤
        </button>
      </div>
    </div>
  );
}
