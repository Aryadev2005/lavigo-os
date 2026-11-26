"use server";
/** Tickets desk actions (TKT-1, TKT-2, TKT-7). Owner and staff; every action re-checks the session. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { confirmBooking, deleteOption, deletePlan, saveOption, savePlan, TicketError } from "@/server/domain/tickets";
import { logger } from "@/server/logger";
import { paiseFromRupeeInput } from "@/server/money";
import { requireUser } from "@/server/rbac";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.string().min(1).max(64);

async function run<T extends object>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const out = await fn();
    revalidatePath("/tickets");
    return { ok: true, ...out };
  } catch (err) {
    if (err instanceof TicketError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the details" };
    logger.error({ err }, "tickets action failed");
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** "7,850" → paise; blank → 0 when allowed. */
const rupees = (label: string, allowZero = false) =>
  z
    .string()
    .trim()
    .max(20)
    .transform((v, ctx) => {
      if (!v && allowZero) return 0;
      const p = paiseFromRupeeInput(v);
      if (p === null || p < 0 || (!allowZero && p === 0)) {
        ctx.addIssue({ code: "custom", message: `Enter ${label} in rupees` });
        return z.NEVER;
      }
      return p;
    });

const planInput = z.object({
  label: z.string().trim().min(2, "Give the plan a name").max(120),
  departureId: id.nullable(),
  bookingId: id.nullable(),
  origin: z.string().trim().min(2, "Where from?").max(80),
  destination: z.string().trim().min(2, "Where to?").max(80),
  travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the travel date"),
  budget: rupees("the travel budget per person", true),
  note: z.string().trim().max(500).nullable(),
});

export async function savePlanAction(planId: string | null, raw: z.input<typeof planInput>): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return run(async () => {
    const p = planInput.parse(raw);
    return savePlan(planId ? id.parse(planId) : null, { ...p, budgetPerPax: p.budget }, { id: user.id, role: user.role });
  });
}

export async function deletePlanAction(planId: string): Promise<ActionResult> {
  const user = await requireUser();
  return run(async () => {
    await deletePlan(id.parse(planId), { id: user.id, role: user.role });
    return {};
  });
}

const optionInput = z.object({
  mode: z.enum(["FLIGHT", "TRAIN", "BUS", "OTHER"]),
  title: z.string().trim().min(2, "Name the option").max(160),
  details: z.string().trim().max(200),
  ticket: rupees("the ticket fare per person"),
  extras: rupees("hidden extras per person", true),
  extrasNote: z.string().trim().max(160).nullable(),
  tags: z.array(z.string().trim().max(40)).max(6),
  disqualified: z.boolean(),
  disqualifiedReason: z.string().trim().max(120).nullable(),
});

export async function saveOptionAction(planId: string, optionId: string | null, raw: z.input<typeof optionInput>): Promise<ActionResult<{ id: string; snapshot: boolean }>> {
  const user = await requireUser();
  return run(async () => {
    const o = optionInput.parse(raw);
    return saveOption(id.parse(planId), optionId ? id.parse(optionId) : null, { ...o, ticketPerPax: o.ticket, extrasPerPax: o.extras }, { id: user.id, role: user.role });
  });
}

export async function deleteOptionAction(optionId: string): Promise<ActionResult> {
  const user = await requireUser();
  return run(async () => {
    await deleteOption(id.parse(optionId), { id: user.id, role: user.role });
    return {};
  });
}

/**
 * Confirm booking (TKT-7). FormData: planId, optionId, count, pnr-<i>, file-<i> (optional PDF).
 * Profit is not part of the response: the page re-renders it for OWNER only.
 */
export async function confirmBookingAction(form: FormData): Promise<ActionResult<{ pax: number; tickets: number; pnrs: string[]; withPdf: number }>> {
  const user = await requireUser();
  return run(async () => {
    const planId = id.parse(form.get("planId"));
    const optionId = id.parse(form.get("optionId"));
    const count = z.coerce.number().int().min(1).max(60).parse(form.get("count"));
    const tickets = [];
    for (let i = 0; i < count; i++) {
      const pnr = z.string().max(20).parse(form.get(`pnr-${i}`) ?? "");
      const f = form.get(`file-${i}`);
      tickets.push({ pnr, file: f instanceof File && f.size > 0 ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null });
    }
    const r = await confirmBooking({ planId, optionId, tickets }, { id: user.id, role: user.role });
    return { pax: r.pax, tickets: r.tickets, pnrs: r.pnrs, withPdf: tickets.filter((t) => t.file).length };
  });
}
