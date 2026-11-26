/** Shared supplier-desk types and labels (no imports from ./index, so ./vouchers can use them). */
import type { MealPlan, Role, RoomCategory } from "@prisma/client";

export type Actor = { id: string; role: Role };

export class SupplierError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID" | "NO_CONTACT" | "ALREADY_BOOKED" | "NEEDS_CHECK" | "DECLINED",
    message: string,
  ) {
    super(message);
    this.name = "SupplierError";
  }
}

export const CATEGORY_LABEL: Record<RoomCategory, string> = { BUDGET: "Budget", COMFORT: "Comfort (3★)", PREMIUM: "Premium" };
export const MEAL_PLAN_LABEL: Record<MealPlan, string> = {
  EP: "Room only (EP)",
  CP: "Breakfast only (CP)",
  MAP: "Breakfast + dinner (MAP)",
  AP: "All meals (AP)",
};

/** Loose destination match: "Gangtok & Lachung, Sikkim" ~ "Gangtok, Sikkim" (shared place word). */
export function destinationMatches(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4));
  const wa = words(a);
  for (const w of words(b)) if (wa.has(w)) return true;
  return false;
}
