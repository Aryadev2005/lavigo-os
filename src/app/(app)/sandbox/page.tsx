/**
 * Sandbox (INB-3): play the customer on the left; the real inbox thread (same data, same composer)
 * on the right. Messages go through ingestInbound and the outbound queue exactly like WhatsApp's.
 */
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { Thread } from "@/components/inbox/thread";
import { SandboxPhone, SandboxPicker } from "@/components/sandbox/sandbox";
import { listSandboxConversations } from "@/server/domain/conversations";
import { getThread, listOpenDepartures, listSendableTemplates } from "@/server/domain/conversations/queries";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Sandbox" };
export const dynamic = "force-dynamic";

export default async function Page(props: PageProps<"/sandbox">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const conversations = await listSandboxConversations();
  const selected = (Array.isArray(sp.c) ? sp.c[0] : sp.c) ?? conversations[0]?.id;
  const thread = selected ? await getThread(selected, user.id) : null;
  const [departures, templates] = await Promise.all([listOpenDepartures(), thread ? listSendableTemplates(thread.customer.marketingOptIn) : []]);

  return (
    <div className="wrap">
      <LiveRefresh types={["message.created", "message.updated", "conversation.updated"]} />
      <SandboxPicker conversations={conversations} selectedId={thread?.id ?? null} />
      <div className="sbx" style={{ marginTop: 14 }}>
        {thread ? (
          <>
            <SandboxPhone conversationId={thread.id} name={thread.customer.name} messages={thread.messages} />
            <div className="card" style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div className="pad h" style={{ margin: 0, padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
                <b style={{ fontSize: 14 }}>What your team sees in the inbox</b>
                <Link className="btn b2 sm" href={`/inbox?c=${thread.id}`}>
                  Open in inbox
                </Link>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
                  <Thread thread={thread} departures={departures} templates={templates} hideHeaderLinks />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="card pad muted" style={{ gridColumn: "1 / -1", fontSize: 14 }}>
            Create a sandbox customer above, then chat as them. Their messages land in the inbox exactly like WhatsApp messages.
          </div>
        )}
      </div>
    </div>
  );
}
