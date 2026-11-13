// The board's cached reads (cache.ts): one place names each route's cache key and whether it may be kept on the device,
// so a page and the tab that prefetches it share the same entry.
import { api } from "./api";
import { prefetch, useCached } from "./cache";

export interface Query<T> {
  key: string;
  fetch: () => Promise<T>;
  /** Kept in localStorage across reloads (display data only); false keeps it in memory for this page load. */
  persist: boolean;
}
const q = <T,>(key: string, fetch: () => Promise<T>, persist = true): Query<T> => ({ key, fetch, persist });

export const QUERIES = {
  roster: q("agents.roster", api.roster),
  agents: q("agents", api.agents),
  apps: q("apps", api.apps),
  modules: q("modules", api.modules),
  activity: q("activity.7", () => api.activity(7)),
  // What the owner decides on is never read back from the device: memory only, refetched on every visit.
  approvals: q("approvals", api.approvals, false),
  needsYou: q("needs-you", api.needsYou, false),
};

export const scorecardQuery = (id: string) => q(`agents.${id}.scorecard`, () => api.scorecard(id));

export const useQuery = <T,>(query: Query<T>, onSignIn?: () => void) => useCached(query.key, query.fetch, { persist: query.persist, onSignIn });

/** What each tab reads first, warmed when the tab is hovered or focused. */
const VIEW_QUERIES: Record<string, Query<unknown>[]> = {
  agents: [QUERIES.roster, QUERIES.agents],
  apps: [QUERIES.apps],
  modules: [QUERIES.modules],
  activity: [QUERIES.activity],
  approvals: [QUERIES.approvals, QUERIES.needsYou],
};

export function prefetchView(view: string) {
  for (const x of VIEW_QUERIES[view] ?? []) prefetch(x.key, x.fetch, x.persist);
}
