import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Profit" };

export default async function Page() {
  await requireUser("OWNER");
  return (
    <Placeholder
      icon="📈"
      heading="Profit by trip"
      srs="PRF-*"
      items={[
        "Revenue, cost and margin for every departure and custom trip",
        "Uses actual supplier bills when they exist, planned cost otherwise",
      ]}
    />
  );
}
