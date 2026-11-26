"use server";
/** Departures actions (DEP-2, DEP-3, DEP-6). Owner and staff; every action re-checks the session. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CampaignError, createCampaign, previewFill, type FillOptions, type FillPreview } from "@/server/domain/departures/campaigns";
import { DepartureError, HERO_IMAGES, saveDeparture, saveTrip, sendChecklist } from "@/server/domain/departures";
import { logger } from "@/server/logger";
import { paiseFromRupeeInput } from "@/server/money";
import { requireUser } from "@/server/rbac";
import { istDateTime } from "@/server/time";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.string().min(1).max(64);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");

async function run<T extends object>(fn: () => Promise<T>, revalidate = true): Promise<ActionResult<T>> {
  try {
    const out = await fn();
    if (revalidate) revalidatePath("/departures");
    return { ok: true, ...out };
  } catch (err) {
    if (err instanceof DepartureError || err instanceof CampaignError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the details" };
    logger.error({ err }, "departures action failed");
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

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

// ───────────────────────────── Fill seats ─────────────────────────────

const fillInput = z.object({ discount: z.string().trim().max(20), validUntil: z.string().trim().max(10) });

function fillOptions(raw: z.input<typeof fillInput>): FillOptions {
  const f = fillInput.parse(raw);
  if (!f.discount) return { discountPerPax: null, validUntil: null };
  const discountPerPax = paiseFromRupeeInput(f.discount);
  if (!discountPerPax) throw new z.ZodError([{ code: "custom", path: ["discount"], message: "Enter the discount in rupees, or leave it blank" }]);
  // The offer is good until the end of the chosen day in IST.
  return { discountPerPax, validUntil: istDateTime(ymd.parse(f.validUntil), "23:59") };
}

export async function previewFillAction(departureId: string, raw: z.input<typeof fillInput>): Promise<ActionResult<{ preview: FillPreview }>> {
  await requireUser();
  return run(async () => ({ preview: await previewFill(id.parse(departureId), fillOptions(raw)) }), false);
}

export async function sendFillAction(departureId: string, raw: z.input<typeof fillInput>): Promise<ActionResult<{ recipients: number }>> {
  const user = await requireUser();
  return run(async () => {
    const c = await createCampaign(id.parse(departureId), fillOptions(raw), { id: user.id, role: user.role });
    return { recipients: c.recipients };
  });
}

export async function sendChecklistAction(departureId: string): Promise<ActionResult<{ sent: number; skipped: number }>> {
  const user = await requireUser();
  return run(async () => sendChecklist(id.parse(departureId), { id: user.id, role: user.role }));
}

// ───────────────────────────── trip + departure CRUD ─────────────────────────────

const lines = z.array(z.string().trim().max(200)).max(40);
const tripInput = z.object({
  name: z.string().trim().min(2, "Give the trip a short name").max(60),
  title: z.string().trim().min(2, "Give the trip a title").max(120),
  destination: z.string().trim().min(2, "Where does it go?").max(80),
  nights: z.coerce.number().int().min(0).max(60),
  days: z.coerce.number().int().min(1, "At least 1 day").max(60),
  summary: z.string().trim().max(1000),
  inclusions: lines,
  exclusions: lines,
  itinerary: z.array(z.object({ title: z.string().trim().max(120), description: z.string().trim().max(1000) })).max(60),
  tags: z.array(z.string().trim().max(30)).max(12),
  heroImageKey: z.enum(HERO_IMAGES).nullable(),
});

export async function saveTripAction(tripId: string | null, raw: z.input<typeof tripInput>): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return run(async () => saveTrip(tripId ? id.parse(tripId) : null, tripInput.parse(raw), { id: user.id, role: user.role }));
}

const departureInput = z.object({
  tripId: id,
  code: z.string().trim().min(3, "Enter a code like NP-28N").max(20),
  startDate: ymd,
  endDate: ymd,
  seatsTotal: z.coerce.number().int("Seats must be a whole number").min(1).max(500),
  price: rupees("the price per person"),
  cost: z.string().trim().max(20).optional(),
  travelBudget: rupees("the travel budget per person", true),
  usualRoomRate: z.string().trim().max(20),
  status: z.enum(["DRAFT", "OPEN", "CLOSED", "COMPLETED", "CANCELLED"]),
});

export async function saveDepartureAction(departureId: string | null, raw: z.input<typeof departureInput>): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return run(async () => {
    const d = departureInput.parse(raw);
    // Staff never set the cost: whatever they send is ignored (the domain keeps the stored cost).
    const cost = user.role === "OWNER" ? paiseFromRupeeInput(d.cost ?? "") : null;
    if (user.role === "OWNER" && !cost) throw new DepartureError("INVALID", "Enter the cost per person in rupees");
    const room = d.usualRoomRate ? paiseFromRupeeInput(d.usualRoomRate) : null;
    if (d.usualRoomRate && room === null) throw new DepartureError("INVALID", "Enter the usual room rate in rupees");
    return saveDeparture(
      departureId ? id.parse(departureId) : null,
      { tripId: d.tripId, code: d.code, startDate: d.startDate, endDate: d.endDate, seatsTotal: d.seatsTotal, pricePerPax: d.price, costPerPax: cost, travelBudgetPerPax: d.travelBudget, usualRoomRate: room, status: d.status },
      { id: user.id, role: user.role },
    );
  });
}
