"use client";
import type { AppEvent } from "@/components/use-events";
import { useRefreshOn } from "@/components/use-events";

/** Drop into any RSC page to re-render it when these events arrive. Renders nothing. */
export function LiveRefresh({ types }: { types: AppEvent["type"][] }) {
  useRefreshOn(types);
  return null;
}
