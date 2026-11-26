/**
 * Pricing rules (RUL-1 … RUL-4; demo rules() + prev(), re-worded for staff). OWNER only. The live
 * preview runs the same pricing.evaluatePrice as the quote builder, on the Nepal departure for 6.
 */
import { RulesEditor } from "@/components/rules/editor";
import { getRulesView } from "@/server/domain/settings/rules";
import { requireUser } from "@/server/rbac";

export const metadata = { title: "Pricing rules" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await requireUser("OWNER");
  const view = await getRulesView(user);
  return (
    <div className="wrap">
      <RulesEditor key={view.updatedAt} view={view} />
    </div>
  );
}
