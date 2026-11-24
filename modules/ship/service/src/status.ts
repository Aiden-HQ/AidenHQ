// Ship's status read (the `ship_status` tool; the Fleet page's view calls it): paused, each listed repo's headline settings and the
// adoptions on hold. Discovered checks, the generator and blockers are added by the loop's lane when discovery exists.
import { effective, presetOf, type Scope } from "./settings.ts";
import type { State } from "./state.ts";

type Dict = Record<string, unknown>;

export function status(raw: Dict, scope: Scope, state: State, repo?: string) {
  const same = (r: string) => !repo || r.toLowerCase() === repo.toLowerCase();
  return {
    paused: raw.paused === true,
    repos: Object.keys((raw.repos as Dict) ?? {}).filter(same).map((r) => { const s = effective(raw, r, scope); return { repo: r, preset: presetOf(raw, r), enabled: !!s?.enabled, handoff: s?.handoff, approve: s?.approve, merge: s?.merge }; }),
    held: state.all().filter((a) => a.hold && same(a.repo)).slice(0, 100),
  };
}
