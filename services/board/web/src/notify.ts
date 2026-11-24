// Browser notifications: while the board is open, one notification per new thing waiting for you, per
// device. What this device has already shown is remembered locally (best effort: storage may be unavailable).
import type { ShownState } from "./types";
import { stateWords } from "./ui/TaskState";

const SEEN_KEY = "aidenhq.notified";

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function remember(ids: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {}
}

type Waiting = { identifier: string; title: string; agent: string; state: ShownState };

/**
 * What to notify about now: items not shown before. Only items still waiting are remembered, so a chat that asks
 * again after being answered notifies again.
 */
export function nextSeen(seen: Set<string>, items: Waiting[]): { seen: Set<string>; fresh: Waiting[] } {
  const key = (i: Waiting) => `${i.identifier}:${i.state.reason}`;
  return { seen: new Set(items.map(key)), fresh: items.filter((i) => !seen.has(key(i))) };
}

/** Phones' Chrome only shows notifications through a service worker; there the constructor throws, so offer nothing. */
let usable = typeof Notification !== "undefined";
export const notificationsSupported = () => usable;
export const notificationsOn = () => usable && Notification.permission === "granted";
export const askForNotifications = () => (usable ? Notification.requestPermission() : Promise.resolve("denied" as NotificationPermission));

const WAKE_DEBOUNCE_MS = 2_000;

/** Polls every 30 s; returns a stop function. The first poll only records what's already waiting (no burst on open). */
export function watchNeedsYou(poll: () => Promise<{ items: Waiting[] }>, onOpen: (identifier: string) => void, wake?: (tick: () => void) => () => void): () => void {
  let first = true;
  const tick = async () => {
    try {
      const { items } = await poll();
      const { seen: next, fresh } = nextSeen(seen(), items);
      remember(next);
      if (!first && notificationsOn())
        for (const i of fresh) {
          try {
            const n = new Notification(`${i.agent}: needs you${stateWords(i.state).detail ? ` · ${stateWords(i.state).detail}` : ""}`, { body: i.title, tag: `${i.identifier}:${i.state.reason}` });
            n.onclick = () => (window.focus(), onOpen(i.identifier));
          } catch {
            usable = false;
          }
        }
      first = false;
    } catch {}
  };
  void tick();
  const t = setInterval(() => void tick(), 30_000);
  // `wake`: live updates (a card filed or decided anywhere) poll at once; the 30 s poll stays as the fallback.
  // Events come in bursts (an agent's every step): one read after they settle, not one per event.
  let soon: ReturnType<typeof setTimeout> | undefined;
  const off = wake?.(() => (clearTimeout(soon), (soon = setTimeout(() => void tick(), WAKE_DEBOUNCE_MS))));
  return () => (clearInterval(t), clearTimeout(soon), off?.());
}
