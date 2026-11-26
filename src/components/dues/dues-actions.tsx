"use client";
import { useState, useTransition } from "react";
import { remindAllLateAction, toggleReminderRuleAction } from "@/app/(app)/dues/actions";
import { sendLinkAction } from "@/app/(app)/bookings/actions";
import { useToast } from "@/components/shell/toast";

export function SendLinkButton({ bookingId, customerName }: { bookingId: string; customerName: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  return (
    <button
      type="button"
      className="btn b2 sm"
      disabled={pending || sent}
      onClick={() =>
        start(async () => {
          const r = await sendLinkAction(bookingId);
          if (r.ok) {
            setSent(true);
            toast(`UPI link sent to ${customerName} on WhatsApp`, "💬");
          } else toast(r.error, "⚠️");
        })
      }
    >
      {sent ? "Sent ✓" : "Send link"}
    </button>
  );
}

export function RemindAllButton({ lateCount }: { lateCount: number }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn b1 sm"
      disabled={pending || done || lateCount === 0}
      onClick={() =>
        start(async () => {
          const r = await remindAllLateAction();
          setDone(true);
          toast(`Reminders with UPI links sent to ${r.queued} customer${r.queued === 1 ? "" : "s"}`, "💬");
        })
      }
    >
      {done ? "Reminded ✓" : "Remind everyone late"}
    </button>
  );
}

export function RuleToggle({ ruleKey, name, enabled, canEdit }: { ruleKey: string; name: string; enabled: boolean; canEdit: boolean }) {
  const toast = useToast();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  return (
    <label className="sw" title={canEdit ? undefined : "Only the owner can change reminder rules"}>
      <input
        type="checkbox"
        checked={on}
        disabled={!canEdit || pending}
        aria-label={name}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          start(async () => {
            try {
              await toggleReminderRuleAction(ruleKey, next);
              toast(next ? "Turned on" : "Turned off");
            } catch {
              setOn(!next);
              toast("Couldn't save that change", "⚠️");
            }
          });
        }}
      />
      <span />
    </label>
  );
}
