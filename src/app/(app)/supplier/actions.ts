"use server";
/** Supplier desk actions (SUP-1 … SUP-7). Owner and staff; every action re-checks the session. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { paiseFromRupeeInput } from "@/server/money";
import { normalizePhone } from "@/server/phone";
import { requireUser } from "@/server/rbac";
import { addQuote, bookQuote, confirmQuote, createRfq, saveSupplier, sendVouchers, SupplierError, undoDecline } from "@/server/domain/suppliers";
import { logger } from "@/server/logger";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.string().min(1).max(64);
const rupeeString = z.string().trim().max(20);

async function run<T extends object>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const out = await fn();
    revalidatePath("/supplier");
    return { ok: true, ...out };
  } catch (err) {
    if (err instanceof SupplierError) return { ok: false, error: err.message };
    logger.error({ err }, "supplier action failed");
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

const rupeesToPaise = (v: string | undefined | null): number | null => {
  if (!v || !v.trim()) return null;
  const p = paiseFromRupeeInput(v);
  return p !== null && p > 0 ? p : NaN;
};

// ── SUP-1 directory

const supplierInput = z.object({
  name: z.string().trim().min(2, "Enter the supplier's name").max(120),
  type: z.enum(["HOTEL", "AGENT", "DMC", "TRANSPORT", "OTHER"]),
  destinations: z.array(z.string().trim().min(2).max(80)).min(1, "Add at least one destination").max(20),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.union([z.literal(""), z.email("That email doesn't look right")]).optional(),
  preferredChannel: z.enum(["WHATSAPP", "EMAIL"]),
  active: z.boolean().default(true),
  notes: z.string().trim().max(500).optional(),
});

export async function saveSupplierAction(supplierId: string | null, raw: z.input<typeof supplierInput>): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = supplierInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const v = parsed.data;
  const phone = v.phone ? normalizePhone(v.phone) : null;
  if (v.phone && !phone) return { ok: false, error: "That phone number doesn't look right" };
  return run(async () => {
    const row = await saveSupplier(supplierId ? id.parse(supplierId) : null, { ...v, phone, email: v.email || null }, { id: user.id, role: user.role });
    return { id: row.id };
  });
}

// ── SUP-2/3 rate request

const rfqInput = z.object({
  destination: z.string().trim().min(2, "Choose a destination").max(120),
  departureId: id.optional().nullable(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the check-in date"),
  nights: z.number().int().min(1, "At least 1 night").max(30),
  rooms: z.number().int().min(1, "At least 1 room").max(200),
  category: z.enum(["BUDGET", "COMFORT", "PREMIUM"]),
  mealPlan: z.enum(["EP", "CP", "MAP", "AP"]),
  baseline: rupeeString.optional(),
  supplierIds: z.array(id).min(1, "Choose at least one supplier").max(50),
});

export async function createRfqAction(raw: z.input<typeof rfqInput>): Promise<ActionResult<{ rfqId: string; sentTo: number }>> {
  const user = await requireUser();
  const parsed = rfqInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const v = parsed.data;
  const baseline = rupeesToPaise(v.baseline);
  if (Number.isNaN(baseline)) return { ok: false, error: "Enter your usual rate in rupees, or leave it empty" };
  return run(async () => {
    const rfq = await createRfq({ ...v, baselineRatePerRoomNight: baseline }, { id: user.id, role: user.role });
    return { rfqId: rfq.id, sentTo: rfq.recipients.length };
  });
}

// ── SUP-4/5 quotes

export async function confirmQuoteAction(quoteId: string, rate: string): Promise<ActionResult> {
  const user = await requireUser();
  const paise = rupeesToPaise(rate);
  if (paise === null || Number.isNaN(paise)) return { ok: false, error: "Enter the rate per room per night" };
  return run(async () => {
    await confirmQuote(id.parse(quoteId), paise, { id: user.id, role: user.role });
    return {};
  });
}

const addQuoteInput = z.union([
  z.object({ rfqId: id, supplierId: id, text: z.string().trim().min(1, "Paste the supplier's reply").max(4000) }),
  z.object({ rfqId: id, supplierId: id, rate: rupeeString, inclusions: z.string().trim().max(200).optional() }),
]);

export async function addQuoteAction(raw: z.input<typeof addQuoteInput>): Promise<ActionResult<{ outcome: string }>> {
  const user = await requireUser();
  const parsed = addQuoteInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const v = parsed.data;
  const actor = { id: user.id, role: user.role };
  if ("text" in v) return run(async () => ({ outcome: (await addQuote({ rfqId: v.rfqId, supplierId: v.supplierId, text: v.text }, actor)).outcome }));
  const paise = rupeesToPaise(v.rate);
  if (paise === null || Number.isNaN(paise)) return { ok: false, error: "Enter the rate per room per night" };
  return run(async () => ({ outcome: (await addQuote({ rfqId: v.rfqId, supplierId: v.supplierId, ratePerRoomNight: paise, inclusions: v.inclusions }, actor)).outcome }));
}

export async function undoDeclineAction(recipientId: string): Promise<ActionResult> {
  const user = await requireUser();
  return run(async () => {
    await undoDecline(id.parse(recipientId), { id: user.id, role: user.role });
    return {};
  });
}

// ── SUP-7 book

export async function bookQuoteAction(quoteId: string): Promise<ActionResult<{ expenseId: string }>> {
  const user = await requireUser();
  return run(async () => {
    const r = await bookQuote(id.parse(quoteId), { id: user.id, role: user.role });
    return { expenseId: r.expenseId };
  });
}

// ── Bookings drawer: hotel vouchers

export async function sendVouchersAction(bookingId: string): Promise<ActionResult> {
  const user = await requireUser();
  return run(async () => {
    await sendVouchers(id.parse(bookingId), { id: user.id, role: user.role });
    revalidatePath("/bookings");
    return {};
  });
}
