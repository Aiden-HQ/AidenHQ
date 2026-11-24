// Ship's config tools (role ship-admin), on the module's MCP connection `ship`: `ship_config` reads the effective settings per
// repo, `ship_configure` changes one repo's entry. Built like code-review's: the change is applied to the raw value, the whole
// result validated, and one typed settings change filed as the calling job (POST /v1/settings/agent).
// A change that loosens anything (loosens()) is the owner's: the tool refuses it and the owner makes it from the board.
import { CONTROLS, effective, loosens, PRESETS, validate } from "./settings.ts";
import { status } from "./status.ts";
import type { State } from "./state.ts";

type Dict = Record<string, unknown>;
export interface Tool {
  name: string; description: string; inputSchema: object; roles?: string[];
  run: (args: Dict, caller: { agent: string; roles: string[]; assertion?: string; task?: string }) => Promise<unknown>;
}
export interface Change {
  /** `owner/name`, or `defaults` for the entry every uncovered-by-entry repo takes. */
  repo: string;
  /** A preset name, a map of fields (merged into the entry), or null to remove the entry. */
  change: unknown;
  covered: string[];
  gated?: string[];
}

/** The setting after a change, the summary lines and what it loosens. Throws with an owner-readable reason. */
export function applyShipChange(raw: Dict, c: Change): { value: Dict; summary: string[]; loosens: string[] } {
  const value: Dict = structuredClone(raw ?? {});
  const isDefaults = c.repo === "defaults";
  const repos = (value.repos ??= {}) as Dict;
  const key = isDefaults ? "defaults" : Object.keys(repos).find((k) => k.toLowerCase() === c.repo.toLowerCase()) ?? c.repo;
  const old = isDefaults ? value.defaults : repos[key];
  let next: unknown;
  let summary: string;
  if (c.change === null) { next = undefined; summary = `${c.repo}: back to the defaults`; }
  else if (typeof c.change === "string") { if (!(c.change in PRESETS)) throw new Error(`${c.change} isn't a preset (cautious or full)`); next = c.change; summary = `${c.repo}: ship ${c.change}`; }
  else if (c.change && typeof c.change === "object" && !Array.isArray(c.change)) {
    const base = typeof old === "string" ? { preset: old } : (old as Dict) ?? {};
    next = { ...base, ...(c.change as Dict) };
    summary = `${c.repo}: ${Object.keys(c.change).join(", ")} changed`;
  } else throw new Error("change is a preset name, a map of fields, or null");
  const target = isDefaults ? value : repos;
  const slot = isDefaults ? "defaults" : key;
  if (next === undefined) delete target[slot]; else target[slot] = next;
  const errors = validate(value, c.covered, c.gated);
  if (errors.length) throw new Error(`that setting wouldn't work: ${errors.join("; ")}`);
  return { value, summary: [summary], loosens: loosens(raw, value) };
}

export function configTools(d: {
  raw: () => Dict; covered: () => string[]; gated: () => string[] | undefined; state: State;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
}): Tool[] {
  return [
    {
      name: "ship_config", roles: ["ship-admin"],
      description: "What ship is set to: the raw setting, its problems, the presets, the repos it covers and the effective settings of each listed repo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const raw = d.raw(), covered = d.covered();
        const repos = Object.keys((raw.repos as Dict) ?? {}).map((r) => [r, effective(raw, r, covered)]);
        return { setting: raw, problems: validate(raw, covered, d.gated()), covered, presets: PRESETS, controls: CONTROLS, defaults: effective(raw, "*/*", ["*/*"]), repos: Object.fromEntries(repos) };
      },
    },
    {
      name: "ship_status",
      description: "Ship's status and metrics: paused, the covered repos, each listed repo's headline settings, the adoption counts by status, the open adoptions and per-repo adopted, merged and stalled counts ({ repo? } narrows to one repo). The Fleet page reads it.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, additionalProperties: false },
      run: async (a) => status(d.raw(), d.covered(), d.state, typeof a.repo === "string" ? a.repo : undefined),
    },
    {
      name: "ship_configure", roles: ["ship-admin"],
      description: "Change one repo's ship settings in one reviewed settings change on your task: { repo: owner/name or `defaults`, change: a preset name (cautious | full), a map of the fields to change (handoff, external, rebase, generated { globs, command }, fix, protected, caps { … null = unlimited }, approve, safe, merge, stop_label) or null to drop the entry. Refused whole when the result wouldn't validate. A change that loosens anything (more handoff, a higher or removed cap, a wider approve or fix, a narrower protected list, a generated command, clearing paused) is the owner's: it is refused here and the owner makes it from the Fleet page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, change: {} }, required: ["repo", "change"], additionalProperties: false },
      run: async (a, caller) => {
        const { value, summary, loosens: l } = applyShipChange(d.raw(), { repo: String(a.repo), change: a.change, covered: d.covered(), gated: d.gated() });
        if (l.length) throw new Error(`that change loosens ${l.join(", ")}: the owner's to approve; ask them to make it from the Fleet page`);
        return { filed: await d.file([{ kind: "setting", key: "ship", value }], caller.assertion ?? ""), changes: summary };
      },
    },
  ];
}
