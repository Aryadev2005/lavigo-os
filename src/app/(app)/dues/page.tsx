import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Payments & dues" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="💸"
      heading="Payments and dues"
      srs="PAY-*"
      items={[
        "Aging buckets: not due, 1–7 days late, 8–30 days late",
        "Automatic reminders with UPI links on your schedule",
        "Record manual payments",
      ]}
    />
  );
}
