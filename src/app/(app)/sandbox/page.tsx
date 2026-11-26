import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Sandbox" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="🧪"
      heading="Customer simulator"
      srs="INB-*"
      items={[
        "Chat as a customer to try quotes and payment links without WhatsApp",
      ]}
    />
  );
}
