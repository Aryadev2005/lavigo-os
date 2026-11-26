import Link from "next/link";
import { initials } from "@/lib/utils";
import type { ConversationRow, InboxTab } from "@/server/domain/conversations/queries";

const TAB_LABEL: Record<InboxTab, string> = { all: "All", needs: "Needs you", paid: "Paid", followup: "Follow-up" };

/** INB-5: tabs, channel badge, last message, time, status pill. */
export function ConversationList({ rows, counts, tab, selectedId }: { rows: ConversationRow[]; counts: Record<InboxTab, number>; tab: InboxTab; selectedId: string | null }) {
  const href = (t: InboxTab, c?: string) => {
    const q = new URLSearchParams();
    if (t !== "all") q.set("tab", t);
    if (c) q.set("c", c);
    const s = q.toString();
    return s ? `/inbox?${s}` : "/inbox";
  };
  return (
    <div className="ilist">
      <div className="tabs" role="tablist">
        {(Object.keys(TAB_LABEL) as InboxTab[]).map((t) => (
          <Link key={t} href={href(t)} role="tab" aria-selected={t === tab} className={`tabbtn${t === tab ? " on" : ""}`}>
            {TAB_LABEL[t]}
            {t === "needs" && counts.needs ? ` ${counts.needs}` : ""}
          </Link>
        ))}
      </div>
      {rows.map((c) => (
        <Link key={c.id} href={href(tab, c.id)} className={`conv${c.id === selectedId ? " on" : ""}`} scroll={false}>
          <div className="av">{initials(c.name)}</div>
          <span className={`ch ${c.channelClass}`} title={c.channel} />
          <div className="x">
            <b>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              <time>{c.time}</time>
            </b>
            <p>{c.preview}</p>
            <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center" }}>
              <span className={`pill ${c.pill.cls}`}>{c.pill.label}</span>
              {c.unread > 0 && c.id !== selectedId ? <span className="unread">{c.unread}</span> : null}
            </div>
          </div>
        </Link>
      ))}
      {rows.length === 0 ? (
        <p className="muted" style={{ padding: 16, fontSize: 13.5 }}>
          Nothing here right now.
        </p>
      ) : null}
    </div>
  );
}
