import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Bookings" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="🧾"
      heading="All bookings"
      srs="BKG-*"
      items={[
        "Every booking with paid, balance and source",
        "Booking drawer: travellers, payments, documents and timeline",
      ]}
    />
  );
}
