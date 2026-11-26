/**
 * Supplier desk (SUP-1 … SUP-8; demo supplier()). New rate request on the left, live quotes on
 * the right (re-rendered on rfq.updated over SSE), supplier directory in a sheet (?suppliers=1).
 */
import Link from "next/link";
import { Drawer } from "@/components/bookings/drawer";
import { LiveRefresh } from "@/components/live-refresh";
import { SupplierDirectory } from "@/components/supplier/directory";
import { QuotesCard } from "@/components/supplier/quotes";
import { RfqForm } from "@/components/supplier/rfq-form";
import { getRfqForm, getRfqView, listRecentRfqs, listSuppliers } from "@/server/domain/suppliers/queries";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Supplier desk" };
export const dynamic = "force-dynamic";

export default async function Page(props: PageProps<"/supplier">) {
  await requireUser();
  const sp = await props.searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const [form, recent, suppliers] = await Promise.all([getRfqForm(), listRecentRfqs(), listSuppliers()]);
  const rfqId = first(sp.rfq) ?? recent[0]?.id ?? null;
  const rfq = rfqId ? await getRfqView(rfqId) : null;
  const base = rfq ? `/supplier?rfq=${rfq.id}` : "/supplier";
  const showDirectory = first(sp.suppliers) === "1";
  const active = suppliers.filter((s) => s.active);

  return (
    <div className="wrap">
      <LiveRefresh types={["rfq.updated"]} />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <Link className="btn b2 sm" href={`${base}${base.includes("?") ? "&" : "?"}suppliers=1`} scroll={false}>
          🏨 Suppliers ({active.length})
        </Link>
      </div>
      <div className="rfq">
        <RfqForm form={form} />
        <QuotesCard rfq={rfq} recent={recent} suppliers={active.map((s) => ({ id: s.id, name: s.name }))} />
      </div>
      {showDirectory ? (
        <Drawer closeHref={base}>
          <SupplierDirectory suppliers={suppliers} closeHref={base} />
        </Drawer>
      ) : null}
    </div>
  );
}
