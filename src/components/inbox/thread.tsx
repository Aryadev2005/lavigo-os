"use client";
/** INB-6: WhatsApp-style thread. Re-rendered from the server on SSE events; scrolls to the newest message. */
import Link from "next/link";
import { useEffect, useRef } from "react";
import { markReadAction } from "@/app/(app)/inbox/actions";
import { initials } from "@/lib/utils";
import type { Card, ThreadMessage, ThreadView } from "@/server/domain/conversations/queries";
import { inr } from "@/server/money";
import { FollowUpButton, PaymentLinkButton } from "@/components/deals/deal-actions";
import type { DealPanel } from "@/server/domain/deals/queries";
import { Composer, type ComposerDeparture, type ComposerTemplate } from "./composer";

function Ticks({ status, error }: { status: string; error: string | null }) {
  switch (status) {
    case "QUEUED":
      return <span className="tk" title="Sending">🕓</span>;
    case "SENT":
      return <span className="tk" title="Sent">✓</span>;
    case "DELIVERED":
      return <span className="tk" title="Delivered">✓✓</span>;
    case "READ":
      return <span className="tk read" title="Read">✓✓</span>;
    case "FAILED":
    case "BLOCKED":
      return <span className="tk bad" title={error ?? "Not sent"}>⚠ Not sent</span>;
    default:
      return null;
  }
}

/** A document's caption: outbound bodies are "📎 file.pdf\ncaption"; inbound "📷 …" placeholders have none. */
function caption(body: string): string {
  if (body.startsWith("📎")) return body.split("\n").slice(1).join("\n").trim();
  return body.startsWith("📷") ? "" : body;
}

function CardView({ card, body }: { card: Card; body: string }) {
  if (card.type === "quote") {
    const off = card.discounts.reduce((s, d) => s + d.amountPerPax, 0);
    return (
      <div className="qcard">
        <div className="qh">🧾 {card.title}</div>
        <div className="qb">
          <div>
            <span>List price × {card.pax}</span>
            <span>{inr(card.listPricePerPax * card.pax)}</span>
          </div>
          {card.discounts.map((d) => (
            <div key={d.label} style={{ color: "var(--ok)" }}>
              <span>{d.label}</span>
              <span>−{inr(d.amountPerPax * card.pax)}</span>
            </div>
          ))}
          {off ? (
            <div>
              <span>Your price per person</span>
              <span>{inr(card.pricePerPax)}</span>
            </div>
          ) : null}
          <div className="tt">
            <span>Total</span>
            <span>{inr(card.totalAmount)}</span>
          </div>
          {card.seatsLeft !== null ? <small className="muted">{card.seatsLeft} seats left</small> : null}
        </div>
      </div>
    );
  }
  if (card.type === "link") {
    return (
      <div className="qcard">
        <div className="qh">💳 Payment link · {inr(card.amount)}</div>
        <div className="qb" style={{ whiteSpace: "pre-wrap" }}>{body}</div>
        {card.url ? (
          <a className="qbtn" href={card.url} target="_blank" rel="noreferrer">
            {card.label} {inr(card.amount)}
          </a>
        ) : null}
      </div>
    );
  }
  if (card.type === "file") {
    return (
      <div>
        {card.documentId ? (
          <a href={`/api/files/${card.documentId}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
            {card.mime?.startsWith("image/") ? "🖼" : "📎"} {card.fileName}
          </a>
        ) : (
          <span>📎 {card.fileName}</span>
        )}
        {card.error ? <div className="muted" style={{ fontSize: 12 }}>Couldn&apos;t download: {card.error}</div> : null}
        {caption(body) ? <div className="body">{caption(body)}</div> : null}
      </div>
    );
  }
  return (
    <>
      <div className="muted" style={{ fontSize: 10.5, marginBottom: 2 }}>Template · {card.name}</div>
      <div className="body">{body}</div>
    </>
  );
}

function Bubble({ m }: { m: ThreadMessage }) {
  if (m.side === "sys") return <div className="m sys">{m.body}</div>;
  return (
    <div className={`m ${m.side}`}>
      {m.tag ? <div className="tag">{m.tag}</div> : null}
      {m.card ? <CardView card={m.card} body={m.body} /> : <div className="body">{m.body}</div>}
      <time>
        {m.time} {m.side === "a" ? <Ticks status={m.status} error={m.error} /> : null}
      </time>
    </div>
  );
}

export function Thread({
  thread,
  departures,
  templates,
  hideHeaderLinks,
  deal,
}: {
  thread: ThreadView;
  departures: ComposerDeparture[];
  templates: ComposerTemplate[];
  hideHeaderLinks?: boolean;
  /** Deal state for the bar above the composer (visible on narrow screens where the panel hides). */
  deal?: DealPanel | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = thread.lastMessageId;

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.id, last]);

  // Viewing the chat reads it (also when a new message lands while it's open).
  useEffect(() => {
    if (thread.unread > 0) void markReadAction(thread.id);
  }, [thread.id, thread.unread, last]);

  const sub = [thread.channelLabel, thread.contact, thread.sourceNote].filter(Boolean).join(" · ");
  return (
    <div className="thread">
      <div className="thead">
        <div className="av">{initials(thread.customer.name)}</div>
        <div className="x" style={{ minWidth: 0 }}>
          <b>{thread.customer.name}</b>
          <small>{sub}</small>
        </div>
        <div className="r">
          <span className={`pill ${thread.pill.cls}`}>{thread.pill.label}</span>
          {!hideHeaderLinks && thread.customer.bookings > 0 ? (
            <Link className="btn b2 sm" href={`/bookings?customer=${thread.customer.id}`}>
              Bookings ({thread.customer.bookings})
            </Link>
          ) : null}
        </div>
      </div>
      <div className="msgs" ref={ref}>
        {thread.messages.length === 0 ? (
          <div className="m sys">No messages yet. {thread.window.open ? "Say hello 👋" : "Start with an approved template below."}</div>
        ) : (
          thread.messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>
      {deal && (deal.approval || (deal.quote?.valid && deal.quote.link !== "paid") || deal.followUpDue) ? (
        <div className="dealbar">
          {deal.approval ? (
            <span className="pill p-w">🤝 {deal.role === "OWNER" ? "Needs your OK (see panel)" : "Waiting for owner"}</span>
          ) : deal.quote?.valid ? (
            <>
              <span className="muted">
                Quote {inr(deal.quote.totalAmount)} · valid till {deal.quote.validUntil}
              </span>
              <PaymentLinkButton key={deal.quote.id} conversationId={thread.id} quoteId={deal.quote.id} link={deal.quote.link} advance={deal.quote.advance} />
            </>
          ) : null}
          {deal.followUpDue ? <FollowUpButton conversationId={thread.id} /> : null}
        </div>
      ) : null}
      <Composer
        key={thread.id}
        conversationId={thread.id}
        channel={thread.channel}
        window={thread.window}
        firstName={thread.customer.firstName}
        tripLabel={thread.lead.tripLabel}
        departureCode={thread.lead.departureCode}
        pax={thread.lead.pax}
        departures={departures}
        templates={templates}
      />
    </div>
  );
}
