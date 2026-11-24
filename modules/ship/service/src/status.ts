// Ship's status read (the `ship_status` tool; the Fleet page's view calls it): paused, each listed repo's headline settings and the
// adoptions on hold. Discovered checks, the generator and blockers are added by the loop's lane when discovery exists.
import { effective, presetOf, type Scope } from "./settings.ts";
import type { State } from "./state.ts";

type Dict = Record<string, unknown>;

export function status(raw: Dict, scope: Scope, state: State, repo?: string) {
  const same = (r: string) => !repo || r.toLowerCase() === repo.toLowerCase();
  return {
    paused: raw.paused === true,
    // Every repo ship works that has a row to control: those with an entry, and the fleet's named repos (the product repo) that inherit the defaults.
    repos: [...new Set([...Object.keys((raw.repos as Dict) ?? {}), ...scope.fleet.filter((f) => !f.includes("*"))])].filter(same).map((r) => {
      const s = effective(raw, r, scope), entry = Object.entries((raw.repos as Dict) ?? {}).find(([k]) => k.toLowerCase() === r.toLowerCase())?.[1];
      // `over`: the fields this repo's entry sets itself, which a preset change doesn't move.
      return { repo: r, preset: presetOf(raw, r), enabled: !!s?.enabled, handoff: s?.handoff, approve: s?.approve, merge: s?.merge, over: entry && typeof entry === "object" ? Object.keys(entry).filter((k) => k !== "preset") : [] };
    }),
    held: state.all().filter((a) => a.hold && same(a.repo)).slice(0, 100),
  };
}
