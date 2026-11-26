"use client";
/**
 * Owner's one-tap decision (DESK-4): Approve ₹suggested · Counter ₹suggested+100 · custom · Decline.
 * Used in the inbox panel and on the mobile /approvals/[id] page. The server re-checks the price;
 * below the floor it answers BELOW_FLOOR_NEEDS_CONFIRMATION and we ask for the second confirmation.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideApprovalAction } from "@/app/(app)/inbox/actions";
import { useToast } from "@/components/shell/toast";
import { inr, paiseFromRupeeInput } from "@/server/money";

type Pending = { action: "APPROVE" | "COUNTER" | "DECLINE"; pricePerPax?: number | null; reason?: string | null };

export function ApprovalActions({ approvalId, suggested, counter, large }: { approvalId: string; suggested: number | null; counter: number | null; large?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "custom" | "decline">("idle");
  const [custom, setCustom] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const size = large ? "" : " sm";
  const block = large ? { width: "100%", padding: "14px 16px", fontSize: 16 } : undefined;

  const decide = (p: Pending, confirmBelowFloor = false) =>
    start(async () => {
      const r = await decideApprovalAction({ approvalId, ...p, confirmBelowFloor });
      if (!r.ok) {
        if (r.reason === "BELOW_FLOOR_NEEDS_CONFIRMATION") return setConfirm(p);
        toast(r.error, "⚠️");
        return;
      }
      setConfirm(null);
      if (r.data.status === "DECLINED") toast("Declined. Staff can see it in the chat.", "🙅");
      else if (r.data.sendError) toast(`Approved, but the quote wasn't sent: ${r.data.sendError}`, "⚠️");
      else toast("Approved. The quote went to the customer.", "✅");
      router.refresh();
    });

  if (confirm) {
    return (
      <div className="acts" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ fontSize: 13.5 }}>
          <b>{inr(confirm.pricePerPax ?? suggested ?? 0)}</b> is below your floor. This is logged. Send it anyway?
        </div>
        <button type="button" className={`btn b1${size}`} style={block} disabled={busy} onClick={() => decide(confirm, true)}>
          {busy ? "Sending…" : "Yes, approve below floor"}
        </button>
        <button type="button" className={`btn b2${size}`} style={block} disabled={busy} onClick={() => setConfirm(null)}>
          Cancel
        </button>
      </div>
    );
  }

  const customPaise = paiseFromRupeeInput(custom);
  return (
    <>
      <div className="acts" style={large ? { flexDirection: "column", alignItems: "stretch" } : undefined}>
        {suggested != null ? (
          <button type="button" className={`btn bok${size}`} style={block} disabled={busy} onClick={() => decide({ action: "APPROVE" })}>
            Approve {inr(suggested)}
          </button>
        ) : null}
        {counter != null ? (
          <button type="button" className={`btn b2${size}`} style={block} disabled={busy} onClick={() => decide({ action: "COUNTER", pricePerPax: counter })}>
            Counter {inr(counter)}
          </button>
        ) : null}
        <button type="button" className={`btn b2${size}`} style={block} disabled={busy} onClick={() => setMode(mode === "custom" ? "idle" : "custom")}>
          Custom price
        </button>
        <button type="button" className={`btn b2${size}`} style={block} disabled={busy} onClick={() => setMode(mode === "decline" ? "idle" : "decline")}>
          Decline
        </button>
      </div>
      {mode === "custom" ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input className="inp" inputMode="numeric" placeholder="₹ per person" aria-label="Custom price per person" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button type="button" className={`btn b1${size}`} disabled={busy || !customPaise} onClick={() => decide({ action: "COUNTER", pricePerPax: customPaise })}>
            Counter
          </button>
        </div>
      ) : null}
      {mode === "decline" ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input className="inp" placeholder="Reason for staff (optional)" aria-label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className={`btn b1${size}`} disabled={busy} onClick={() => decide({ action: "DECLINE", reason: reason || null })}>
            Decline
          </button>
        </div>
      ) : null}
    </>
  );
}
