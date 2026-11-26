import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Today" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="☀️"
      heading="Your day at a glance"
      srs="TOD-*"
      items={[
        "KPIs: collected this month, balance to collect, enquiries today, profit booked",
        "Needs you: approvals, late payments, supplier quotes, fares and empty seats",
        "Live activity feed and the 6-month collections chart",
        "Upcoming departures with seats sold",
      ]}
    />
  );
}
