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

/** Home's since window for this visit (its first response's `since_from`): refetches during the visit keep it, so the
 * block never empties while the owner reads it. Home sets it and clears it on leaving; the badge's polls send none. */
export const homeFrom = { value: undefined as string | undefined };

export const QUERIES = {
  // The one Home entry: Home, the top bar's badge and the notifications read it (one event, one server build). Memory only.
  home: q("home", () => api.home(homeFrom.value), false),
  roster: q("agents.roster", api.roster),
  agents: q("agents", api.agents),
  apps: q("apps", api.apps),
  // Who may open each app (emails): memory only.
  appAccess: q("app-admins", accountsApi.appAdmins, false),
  modules: q("modules", api.modules),
  // Session titles stay off the device, like chats.
  sessions: q("sessions", api.sessions, false),
  pages: q("pages", api.pages),
  // What the owner decides on is never read back from the device: memory only, refetched on every visit.
  approvals: q("approvals", api.approvals, false),
  needsYou: q("needs-you", api.needsYou, false),
  // The chat list is kept on the device without any message text (titles, states, times, unread), so a reload paints it
  // at once; the preview of the last message and the failure reason come only from the network. Chats stay memory only.
  lane: q("lane", api.lane, false),
  chats: q("chats", () => api.chats(), chatListForDevice),
};

/** One agent's chats (its teammate page, Ask Aiden): the active ones, or the settled ones. */
export const agentChatsQuery = (key: string, state: "active" | "settled" = "active") => q(`chats.${key}.${state}`, () => api.chats(key, { state }), chatListForDevice);

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
  home: [QUERIES.home],
  team: [QUERIES.roster],
  agents: [QUERIES.roster, QUERIES.agents],
  apps: [QUERIES.apps],
  modules: [QUERIES.modules],
  sessions: [QUERIES.sessions],
  decisions: [QUERIES.approvals],
};

/** Pages split off the first download (App.tsx loads them lazily); a hover, or an idle moment after boot, fetches them. */
export const VIEW_CHUNKS = {
  apps: () => import("./Apps"),
  costs: () => import("./Costs"),
  flow: () => import("./Flow"),
  agents: () => import("./Agents"),
  modules: () => import("./Modules"),
  sessions: () => import("./Sessions"),
  agentPage: () => import("./AgentPage"),
  modulePage: () => import("./ModulePage"),
  moduleView: () => import("./ModuleView"),
  run: () => import("./Run"),
  design: () => import("./Design"),
  team: () => import("./Team"),
  teammate: () => import("./Teammate"),
  decisions: () => import("./Decisions"),
};

export function prefetchView(view: string) {
  void VIEW_CHUNKS[view as keyof typeof VIEW_CHUNKS]?.().catch(() => {});
  for (const x of VIEW_QUERIES[view] ?? []) prefetch(x.key, x.fetch, x.persist);
}

/** The page this device opens on is Tasks (or a task over it): the only one that needs the board's inventory at once. */
export function landsOnBoard(): boolean {
  const h = hashPath();
  return h === "tasks" || h.startsWith("tasks?") || h.startsWith("t/");
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
  if (!h || h.startsWith("approvals/")) quiet(load(QUERIES.home.key, QUERIES.home.fetch, false));
  // The other pages' code once the first screen is up, so a tab never waits on a download.
  const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2_000));
  setTimeout(() => idle(() => Object.values(VIEW_CHUNKS).forEach((f) => void f().catch(() => {}))), 3_000);
}
