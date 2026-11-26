import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Inbox" };

export default async function Page() {
  await requireUser();
  return (
    <Placeholder
      icon="💬"
      heading="Shared inbox"
      srs="INB-*, DESK-*"
      items={[
        "WhatsApp, Instagram and Sandbox chats in one list",
        "Quote cards and payment links from the composer, priced by your rules",
        "Ask the owner with one tap when a price is outside the staff limit",
      ]}
    />
  );
}
