/**
 * Tickets desk (TKT-1 … TKT-8; demo tickets()). Alert cards, plan chips, options ranked by landed
 * cost, fare trend, preview, booking plan; plan + options sheet at ?edit=new|<planId>.
 */
import { Drawer } from "@/components/bookings/drawer";
import { LiveRefresh } from "@/components/live-refresh";
import { TicketsDesk } from "@/components/tickets/desk";
import { PlanSheet } from "@/components/tickets/plan-sheet";
import { getPlanForm, getTicketsDesk } from "@/server/domain/tickets/queries";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Tickets desk" };
export const dynamic = "force-dynamic";

export default async function Page(props: PageProps<"/tickets">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const edit = first(sp.edit) ?? null;
  const desk = await getTicketsDesk(user.role, first(sp.plan) ?? (edit && edit !== "new" ? edit : null));
  const base = desk.plan ? `/tickets?plan=${desk.plan.id}` : "/tickets";
  const form = edit ? await getPlanForm() : null;
  const editing = edit && edit !== "new" && desk.plan?.id === edit ? desk.plan : null;

  return (
    <div className="wrap">
      <LiveRefresh types={["booking.updated", "payment.received"]} />
      <TicketsDesk desk={desk} role={user.role} base={base} />
      {form && (edit === "new" || editing) ? (
        <Drawer closeHref={base}>
          <PlanSheet key={editing?.id ?? "new"} form={form} plan={editing} closeHref={base} />
        </Drawer>
      ) : null}
    </div>
  );
}
