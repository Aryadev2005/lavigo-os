/**
 * Mobile-first approval page (DESK-3, DESK-4): the owner opens it from the WhatsApp alert or a toast
 * and decides in one tap. OWNER only; the server re-checks every price on decision.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApprovalActions } from "@/components/deals/approval-actions";
import { LiveRefresh } from "@/components/live-refresh";
import { getApprovalForOwner } from "@/server/domain/deals/queries";
import { inr, pct } from "@/server/money";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Approval" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Needs your OK", cls: "p-w" },
  APPROVED: { label: "Approved", cls: "p-ok" },
  COUNTERED: { label: "Countered", cls: "p-ok" },
  DECLINED: { label: "Declined", cls: "p-b" },
  EXPIRED: { label: "Expired", cls: "p-g" },
};

export default async function Page({ params }: PageProps<"/approvals/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  const a = await getApprovalForOwner(id);
  if (!a) notFound();
  const s = STATUS[a.status] ?? { label: a.status, cls: "p-g" };
  const p = a.pricing;

  return (
    <div className="wrap" style={{ maxWidth: 520, margin: "0 auto" }}>
      <LiveRefresh types={["approval.decided"]} />
      <div className="card pad">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <b style={{ fontSize: 18 }}>🤝 {a.customer ?? "Approval"}</b>
          <span className={`pill ${s.cls}`}>{s.label}</span>
        </div>
        <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
          {a.trip ?? "Custom request"}
          {a.pax ? ` · ${a.pax} travellers` : ""} · asked {a.createdAt}
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="kv">
            <span>Customer asks</span>
            <b style={{ color: "var(--bad)" }}>{a.requested != null ? `${inr(a.requested)}/person` : "–"}</b>
          </div>
          {p ? (
            <>
              <div className="kv">
                <span>List · offer price</span>
                <b>
                  {inr(p.listPrice)} · {inr(p.autoOffer)}
                </b>
              </div>
              <div className="kv">
                <span>Your floor ({pct(a.floorMarginBps, 0)} margin)</span>
                <b>{inr(p.floor)}</b>
              </div>
              {p.marginBpsAtAsked != null ? (
                <div className="kv">
                  <span>Margin at the ask</span>
                  <b style={{ color: p.marginBpsAtAsked >= a.floorMarginBps ? "var(--ok)" : "var(--bad)" }}>{pct(p.marginBpsAtAsked)}</b>
                </div>
              ) : null}
            </>
          ) : null}
          {a.suggested != null ? (
            <div className="kv">
              <span>Suggested</span>
              <b>
                {inr(a.suggested)}
                {p?.marginBpsAtSuggested != null ? ` · margin ${pct(p.marginBpsAtSuggested)}` : ""}
              </b>
            </div>
          ) : null}
          {a.suggested != null && a.pax ? (
            <div className="kv">
              <span>Deal value at suggested</span>
              <b>{inr(a.suggested * a.pax)}</b>
            </div>
          ) : null}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>{a.summary}</p>

        {a.status === "PENDING" ? (
          <div style={{ marginTop: 12 }}>
            <ApprovalActions approvalId={a.id} suggested={a.suggested} counter={a.counter} large />
          </div>
        ) : a.decided ? (
          <div className="approval" style={{ borderColor: "var(--line)" }}>
            {a.decided.by} decided {a.decided.at}
            {a.decided.price != null ? ` at ${inr(a.decided.price)}/person` : ""}.
          </div>
        ) : null}

        {a.conversationId ? (
          <Link className="btn b2" href={`/inbox?c=${a.conversationId}`} style={{ width: "100%", marginTop: 12 }}>
            Open the chat
          </Link>
        ) : null}
      </div>
    </div>
  );
}
