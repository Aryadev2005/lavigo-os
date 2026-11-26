import type { ReminderPreview } from "@/server/domain/dues";

/** PAY-7: the payment_reminder template rendered with the most-late customer's real data. */
export function ReminderPreviewBubble({ preview }: { preview: NonNullable<ReminderPreview> }) {
  // Emphasise amounts and underline links, like the demo bubble.
  const parts = preview.body.split(/(₹[\d,]+(?:\.\d{2})?|https?:\/\/\S+)/g);
  return (
    <div className="m a" style={{ maxWidth: "100%", marginTop: 12, animation: "none" }}>
      <div className="tag" style={{ display: "block", marginBottom: 4 }}>⚙️ Lavigo · automatic reminder</div>
      {parts.map((p, i) =>
        p.startsWith("₹") ? (
          <b key={i}>{p}</b>
        ) : /^https?:\/\//.test(p) ? (
          <u key={i}>{p.replace(/^https?:\/\//, "")}</u>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
      <time>✓✓</time>
    </div>
  );
}
