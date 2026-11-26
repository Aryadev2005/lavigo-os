"use server";
/** Pricing rules (RUL-1 … RUL-4). OWNER only: requireUser("OWNER") here, assertOwner in the domain. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logger } from "@/server/logger";
import { ForbiddenError } from "@/server/domain/profit";
import { RulesError, saveRules } from "@/server/domain/settings/rules";
import { requireUser } from "@/server/rbac";

export type ActionResult = { ok: true } | { ok: false; error: string };

const offer = z.object({
  kind: z.enum(["GROUP", "EARLY_BIRD", "REPEAT_TRAVELLER"]),
  enabled: z.boolean(),
  amountPerPax: z.number().int().min(0).max(1_000_000),
  minPax: z.number().int().min(2).max(200).nullable(),
  minDaysBeforeTravel: z.number().int().min(1).max(365).nullable(),
});
const rulesInput = z.object({
  floorMarginBps: z.number().int(),
  soloDiscountPerPax: z.number().int(),
  stackOffers: z.boolean(),
  escalateGroupSizeAtLeast: z.number().int(),
  offers: z.array(offer).max(3),
});

export async function saveRulesAction(raw: z.input<typeof rulesInput>): Promise<ActionResult> {
  const user = await requireUser("OWNER");
  try {
    await saveRules(rulesInput.parse(raw), { id: user.id, role: user.role });
    revalidatePath("/rules");
    revalidatePath("/inbox");
    return { ok: true };
  } catch (err) {
    if (err instanceof RulesError) return { ok: false, error: err.message };
    if (err instanceof ForbiddenError) return { ok: false, error: "Only the owner can change pricing rules" };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the details" };
    logger.error({ err }, "rules save failed");
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
