import { Placeholder } from "@/components/shell/placeholder";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Approval" };

export default async function Page({ params }: PageProps<"/approvals/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  return (
    <Placeholder
      icon="🤝"
      heading={`Approval ${id.slice(0, 8)}`}
      srs="DESK-*"
      items={[
        "Mobile-first page the owner opens from the WhatsApp alert",
        "Approve, counter or decline in one tap; the server re-checks the price",
      ]}
    />
  );
}
