import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Departures" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="🚌"
      heading="Fixed-date departures"
      srs="DEP-*"
      items={[
        "Seats sold, travellers and documents per departure",
        "Fill seats: targeted campaigns to past travellers, enquiries and the waitlist",
      ]}
    />
  );
}
