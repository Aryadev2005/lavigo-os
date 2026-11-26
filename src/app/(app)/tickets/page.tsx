import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Tickets desk" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="🎫"
      heading="Travel options"
      srs="TKT-*"
      items={[
        "Options ranked by real landed cost against the travel budget",
        "Fare trend alerts and train booking-window reminders",
        "PNR groups of up to 6 passengers",
      ]}
    />
  );
}
