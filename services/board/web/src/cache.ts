// Stale-while-revalidate for the board's pages: a view shows the last good response at once (from memory, or from
// localStorage after a reload), marks it as updating, then swaps in the fresh one. Keyed per route (with its params).
// Persisted entries belong to the signed-in account (`setAccount`); signing out, or any 401, clears them. Only display
// data is persisted: callers pass `persist: false` for anything a decision is made on (approvals) or private chat text,
// or a function giving the part that may be kept (the chat list without any message text).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
// A 401 from api.ts (its SignInRequired, message "sign in"); matched by message so this module needs no app imports.
const signedOut = (e: unknown) => e instanceof Error && e.message === "sign in";

const PREFIX = "aidenhq.cache.";
const ACCOUNT_KEY = `${PREFIX}account`;
/** Per entry: a larger response just isn't persisted (memory still holds it). */
const MAX_BYTES = 1_500_000;
/** A response the server marked stale is asked for again after this. */
const STALE_RETRY_MS = 2_000;

interface Entry {
  data: unknown;
  /** When it was fetched (read back from storage, it keeps that time). */
  at: number;
}

const mem = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<unknown>>();
/** What was last written to storage per key (its data as JSON), so an unchanged poll writes nothing. */
const written = new Map<string, string>();
const noop = () => {};
const followUps = new Map<string, Promise<unknown>>();
let account: string | null = null;

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const notify = (key: string) => listeners.get(key)?.forEach((l) => l());

/** Whose cache this is: the signed-in account's id (null signs out: everything cached is dropped). */
export function setAccount(id: string | null) {
  const s = storage();
  let before: string | null = null;
  try {
    before = s?.getItem(ACCOUNT_KEY) ?? null;
  } catch {}
  if (id === null || (before && before !== id)) clearCache();
  account = id;
  try {
    if (id) s?.setItem(ACCOUNT_KEY, id);
  } catch {}
}

/**
 * At boot, before the session is checked: whose cache this device last held, so the last board paints at once. The
 * session's answer then confirms it (setAccount) or signs out and drops everything.
 */
export function adoptStoredAccount() {
  try {
    account = storage()?.getItem(ACCOUNT_KEY) ?? null;
  } catch {}
}

/** Drop every cached response, in memory and in storage. */
export function clearCache() {
  const keys = [...mem.keys()];
  mem.clear();
  written.clear();
  inflight.clear();
  followUps.clear();
  for (const r of staleRetries.values()) clearTimeout(r.timer);
  staleRetries.clear();
  account = null;
  const s = storage();
  try {
    if (s) for (let i = s.length - 1; i >= 0; i--) if (s.key(i)?.startsWith(PREFIX)) s.removeItem(s.key(i)!);
  } catch {}
  keys.forEach(notify);
}

/** The cached response for this key (the same object until it changes): memory first, then the account's storage. */
export function peek<T>(key: string): { data: T; at: number } | undefined {
  const m = mem.get(key);
  if (m || !account) return m as { data: T; at: number } | undefined;
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as { account: string; at: number; data: T };
    if (saved.account !== account) return undefined;
    const e: Entry = { data: saved.data, at: saved.at };
    mem.set(key, e);
    return e as { data: T; at: number };
  } catch {
    return undefined;
  }
}

/**
 * `next`, reusing every part of `prev` that is deep-equal to it: a refetch that changed one message keeps every other
 * message the same object, so memoised rows don't re-render, and an unchanged refetch keeps `data` itself.
 */
export function share<T>(prev: unknown, next: T): T {
  if (prev === next || typeof prev !== "object" || typeof next !== "object" || !prev || !next || Array.isArray(prev) !== Array.isArray(next)) return next;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  let same = keys.length === Object.keys(a).length;
  const out: Record<string, unknown> = Array.isArray(b) ? ([] as unknown as Record<string, unknown>) : {};
  for (const k of keys) {
    out[k] = share(a[k], b[k]);
    if (out[k] !== a[k]) same = false;
  }
  return (same ? prev : out) as T;
}

/** Kept on the device (true), memory only (false), or only what the function returns kept. */
export type Persist = boolean | ((data: any) => unknown);

export function put(key: string, data: unknown, persist: Persist = true) {
  const at = Date.now();
  data = share(mem.get(key)?.data, data);
  mem.set(key, { data, at });
  notify(key);
  if (!persist || !account) return;
  const s = storage();
  try {
    // Polls mostly bring the same answer: rewrite storage only when it changed (a reload shows its older `at` as stale anyway).
    const kept = typeof persist === "function" ? persist(data) : data;
    const body = JSON.stringify(kept);
    if (written.get(key) === body) return;
    written.set(key, body);
    const raw = JSON.stringify({ account, at, data: kept });
    if (raw.length > MAX_BYTES) return s?.removeItem(PREFIX + key);
    s?.setItem(PREFIX + key, raw);
  } catch {
    // Full (quota) or blocked: this entry just isn't kept.
  }
}

/**
 * Fetch into the cache: one request per key at a time (a second caller shares it; with `after`, it waits for the running
 * one and then fetches again, for a refresh that must see a change just made). A 401 clears the cache (the session ended)
 * and rethrows, so the view can ask to sign in.
 */
export function load<T>(key: string, fetcher: () => Promise<T>, persist: Persist = true, after = false): Promise<T> {
  const running = inflight.get(key);
  if (running && after) {
    // At most one follow-up per key: polls on a slow route share it instead of queueing behind each other.
    if (!followUps.has(key)) {
      const next = running.then(noop, noop).then(() => (followUps.delete(key), load(key, fetcher, persist)));
      followUps.set(key, next);
    }
    return followUps.get(key) as Promise<T>;
  }
  if (running) return running as Promise<T>;
  const p = fetcher().then(
    (data) => {
      if (inflight.get(key) !== p) return data;
      put(key, data, persist);
      // The server showed its last good answer while it reads a fresh one (swr.ts `stale`): ask again in a moment.
      if ((data as { stale?: unknown } | null)?.stale === true) retryStale(key, fetcher, persist);
      else staleRetries.delete(key);
      // The stored copy: unchanged parts keep their identity (share), so callers' memos hold.
      return mem.get(key)!.data as T;
    },
    (e) => {
      if (signedOut(e)) clearCache();
      throw e;
    },
  );
  inflight.set(key, p);
  void p.then(
    () => inflight.get(key) === p && inflight.delete(key),
    () => inflight.get(key) === p && inflight.delete(key),
  );
  return p;
}

/** One pending retry per key for a stale response, backing off while the answers stay stale. */
const staleRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; n: number }>();
function retryStale(key: string, fetcher: () => Promise<unknown>, persist: Persist) {
  const have = staleRetries.get(key);
  if (have?.timer) return;
  const n = have?.n ?? 0;
  const timer = setTimeout(() => {
    staleRetries.set(key, { timer: undefined as never, n: n + 1 });
    load(key, fetcher, persist).catch(noop);
  }, Math.min(STALE_RETRY_MS * 2 ** n, 16_000));
  staleRetries.set(key, { timer, n });
}

/** Warm the cache (a hovered tab): ignores errors; skips a key fetched in the last 15 seconds. */
export function prefetch(key: string, fetcher: () => Promise<unknown>, persist: Persist = true) {
  const e = mem.get(key);
  if (e && Date.now() - e.at < 15_000) return;
  load(key, fetcher, persist).catch(() => {});
}

export function subscribe(key: string, l: () => void) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(l);
  return () => void listeners.get(key)?.delete(l);
}

export interface Cached<T> {
  data: T | undefined;
  /** What's shown came from an earlier load (memory or storage) and a fresh one hasn't landed yet. */
  stale: boolean;
  error: string;
  /** Refetch now (events, polls, Refresh). */
  reload: () => Promise<void>;
}

/**
 * The response for `key`, cached: renders what's cached immediately, fetches on mount (and when `key` changes), and
 * re-renders when any loader of the same key lands. `onSignIn` is called on a 401.
 */
export function useCached<T>(key: string, fetcher: () => Promise<T>, opts: { persist?: Persist; onSignIn?: () => void } = {}): Cached<T> {
  const persist = opts.persist ?? true;
  const ref = useRef({ fetcher, onSignIn: opts.onSignIn });
  ref.current = { fetcher, onSignIn: opts.onSignIn };
  const [error, setError] = useState({ key, text: "" });
  const entry = useSyncExternalStore(
    useCallback((l: () => void) => subscribe(key, l), [key]),
    () => peek<T>(key),
  );
  const fetchNow = useCallback(
    async (after: boolean) => {
      try {
        await load(key, () => ref.current.fetcher(), persist, after);
        setError({ key, text: "" });
      } catch (e) {
        if (signedOut(e)) ref.current.onSignIn?.();
        else setError({ key, text: (e as Error).message });
      }
    },
    [key, persist],
  );
  // On open, share a fetch already running (a prefetch); a later reload (an event, a decision) fetches after it.
  useEffect(() => void fetchNow(false), [fetchNow]);
  const reload = useCallback(() => fetchNow(true), [fetchNow]);
  // Stale: loaded before this view opened (an earlier visit, or storage), until a load that lands after.
  const opened = useRef({ key, at: Date.now() });
  if (opened.current.key !== key) opened.current = { key, at: Date.now() };
  return { data: entry?.data, stale: !!entry && (entry.at < opened.current.at || (entry.data as { stale?: unknown } | null)?.stale === true), error: error.key === key ? error.text : "", reload };
}
