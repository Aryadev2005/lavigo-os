import Link from "next/link";
import type { NeedItem } from "@/server/domain/dashboard";

const TONE: Record<NeedItem["tone"], string> = {
  lav: "var(--lav2)",
  ok: "var(--okbg)",
  bad: "var(--badbg)",
  warn: "var(--warnbg)",
};

/** TOD-2: computed live; each item deep-links to the screen that resolves it. */
export function NeedsYou({ items }: { items: NeedItem[] }) {
  return (
    <div className="card pad">
      <div className="h">
        <h3>
          Needs you
          {items.length ? (
            <span className="pill p-b" style={{ marginLeft: 6 }}>
              {items.length}
            </span>
          ) : null}
        </h3>
        <span className="muted" style={{ fontSize: 13 }}>
          Everything else is handled
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5, padding: "12px 0" }}>
          Nothing needs you right now ✓
        </p>
      ) : (
        items.map((n) => (
          <div className="need" key={n.key}>
            <div className="ic" style={{ background: TONE[n.tone] }}>
              {n.icon}
            </div>
            <div className="x">
              <b>{n.title}</b>
              <small>{n.detail}</small>
            </div>
            {n.action.href.startsWith("tel:") ? (
              <a className="btn b2 sm" href={n.action.href}>
                {n.action.label}
              </a>
            ) : (
              <Link className={`btn ${n.action.primary ? "b1" : "b2"} sm`} href={n.action.href}>
                {n.action.label}
              </Link>
            )}
          </div>
        ))
      )}
    </div>
  );
}
