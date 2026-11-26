// Live updates: one shared EventSource on /api/events (the server's events.ts). Views subscribe by event name and refetch
// through their usual routes; events carry names and ids only. Polling stays as the fallback: while the stream is live
// (a ping or event in the last minute) views reconcile once a minute; otherwise they poll at their old pace. A stream that
// is refused (signed out) or buffered by a proxy is simply never live.
import { useEffect, useRef } from "react";

export type EventName = "approvals" | "chat" | "progress" | "grades" | "fleet" | "tasks" | "connections" | "setup" | "home";
type Handler = (issue?: string) => void;

const NAMES: EventName[] = ["approvals", "chat", "progress", "grades", "fleet", "tasks", "connections", "setup", "home"];
const LIVE_MS = 60_000;
const handlers = new Map<EventName, Set<Handler>>();
let source: EventSource | null = null;
let heard = 0;
let retry: ReturnType<typeof setInterval> | undefined;

function open() {
  if (source || typeof EventSource === "undefined") return;
  const s = new EventSource("/api/events");
  source = s;
  s.addEventListener("ping", () => (heard = Date.now()));
  for (const name of NAMES)
    s.addEventListener(name, (e) => {
      heard = Date.now();
      let issue: string | undefined;
      try {
        issue = JSON.parse((e as MessageEvent).data)?.issue;
      } catch {}
      for (const h of handlers.get(name) ?? []) h(issue);
    });
  // The browser reconnects a dropped stream itself; a refused one (401, 404) closes for good, so try again each minute.
  s.onerror = () => {
    if (s.readyState === EventSource.CLOSED && source === s) source = null;
  };
  retry ??= setInterval(() => !source && handlers.size && open(), LIVE_MS);
}

/** Whether the stream is delivering (anything heard in the last minute). */
export const live = () => Date.now() - heard < LIVE_MS;

/**
 * Calls `h` on each of these events (after a short pause, so a burst refetches once); with `only`, an event naming another
 * task is ignored. Returns the unsubscribe.
 */
export function subscribe(names: EventName[], h: Handler, only?: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced: Handler = (issue) => {
    if (only && issue && issue !== only) return;
    clearTimeout(timer);
    timer = setTimeout(() => h(issue), 250);
  };
  for (const n of names) {
    if (!handlers.has(n)) handlers.set(n, new Set());
    handlers.get(n)!.add(debounced);
  }
  open();
  return () => {
    clearTimeout(timer);
    for (const n of names) {
      handlers.get(n)?.delete(debounced);
      if (!handlers.get(n)?.size) handlers.delete(n);
    }
  };
}

/** Refetch on these events (a `chat` event only for `issue`, when given). */
export function useEvents(names: EventName[], load: () => unknown, issue?: string) {
  const ref = useRef(load);
  ref.current = load;
  const key = names.join();
  useEffect(() => subscribe(key.split(",") as EventName[], () => void ref.current(), issue), [key, issue]);
}

/**
 * Load now, on these events, and poll as a fallback: every `pollMs` while the stream isn't live, once a minute while it is
 * (only while the page is visible).
 */
export function useLive(names: EventName[], load: () => unknown, pollMs: number) {
  const ref = useRef(load);
  ref.current = load;
  useEvents(names, () => ref.current());
  useEffect(() => {
    let last = Date.now();
    void ref.current();
    const t = setInterval(() => {
      if (document.visibilityState !== "visible" || (live() && Date.now() - last < LIVE_MS)) return;
      last = Date.now();
      void ref.current();
    }, pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
}
