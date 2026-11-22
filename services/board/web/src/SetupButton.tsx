// A module's setup flow entry point (docs/design/guided-setup.md): "Set up" while its flow isn't done, a quiet "Change setup"
// once it is. GET /api/setup-flows (services/board/src/setup-flows.ts); a module without a flow renders nothing.
import { useSyncExternalStore } from "react";
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

// One setup state for the whole board, shared by every view: the Modules list, a module's page and its Setup button all
// show the same flows, so a page mount reads them once rather than once per view.
/** What the last good read answered (null before the first), kept when a read fails rather than reporting a fresh install. */
let snapshot: Flow[] | null = null;
/** A read is out; `invalidations` moved past `served` while it was out, so it reads again instead of showing a stale answer. */
let reading = false;
/** Bumped by each change and by the last view leaving: a read that began before it says nothing about now. */
let invalidations = 0;
const readers = new Set<() => void>();
let live: (() => void) | undefined;

async function read(): Promise<Flow[]> {
  const r = await api.setupFlows();
  const list = Array.isArray(r) ? r : (r as { flows?: unknown })?.flows;
  return Array.isArray(list) ? (list as Flow[]) : [];
}

/**
 * Reads the flows, one read at a time: a change that lands while a read is out is answered by one more read that began
 * after it, never one per event or a second read in parallel, and a failed read keeps the state already shown.
 */
async function refresh(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    for (;;) {
      const at = invalidations;
      let next: Flow[] | undefined;
      try {
        next = await read();
      } catch {
        // Nobody shows the flows any more: this answer is for a view that left, so the next mount reads afresh.
        if (!readers.size) return;
        // Keep what is shown, unless something changed while this read was out: then it never answered.
        if (invalidations !== at) continue;
        return;
      }
      // Nobody shows the flows any more: discard this answer rather than keep it for the next view.
      if (!readers.size) return;
      // A read that began before a change says nothing about now: read once more.
      if (invalidations !== at) continue;
      snapshot = next;
      for (const r of readers) r();
      return;
    }
  } finally {
    reading = false;
  }
}

/** One live subscription for the board's setup state: a setup or sign-in change, or the once-a-minute fallback poll. */
function watch(): void {
  if (live || typeof window === "undefined") return;
  const off = subscribe(["connections", "setup"], () => forgetFlows());
  const poll = setInterval(() => {
    if (document.visibilityState === "visible") forgetFlows();
  }, 60_000);
  live = () => {
    off();
    clearInterval(poll);
    live = undefined;
  };
}

/** Subscribes a view: while any view shows the flows, its changes are live and it reads them when it first needs to. */
function watchFlows(onChange: () => void): () => void {
  readers.add(onChange);
  watch();
  // Only a view mounting without state yet reads: one that mounts beside a view already showing the flows shares it.
  if (snapshot === null && !reading) void refresh();
  return () => {
    readers.delete(onChange);
    // Nothing shows the flows any more: a view mounting later (Done returns to the list) reads them afresh, and a read
    // already out is out of date for it.
    if (readers.size) return;
    live?.();
    invalidations++;
    snapshot = null;
  };
}

/** The flows are out of date (a pairing landed, a secret was saved): the next read is fresh, and every view gets it. */
export function forgetFlows(): void {
  if (!readers.size) return;
  invalidations++;
  // A read already out answers this change with one more of its own; otherwise the next read starts now.
  if (!reading) void refresh();
}

/** Whether the flow's next step is pairing: its secrets are saved and every sign-in before it is in, so only the phone is left. */
export const pairingNext = (f: Flow) =>
  f.paired === false && (f.fields ?? []).every((x) => f.present?.[x.secret]) && f.signedIn !== false;

/** The setup flows as the board last read them (null before the first), re-read when a flow changes or, as a fallback, once a minute. */
export function useFlows(): Flow[] | null {
  return useSyncExternalStore(watchFlows, () => snapshot, () => snapshot);
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
