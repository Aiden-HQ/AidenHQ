// The board's cached reads (cache.ts): one place names each route's cache key and whether it may be kept on the device,
// so a page and the tab that prefetches it share the same entry.
import { accountsApi, api } from "./api";
import { adoptStoredAccount, load, prefetch, useCached, type Persist } from "./cache";
import { chatListForDevice } from "./conversation";

/** The URL hash without its `#/`, percent-decoded; a malformed escape stays raw. */
export function hashPath(): string {
  const raw = location.hash.replace(/^#\/?/, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface Query<T> {
  key: string;
  fetch: () => Promise<T>;
  /** Kept in localStorage across reloads (display data only); false keeps it in memory for this page load; a function keeps only what it returns. */
  persist: Persist;
}
const q = <T,>(key: string, fetch: () => Promise<T>, persist: Persist = true): Query<T> => ({ key, fetch, persist });

export const QUERIES = {
  roster: q("agents.roster", api.roster),
  agents: q("agents", api.agents),
  apps: q("apps", api.apps),
  // Who may open each app (emails): memory only.
  appAccess: q("app-admins", accountsApi.appAdmins, false),
  modules: q("modules", api.modules),
  pages: q("pages", api.pages),
  // What the owner decides on is never read back from the device: memory only, refetched on every visit.
  approvals: q("approvals", api.approvals, false),
  needsYou: q("needs-you", api.needsYou, false),
  // The chat list is kept on the device without any message text (titles, states, times, unread), so a reload paints it
  // at once; the preview of the last message and the failure reason come only from the network. Chats stay memory only.
  lane: q("lane", api.lane, false),
  chats: q("chats", api.chats, chatListForDevice),
};

export const scorecardQuery = (id: string) => q(`agents.${id}.scorecard`, () => api.scorecard(id));
export const agentProfileQuery = (key: string) => q(`agents.${key}.profile`, () => api.agentProfile(key).then((r) => r.profile));
/** Task titles stay off the device, like chats. */
export const agentOpenQuery = (key: string) => q(`agents.${key}.open`, () => api.agentOpenTasks(key), false);
/** The Activity tab: task titles and error text stay off the device. */
export const agentTimelineQuery = (key: string) => q(`agents.${key}.timeline`, () => api.agentTimeline(key).then((r) => r.entries), false);
/** One chat. `peek`: a prefetch (a hovered row), which must not mark the chat read. */
export const chatQuery = (ref: string) => q(`chats.${ref}`, () => api.chat(ref), false);
const peeking = new Set<string>();
export const prefetchChat = (ref: string) =>
  prefetch(`chats.${ref}`, () => (peeking.add(ref), api.chat(ref, true).finally(() => peeking.delete(ref))), false);
/** A hover's prefetch is still running: opening the chat shares it, so it must fetch again after to mark the chat read. */
export const peekingChat = (ref: string) => peeking.has(ref);

export const useQuery = <T,>(query: Query<T>, onSignIn?: () => void) => useCached(query.key, query.fetch, { persist: query.persist, onSignIn });

/** What each tab reads first, warmed when the tab is hovered or focused. */
const VIEW_QUERIES: Record<string, Query<unknown>[]> = {
  chat: [QUERIES.chats],
  agents: [QUERIES.roster, QUERIES.agents],
  apps: [QUERIES.apps],
  modules: [QUERIES.modules],
  approvals: [QUERIES.approvals, QUERIES.needsYou],
};

/** Pages split off the first download (App.tsx loads them lazily); a hover, or an idle moment after boot, fetches them. */
export const VIEW_CHUNKS = {
  apps: () => import("./Apps"),
  costs: () => import("./Costs"),
  flow: () => import("./Flow"),
  agents: () => import("./Agents"),
  modules: () => import("./Modules"),
  agentPage: () => import("./AgentPage"),
  modulePage: () => import("./ModulePage"),
  moduleView: () => import("./ModuleView"),
  run: () => import("./Run"),
  design: () => import("./Design"),
  reviews: () => import("./Reviews"),
};

export function prefetchView(view: string) {
  void VIEW_CHUNKS[view as keyof typeof VIEW_CHUNKS]?.().catch(() => {});
  for (const x of VIEW_QUERIES[view] ?? []) prefetch(x.key, x.fetch, x.persist);
}

/** The page this device opens on is Tasks (or a task over it): the only one that needs the board's inventory at once. */
export function landsOnBoard(): boolean {
  const h = hashPath();
  if (h === "board" || h.startsWith("board?") || h.startsWith("t/")) return true;
  if (h) return false;
  try {
    return localStorage.getItem("aidenhq.view") === "board";
  } catch {
    return false;
  }
}

/**
 * At boot, before React renders: the reads the first screen needs start together with the session check, instead of one
 * after another as each component mounts; meanwhile the device's last board paints (adoptStoredAccount).
 */
export function preloadBoot() {
  adoptStoredAccount();
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  quiet(load("session", api.session, false));
  if (landsOnBoard()) quiet(load("board", api.board));
  const h = hashPath();
  let view = "chat";
  try {
    view = localStorage.getItem("aidenhq.view") ?? "chat";
  } catch {}
  if (h === "c" || h.startsWith("c/") || (!h && view === "chat")) quiet(load(QUERIES.chats.key, QUERIES.chats.fetch, QUERIES.chats.persist));
  const ref = h.startsWith("c/") ? h.slice(2).split("?")[0] : "";
  if (ref) quiet(load(chatQuery(ref).key, chatQuery(ref).fetch, false));
  // The other pages' code once the first screen is up, so a tab never waits on a download.
  const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2_000));
  setTimeout(() => idle(() => Object.values(VIEW_CHUNKS).forEach((f) => void f().catch(() => {}))), 3_000);
}
