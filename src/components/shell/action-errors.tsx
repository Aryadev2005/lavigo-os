"use client";
/**
 * Safety net for server actions that fail outside the normal { ok: false } path: the network drops,
 * the server restarts mid-request, or an action throws. Components already show their own errors;
 * this turns anything unhandled into a toast instead of a silent no-op.
 */
import { useEffect } from "react";
import { useToast } from "./toast";

const NETWORK = /failed to fetch|networkerror|load failed|network request failed|unexpected response was received from the server|fetch failed/i;

export function ActionErrorToasts() {
  const toast = useToast();
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
      // Next's own redirect()/notFound() signals are control flow, not failures.
      if (/NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR/.test(msg)) return;
      toast(NETWORK.test(msg) ? "Couldn't reach the server. Check your connection and try again." : "That didn't work. Please try again.", "⚠️");
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [toast]);
  return null;
}
