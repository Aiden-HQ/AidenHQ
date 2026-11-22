// A module's setup flow entry point (docs/design/guided-setup.md): "Set up" while its flow isn't done, a quiet "Change setup"
// once it is. GET /api/setup-flows (services/board/src/setup-flows.ts); a module without a flow renders nothing.
import { useEffect, useState } from "react";
import { api } from "./api";
import { subscribe } from "./events";

export interface Flow {
  module: string;
  title?: string;
  done?: boolean;
  /** The flow finishes by pairing a phone: false until a chat is paired. */
  paired?: boolean;
  /** Its paste fields and which secrets are saved, and whether its sign-in is in: what its next step is. */
  fields?: { secret: string }[];
  present?: Record<string, boolean>;
  signedIn?: boolean;
}

// One setup-state read per board, shared by every view: the Modules list, a module's page and its Setup button all show the
// same flows, and a page mount reads them once rather than once per view.
let cache: Promise<Flow[]> | undefined;
/** Whether that promise is still waiting on the server, so a change can be answered by its next read instead of a second one. */
let reading = false;
/** What the last good read answered; a failed read keeps it rather than reporting that nothing needs setup. */
let flowsNow: Flow[] | null = null;
/** Raised by each change: a read that began before one is out of date, so another follows it. */
let changed = 0;
const readers = new Set<(flows: Flow[]) => void>();
let live: (() => void) | undefined;

async function read(): Promise<Flow[]> {
  const r = await api.setupFlows();
  const list = Array.isArray(r) ? r : (r as { flows?: unknown })?.flows;
  return Array.isArray(list) ? (list as Flow[]) : [];
}

/**
 * Reads the flows, sharing a read already in flight so views never fetch once each and two answers never land out of
 * order; a failed read keeps the state already shown. A change that lands while a read is out is answered by one more
 * read that began after it, never one per event.
 */
export function flows(): Promise<Flow[]> {
  if (cache) return cache;
  watch();
  return (cache = (async () => {
    reading = true;
    try {
      for (;;) {
        const at = changed;
        let l: Flow[] | undefined;
        try {
          l = await read();
        } catch {
          // Nobody is showing the flows any more: this answer is for a view that left, so the next mount reads afresh.
          if (!readers.size) {
            cache = undefined;
            return flowsNow ?? [];
          }
          // A failed read is not an answer that nothing needs setup: keep what is shown, and read fresh next time.
          if (changed !== at) continue;
          cache = undefined;
          return flowsNow ?? [];
        }
        // Nobody is showing the flows any more: discard this answer rather than keep it for the next view.
        if (!readers.size) {
          cache = undefined;
          return l;
        }
        // A read that began before a change says nothing about now: read again, all within this one shared promise.
        if (changed !== at) continue;
        // Kept until a change, so every view on the page shares this one read.
        flowsNow = l;
        for (const r of readers) r(l);
        return l;
      }
    } finally {
      reading = false;
    }
  })());
}

/** One live subscription for the board's setup state: a setup or sign-in change, or the once-a-minute fallback poll. */
function watch(): void {
  if (live || typeof window === "undefined") return;
  const changedHere = () => forgetFlows();
  const off = subscribe(["connections", "setup"], changedHere);
  const poll = setInterval(() => {
    if (document.visibilityState === "visible") forgetFlows();
  }, 60_000);
  live = () => {
    off();
    clearInterval(poll);
    live = undefined;
  };
}

/** The flows are out of date (a pairing landed, a secret was saved): the next read is fresh, and every view gets it. */
export function forgetFlows(): void {
  changed++;
  // A read already out answers this change with one more of its own; otherwise the next read starts now.
  if (reading) return;
  cache = undefined;
  void flows();
}

/** Whether the flow's next step is pairing: its secrets are saved and every sign-in before it is in, so only the phone is left. */
export const pairingNext = (f: Flow) =>
  f.paired === false && (f.fields ?? []).every((x) => f.present?.[x.secret]) && f.signedIn !== false;

/** The setup flows as the board last read them (null before the first), re-read when a flow changes or, as a fallback, once a minute. */
export function useFlows(): Flow[] | null {
  const [list, setList] = useState<Flow[] | null>(flowsNow);
  useEffect(() => {
    readers.add(setList);
    void flows();
    return () => {
      readers.delete(setList);
      // Nothing shows the flows any more: a view mounting later (Done returns to the list) reads them afresh.
      if (!readers.size) {
        // This view's state is gone, and any read already out is out of date for the next view to mount (Done returns to
        // the list): it is discarded rather than kept. A read still out is left to finish and clear itself.
        (flowsNow = null), changed++;
        if (!reading) cache = undefined;
        live?.();
      }
    };
  }, []);
  return list;
}

export function SetupButton({ module, primary, size, word }: { module: string; primary?: boolean; size?: "sm"; word?: string }) {
  const flow = useFlows()?.find((f) => f.module === module);
  if (!flow) return null;
  return (
    <a className={`btn${primary && !flow.done ? " primary" : ""}${size ? ` ${size}` : ""}`} href={`#/setup/${module}${flow.done ? "?change=1" : ""}`}>
      {flow.done ? "Change setup" : (word ?? "Set up")}
    </a>
  );
}
