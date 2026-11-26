import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Supplier desk" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="🏨"
      heading="Rate requests"
      srs="SUP-*"
      items={[
        "One rate request to many hotels and agents",
        "Replies parsed and compared side by side, best rate highlighted",
      ]}
    />
  );
}
