// Ship's status and metrics read, shared by the HTTP API and the `ship_status` tool (the Fleet page's view calls the tool).
import { effective } from "./settings.ts";
import { HOLDS, type State } from "./state.ts";

type Dict = Record<string, unknown>;
/** Read-only facts the page shows per repo: the checks and generator ship discovered and what blocks a merge. Discovery arrives with the loop. */
const FACTS = { checks: null, generator: null, blockers: [] as string[] };

/** Paused, the covered repos, each listed repo's headline settings, and the adoption records by status and by repo. */
export function status(raw: Dict, covered: string[], state: State, repo?: string) {
  const mine = state.all().filter((a) => !repo || a.repo.toLowerCase() === repo.toLowerCase());
  const by = new Map<string, { adopted: number; held: number }>();
  for (const a of mine) {
    const m = by.get(a.repo) ?? { adopted: 0, held: 0 };
    m.adopted++; if (a.hold) m.held++;
    by.set(a.repo, m);
  }
  return {
    paused: raw.paused === true, covered,
    repos: Object.keys((raw.repos as Dict) ?? {}).filter((r) => !repo || r.toLowerCase() === repo.toLowerCase()).map((r) => { const s = effective(raw, r, covered); return { repo: r, enabled: s?.enabled, handoff: s?.handoff, approve: s?.approve, merge: s?.merge, facts: FACTS }; }),
    adoptions: { total: mine.length, ...Object.fromEntries(HOLDS.map((h) => [h, mine.filter((a) => a.hold?.kind === h).length])) },
    // Merges, rounds, cost and time to merge come from the loop's flow facts (a later lane); the store knows adoptions and holds.
    metrics: [...by].map(([r, m]) => ({ repo: r, ...m })),
    held: mine.filter((a) => a.hold).slice(0, 100),
  };
}
