/** Shared inbox (SRS §4.4, INB-5…INB-11). Layout and copy from the demo's inbox(); staff-operated in v1. */
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { ConversationList } from "@/components/inbox/conversation-list";
import { DealPanelView } from "@/components/deals/deal-panel";
import { LeadPanel } from "@/components/inbox/lead-panel";
import { Thread } from "@/components/inbox/thread";
import { listConversations, getThread, listOpenDepartures, listSendableTemplates, type InboxTab } from "@/server/domain/conversations/queries";
import { getDealPanel } from "@/server/domain/deals/queries";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const TABS: InboxTab[] = ["all", "needs", "paid", "followup"];

export default async function Page(props: PageProps<"/inbox">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = (TABS.includes(one(sp.tab) as InboxTab) ? one(sp.tab) : "all") as InboxTab;

  const { rows, counts } = await listConversations(tab);
  const selectedId = one(sp.c) ?? rows[0]?.id;
  const [thread, departures] = await Promise.all([selectedId ? getThread(selectedId, user.id) : Promise.resolve(null), listOpenDepartures()]);
  const [templates, deal] = thread
    ? await Promise.all([listSendableTemplates(thread.customer.marketingOptIn), getDealPanel(thread.id, user.role)])
    : [[], null];

  return (
    <div className="inbox">
      <LiveRefresh types={["message.created", "message.updated", "conversation.updated", "approval.created", "approval.decided", "booking.updated"]} />
      <ConversationList rows={rows} counts={counts} tab={tab} selectedId={thread?.id ?? null} />
      {thread ? (
        <Thread thread={thread} departures={departures} templates={templates} deal={deal} />
      ) : (
        <div className="thread" style={{ display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 14 }}>
          <div style={{ textAlign: "center" }}>
            No conversations yet.
            <br />
            <Link href="/sandbox" className="btn b2 sm" style={{ marginTop: 10 }}>
              Try the sandbox
            </Link>
          </div>
        </div>
      )}
      <div className="ipanel">
        {thread ? (
          <>
            <LeadPanel key={thread.id} conversationId={thread.id} lead={thread.lead} departures={departures} channelLabel={thread.channelLabel} />
            {deal ? <DealPanelView panel={deal} conversationId={thread.id} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
