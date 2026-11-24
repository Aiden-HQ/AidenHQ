// Ship's status and metrics read, shared by the HTTP API and the `ship_status` tool (the Fleet page's view calls the tool).
import { effective } from "./settings.ts";
import { STATUSES, type State } from "./state.ts";

type Dict = Record<string, unknown>;

/** Paused, the covered repos, each listed repo's headline settings, and the adoption records by status and by repo. */
export function status(raw: Dict, covered: string[], state: State, repo?: string) {
  const mine = state.all().filter((a) => !repo || a.repo.toLowerCase() === repo.toLowerCase());
  const by = new Map<string, { adopted: number; merged: number; stalled: number }>();
  for (const a of mine) {
    const m = by.get(a.repo) ?? { adopted: 0, merged: 0, stalled: 0 };
    m.adopted++; if (a.status === "merged") m.merged++; if (a.status === "stalled") m.stalled++;
    by.set(a.repo, m);
  }
  return {
    paused: raw.paused === true, covered,
    repos: Object.keys((raw.repos as Dict) ?? {}).filter((r) => !repo || r.toLowerCase() === repo.toLowerCase()).map((r) => { const s = effective(raw, r, covered); return { repo: r, handoff: s?.handoff, approve: s?.approve, merge: s?.merge }; }),
    adoptions: Object.fromEntries(STATUSES.map((s) => [s, mine.filter((a) => a.status === s).length])),
    // Rounds, cost and time to merge arrive with the loop's flow facts.
    metrics: [...by].map(([r, m]) => ({ repo: r, ...m, merges_per_adoption: m.adopted ? m.merged / m.adopted : null })),
    open: mine.filter((a) => !["merged", "handed_back", "stopped"].includes(a.status)).slice(0, 100),
  };
}
