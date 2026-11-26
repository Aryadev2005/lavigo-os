"use client";
/**
 * App-wide realtime alerts (DESK-3, DESK-6): SSE toasts addressed to this role, and a page refresh
 * when approvals change so the sidebar badge and Today's Needs-you stay current everywhere.
 */
import type { Role } from "@prisma/client";
import { useEvents, useRefreshOn } from "@/components/use-events";
import { useToast } from "./toast";

export function LiveAlerts({ role }: { role: Role }) {
  const toast = useToast();
  useEvents((e) => {
    if (e.type !== "toast") return;
    if (e.payload.audience && e.payload.audience !== role) return;
    toast(e.payload.text, e.payload.icon);
  }, ["toast"]);
  useRefreshOn(["approval.created", "approval.decided"]);
  return null;
}
