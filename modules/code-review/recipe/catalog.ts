// The option catalog (modules/code-review/service/src/catalog.json): every ready-made reviewer a run can tick, one entry per upstream tool,
// skill or engine. Shared by the review recipe (tools.ts reads the tool entries a check's spec carries) and the state service
// (what the board offers for a repo, and the spec of the tools check). We write no reviewer prompts: an option runs its upstream
// command, skill or engine as shipped, pinned in the engineer image, and its output is mapped to findings (sarif.ts).
import { globRe } from "./review-checklist.ts";

export const LENSES = ["correctness", "security", "maintainability", "performance"] as const;
export const MODES = ["one_off", "continuous"] as const;
export const KINDS = ["tool", "skill", "engine"] as const;
/** How a tool's output is read: SARIF, a named JSON/text mapper (sarif.ts), or `findings` (a skill or engine restates its own). */
export const OUTPUTS = ["sarif", "knip", "jscpd", "vulture", "scc", "gcc", "findings"] as const;
export type Lens = (typeof LENSES)[number];
export type Mode = (typeof MODES)[number];

/**
 * One option. `recommended`: the modes it is ticked by default in (a subset of `modes`). `when`: file globs (the recipe's globRe,
 * over the snapshot's paths); none means always. `run`: a tool's shell command (run in the checkout copy, its stdout is the
 * output) and `exits`, the exit codes of a finished scan (default [0]; a scanner's "found something" code too: any other code is a
 * failed tool, report or not), a skill's harness and `skills` (specs, run in order in one session; engines.ts parseSkill), or an engine's id. `runs_code`:
 * the tool can run the repo's code (a JS config it imports): only a tool, never on a fork's PR, after the others (tools.ts). `severity: "nit"` caps a tool whose
 * output marks everything an error (ruff, fallow); `hidden` options are never offered. `source.version` is the pin: a release tag,
 * package version or commit.
 */
export interface Option {
  id: string; lens: Lens; modes: Mode[]; recommended: Mode[]; kind: (typeof KINDS)[number];
  source: { repo: string; version: string; licence: string };
  run: { cmd?: string; exits?: number[]; harness?: string; skills?: string[]; engine?: string };
  when: string[]; output: (typeof OUTPUTS)[number]; runs_code: boolean; cost: "free" | "low" | "high"; hidden?: boolean; severity?: "nit";
}

const bad = (id: unknown, why: string): never => { throw new Error(`catalog entry ${String(id)}: ${why}`); };
const text = (v: unknown, n = 300) => typeof v === "string" && v.trim() !== "" && v.length <= n;
const subset = (a: unknown, of: readonly string[]) => Array.isArray(a) && a.every((x) => of.includes(x)) && new Set(a).size === a.length;

/** The catalog from its JSON text; throws on a bad entry (a missing field, an unknown lens, a duplicate id, an unpinned source). */
export function loadCatalog(source: string): Option[] {
  const list = JSON.parse(source);
  if (!Array.isArray(list)) throw new Error("the catalog is a list of options");
  const seen = new Set<string>();
  for (const o of list) {
    const id = o?.id;
    if (typeof id !== "string" || !/^(cor|sec|maint|perf)\.[a-z0-9-]+$/.test(id)) bad(id, "id is <lens prefix>.<name>");
    if (seen.has(id)) bad(id, "duplicate id");
    seen.add(id);
    if (!LENSES.includes(o.lens)) bad(id, "unknown lens");
    if (!subset(o.modes, MODES) || !o.modes.length) bad(id, "modes lists one_off and/or continuous");
    if (!subset(o.recommended, o.modes)) bad(id, "recommended is within modes");
    if (!KINDS.includes(o.kind)) bad(id, "unknown kind");
    if (!text(o.source?.repo) || !text(o.source?.version) || !text(o.source?.licence)) bad(id, "source needs repo, a pinned version and a licence");
    if (!OUTPUTS.includes(o.output)) bad(id, "unknown output");
    const run = o.run ?? {};
    if (o.kind === "tool" ? !text(run.cmd, 2000) || o.output === "findings" : o.output !== "findings" || (o.kind === "skill" ? !text(run.harness) || !(Array.isArray(run.skills) && run.skills.length && run.skills.every((x: unknown) => text(x))) : !text(run.engine))) bad(id, `${o.kind} has the run fields (and the output) its kind takes`);
    if (!Array.isArray(o.when) || o.when.some((g: unknown) => !text(g))) bad(id, "when is a list of globs");
    if (run.exits !== undefined && (o.kind !== "tool" || !Array.isArray(run.exits) || !run.exits.length || run.exits.some((c: unknown) => !Number.isInteger(c) || (c as number) < 0 || (c as number) > 255))) bad(id, "exits is a tool's list of exit codes");
    if (o.runs_code === true && o.kind !== "tool") bad(id, "only a tool option runs repo code (runs_code)");
    if (typeof o.runs_code !== "boolean" || !["free", "low", "high"].includes(o.cost)) bad(id, "runs_code is a boolean and cost is free, low or high");
    if (o.severity !== undefined && o.severity !== "nit") bad(id, "severity is nit or absent");
  }
  return list;
}

/** The options a repo's paths fit (hidden ones never) and, of those, the ticked-by-default ids for `mode`. */
export function detect(paths: string[], catalog: Option[], mode: Mode): { available: Option[]; recommended: string[] } {
  const available = catalog.filter((o) => !o.hidden && o.modes.includes(mode) && (o.when.length === 0 || o.when.map(globRe).some((re) => paths.some((p) => re.test(p)))));
  return { available, recommended: available.filter((o) => o.recommended.includes(mode)).map((o) => o.id) };
}

/** What a tools check carries per selected tool option (the check's `options` spec field, a JSON object by id): just what the
 * recipe runs, since the catalog file isn't in the box. */
export type ToolSpec = Record<string, { lens: Lens; cmd: string; output: Exclude<Option["output"], "findings">; severity?: "nit"; exits?: number[]; runs_code?: true }>;
export function toolSpec(options: Option[]): ToolSpec {
  return Object.fromEntries(options.filter((o) => o.kind === "tool").map((o) => [o.id, {
    lens: o.lens, cmd: o.run.cmd!, output: o.output as ToolSpec[string]["output"],
    ...(o.severity ? { severity: o.severity } : {}), ...(o.run.exits ? { exits: o.run.exits } : {}), ...(o.runs_code ? { runs_code: true as const } : {}),
  }]));
}
