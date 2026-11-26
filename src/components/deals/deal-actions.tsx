"use client";
/** Payment link (DESK-5) and follow-up (DESK-7) buttons, shared by the panel and the thread's deal bar. */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { sendFollowUpAction, sendPaymentLinkAction } from "@/app/(app)/inbox/actions";
import { useToast } from "@/components/shell/toast";
import { useEvents } from "@/components/use-events";
import { inr } from "@/server/money";

/**
 * "Send payment link": the worker holds seats and calls Razorpay, so the button shows a pending
 * state until the link card arrives over SSE (the page re-renders with link = "sent").
 */
export function PaymentLinkButton(props: { conversationId: string; quoteId: string; link: "none" | "sent" | "paid"; advance: number; block?: boolean }) {
  const { quoteId, link, advance, block } = props;
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // The worker answers with a message in this chat: the link card (→ "Link sent" after the refresh)
  // or a note saying why not (seats gone). Either way, stop showing "pending" once the page caught up.
  useEvents((e) => {
    if (e.type !== "message.created" || e.payload.conversationId !== props.conversationId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPending(false), 2000);
  }, ["message.created"]);
  const style = block ? { width: "100%" } : undefined;
  if (link === "paid") return <span className="pill p-ok">Paid ✓</span>;
  if (link === "sent") return <span className="pill p-l">Link sent ✓</span>;
  if (pending) {
    return (
      <button type="button" className="btn b2 sm" style={style} disabled>
        ⏳ Holding seats, creating link…
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn b1 sm"
      style={style}
      disabled={busy}
      onClick={() =>
        start(async () => {
          const r = await sendPaymentLinkAction({ quoteId });
          if (!r.ok) return toast(r.error, "⚠️");
          setPending(true);
        })
      }
    >
      💳 Send payment link · {inr(advance)}
    </button>
  );
}

export function FollowUpButton({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, start] = useTransition();
  return (
    <button
      type="button"
      className="btn b3 sm"
      disabled={busy}
      onClick={() =>
        start(async () => {
          const r = await sendFollowUpAction(conversationId);
          if (!r.ok) return toast(r.error, "⚠️");
          toast(r.data.via === "text" ? "Follow-up sent" : "Follow-up template sent", "🔁");
          router.refresh();
        })
      }
    >
      🔁 Send follow-up
    </button>
  );
}
