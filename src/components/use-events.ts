"use client";
/**
 * Realtime events from /api/stream. One EventSource per tab, shared by every subscriber; it
 * closes when the last subscriber unmounts. The browser reconnects on its own (retry: 5000).
 *
 *   useEvents((e) => …, ["message.created"])        // react to specific events
 *   useRefreshOn(["booking.updated", "activity.created"]) // re-render the RSC page (debounced)
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { AppEvent } from "@/server/pubsub";

export type { AppEvent };
type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect() {
  if (source || typeof window === "undefined") return;
  source = new EventSource("/api/stream");
  source.onmessage = (m: MessageEvent<string>) => {
    let event: AppEvent;
    try {
      event = JSON.parse(m.data) as AppEvent;
    } catch {
      return;
    }
    for (const l of listeners) l(event);
  };
}

function disconnectIfIdle() {
  if (listeners.size === 0 && source) {
    source.close();
    source = null;
  }
}

export function useEvents(handler: Listener, types?: readonly AppEvent["type"][]) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  const key = types?.join(",") ?? "*";
  useEffect(() => {
    const wanted = key === "*" ? null : new Set(key.split(","));
    const listener: Listener = (e) => {
      if (!wanted || wanted.has(e.type)) ref.current(e);
    };
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      disconnectIfIdle();
    };
  }, [key]);
}

/** Calls router.refresh() (debounced) when any of `types` arrives. */
export function useRefreshOn(types: readonly AppEvent["type"][], delayMs = 400) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEvents(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), delayMs);
  }, types);
}
