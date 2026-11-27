/** Inbox skeleton: conversation list, thread bubbles, lead panel (mirrors the .inbox grid). */
import { Skel } from "@/components/shell/skeleton";

export default function Loading() {
  return (
    <div className="inbox" aria-busy="true" aria-label="Loading inbox">
      <div className="ilist">
        <div className="tabs">
          {[48, 72, 44, 70].map((w, i) => (
            <Skel key={i} w={w} h={24} r={99} />
          ))}
        </div>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} style={{ display: "flex", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
            <Skel w={38} h={38} r={99} />
            <div style={{ flex: 1 }}>
              <Skel w="55%" h={12} />
              <Skel w="85%" h={10} style={{ marginTop: 7 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="thread" style={{ padding: 18, gap: 12 }}>
        {[["58%", "start"], ["44%", "end"], ["66%", "start"], ["38%", "end"], ["52%", "start"]].map(([w, side], i) => (
          <Skel key={i} w={w} h={i % 2 ? 40 : 54} r={12} style={{ alignSelf: side === "end" ? "flex-end" : "flex-start", opacity: 0.9 }} />
        ))}
      </div>
      <div className="card pad" style={{ borderRadius: 0, borderTop: 0, borderBottom: 0 }}>
        <Skel w="60%" h={16} style={{ marginBottom: 14 }} />
        {[0, 1, 2, 3].map((i) => (
          <Skel key={i} w={`${90 - i * 12}%`} h={12} style={{ marginBottom: 12 }} />
        ))}
        <Skel w="100%" h={120} r={14} style={{ marginTop: 10 }} />
      </div>
    </div>
  );
}
