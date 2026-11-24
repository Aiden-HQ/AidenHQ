// Ship's status read (the `ship_status` tool; the Fleet page's view calls it): paused, each listed repo's headline settings and the
// adoptions on hold. Discovered checks, the generator and blockers are added by the loop's lane when discovery exists.
import { effective, presetOf, PRESETS, type Scope } from "./settings.ts";
import type { State } from "./state.ts";

type Dict = Record<string, unknown>;
/** The fields an entry sets itself (everything but its preset), for the Fleet page's overridden marks. */
const own = (e: unknown): Dict => (e && typeof e === "object" && !Array.isArray(e) ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== "preset")) : {});

export function status(raw: Dict, scope: Scope, state: State, repo?: string) {
  const same = (r: string) => !repo || r.toLowerCase() === repo.toLowerCase();
  return {
    paused: raw.paused === true,
    // Every repo ship works that has a row to control: those with an entry, and the fleet's named repos (the product repo) that inherit the defaults.
    repos: [...new Set([...Object.keys((raw.repos as Dict) ?? {}), ...scope.fleet.filter((f) => !f.includes("*"))])].filter(same).map((r) => {
      const s = effective(raw, r, scope), entry = Object.entries((raw.repos as Dict) ?? {}).find(([k]) => k.toLowerCase() === r.toLowerCase())?.[1];
      // `over`: the fields this repo's entry sets itself, which a preset change doesn't move.
      return { repo: r, preset: presetOf(raw, r), enabled: !!s?.enabled, handoff: s?.handoff, approve: s?.approve, merge: s?.merge, actions: s?.actions ?? {}, settings: s, own: own(entry), inherits: !(entry && typeof entry === "object" && "preset" in entry) && typeof entry !== "string", over: entry && typeof entry === "object" ? Object.keys(entry).filter((k) => k !== "preset") : [] };
    }),
    // What new and fleet repos inherit (the defaults entry), for the page's Defaults drawer.
    defaults: { preset: presetOf(raw, "*/*"), own: own(raw.defaults), inherits: false, settings: effective(raw, "*/*", { fleet: ["*/*"], listed: [] }) },
    held: state.all().filter((a) => a.hold && same(a.repo)).slice(0, 100),
  };
}
