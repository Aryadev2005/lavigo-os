import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Pricing rules" };

export default async function Page() {
  await requireUser("OWNER");
  return (
    <Placeholder
      icon="🎚️"
      heading="Your pricing limits"
      srs="RUL-*, PRC-*"
      items={[
        "Minimum margin and the extra discount staff can give without asking",
        "Group, early-bird and repeat-traveller offers",
        "Live preview of the staff limit and your floor price",
      ]}
    />
  );
}
