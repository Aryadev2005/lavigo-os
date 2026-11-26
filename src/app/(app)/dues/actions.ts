"use server";
/** Payments & dues mutations (PAY-5, PAY-6). */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { clientIp } from "@/server/auth";
import { remindAllLate, setReminderRule } from "@/server/domain/dues";
import { requireUser } from "@/server/rbac";

/** Reminder rules are configuration: owner only (staff see them read-only). Audited. */
export async function toggleReminderRuleAction(key: string, enabled: boolean) {
  const user = await requireUser("OWNER");
  const k = z.enum(["before_7d", "on_due", "late_3d", "late_7d", "seat_release"]).parse(key);
  await setReminderRule(k, z.boolean().parse(enabled), { id: user.id, role: user.role }, clientIp(await headers()));
  revalidatePath("/dues");
  revalidatePath("/today");
  return { ok: true as const };
}

export async function remindAllLateAction() {
  const user = await requireUser();
  const r = await remindAllLate({ id: user.id, role: user.role });
  return { ok: true as const, queued: r.queued };
}
