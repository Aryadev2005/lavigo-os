"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createSandboxAction, sandboxSayAction } from "@/app/(app)/sandbox/actions";
import { useToast } from "@/components/shell/toast";
import { initials } from "@/lib/utils";
import type { ThreadMessage } from "@/server/domain/conversations/queries";
import { inr } from "@/server/money";

export function SandboxPicker({ conversations, selectedId }: { conversations: { id: string; name: string; phone: string | null }[]; selectedId: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="card pad" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div className="fld" style={{ margin: 0, flex: "1 1 220px" }}>
        <label htmlFor="sbx-pick">Sandbox customer</label>
        <select id="sbx-pick" className="inp" value={selectedId ?? ""} onChange={(e) => router.push(`/sandbox?c=${e.target.value}`)}>
          {conversations.length === 0 ? <option value="">None yet</option> : null}
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ""}
            </option>
          ))}
        </select>
      </div>
      <form
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", flex: "2 1 420px" }}
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await createSandboxAction(name, phone);
            if (!r.ok) return toast(r.error, "⚠️");
            setName("");
            setPhone("");
            router.push(`/sandbox?c=${r.conversationId}`);
          });
        }}
      >
        <div className="fld" style={{ margin: 0, flex: "1 1 160px" }}>
          <label htmlFor="sbx-name">New customer name</label>
          <input id="sbx-name" className="inp" placeholder="Riya Sinha" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="fld" style={{ margin: 0, flex: "1 1 150px" }}>
          <label htmlFor="sbx-phone">Phone (optional)</label>
          <input id="sbx-phone" className="inp" inputMode="tel" placeholder="98350 11223" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <button type="submit" className="btn b1 sm" disabled={pending || name.trim().length < 2}>
          + New sandbox chat
        </button>
      </form>
      <small className="muted" style={{ flexBasis: "100%" }}>
        Nothing is sent to WhatsApp from here. Use a real customer&apos;s phone to attach the chat to their bookings.
        {" "}
        <Link href="/inbox">Go to the inbox →</Link>
      </small>
    </div>
  );
}

/** The customer's phone: their own messages on the right, the business's on the left. */
export function SandboxPhone({ conversationId, name, messages }: { conversationId: string; name: string; messages: ThreadMessage[] }) {
  const toast = useToast();
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const visible = messages.filter((m) => m.side !== "sys" && m.status !== "BLOCKED" && m.status !== "FAILED" && m.status !== "QUEUED");
  const lastId = visible.at(-1)?.id;
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lastId]);

  const say = () => {
    const body = text.trim();
    if (!body || pending) return;
    start(async () => {
      const r = await sandboxSayAction(conversationId, body);
      if (!r.ok) return toast(r.error, "⚠️");
      setText("");
      router.refresh();
    });
  };

  return (
    <div className="phone">
      <div className="thead">
        <div className="av" style={{ background: "#fff" }}>{initials("Lavigo Travel")}</div>
        <div className="x">
          <b>Lavigo Travel Co.</b>
          <small>You are chatting as {name}</small>
        </div>
      </div>
      <div className="msgs" ref={ref}>
        {visible.length === 0 ? <div className="m sys">Type below as the customer, e.g. &ldquo;Nepal trip ka kya rate hai?&rdquo;</div> : null}
        {visible.map((m) => (
          <div key={m.id} className={`m ${m.side === "c" ? "a" : "c"}`}>
            {m.card?.type === "link" ? (
              <>
                <div className="body">{m.body}</div>
                {m.card.url ? (
                  <a className="qbtn" href={m.card.url} target="_blank" rel="noreferrer" style={{ display: "block", marginTop: 6, color: "#0B7DDA", fontWeight: 600 }}>
                    Pay {inr(m.card.amount)}
                  </a>
                ) : null}
              </>
            ) : m.card?.type === "quote" ? (
              <div className="qcard">
                <div className="qh">🧾 {m.card.title}</div>
                <div className="qb">
                  <div className="tt">
                    <span>Total for {m.card.pax}</span>
                    <span>{inr(m.card.totalAmount)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="body">{m.body}</div>
            )}
            <time>{m.time}</time>
          </div>
        ))}
      </div>
      <div className="compose">
        <textarea
          rows={1}
          placeholder={`Message as ${name.split(" ")[0]}`}
          aria-label="Message as the customer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              say();
            }
          }}
        />
        <button type="button" className="ib2" aria-label="Send as customer" disabled={pending || !text.trim()} onClick={say}>
          ➤
        </button>
      </div>
    </div>
  );
}
