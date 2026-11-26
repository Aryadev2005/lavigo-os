"use server";
/** Global search in the top bar (TOD-6): customers by name/phone, bookings by code. */
import { z } from "zod";
import { globalSearch } from "@/server/domain/bookings/queries";
import { requireUser } from "@/server/rbac";

export async function searchAction(q: string) {
  await requireUser();
  return globalSearch(z.string().max(80).parse(q));
}
