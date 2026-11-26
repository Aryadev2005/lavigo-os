"use server";
/** Sandbox (INB-3): staff play the customer; messages go through ingestInbound like WhatsApp's. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSandboxConversation, sandboxCustomerSays } from "@/server/domain/conversations";
import { normalizePhone } from "@/server/phone";
import { requireUser } from "@/server/rbac";

export async function createSandboxAction(name: string, phone: string) {
  const user = await requireUser();
  const n = z.string().trim().min(2, "Enter the customer's name").max(120).safeParse(name);
  if (!n.success) return { ok: false as const, error: n.error.issues[0]!.message };
  const p = phone.trim() ? normalizePhone(phone) : null;
  if (phone.trim() && !p) return { ok: false as const, error: "That phone number doesn't look right" };
  const c = await createSandboxConversation({ name: n.data, phone: p }, { id: user.id, role: user.role });
  revalidatePath("/sandbox");
  return { ok: true as const, conversationId: c.id };
}

export async function sandboxSayAction(conversationId: string, text: string) {
  await requireUser();
  const input = z.object({ conversationId: z.string().min(1).max(64), text: z.string().trim().min(1).max(4000) }).safeParse({ conversationId, text });
  if (!input.success) return { ok: false as const, error: "Type a message first" };
  await sandboxCustomerSays(input.data.conversationId, input.data.text);
  return { ok: true as const };
}
