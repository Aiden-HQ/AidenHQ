// The option catalog (modules/code-review/service/src/catalog.json): every ready-made reviewer a run may pick, by lens and mode, with the
// stack it needs (`when`: path globs on the snapshot; none: always). The service reads it to offer and check a run's options.
// The canonical is the recipe's (recipe/catalog.ts, lane R1); this file follows its interface until it is that file's sync-shared copy.

export type Lens = "correctness" | "security" | "maintainability" | "performance";
export type Mode = "one_off" | "continuous";
/** `name` and `description`: the board's words for the option (a proper name, and what it finds). `needs`: the stack it applies to,
 * said as "Needs <needs>" when the repo lacks it (required with `when`). `unavailable`: why it can't run at all, in the owner's words. */
/** One skill of a skill option: its spec, its arguments (`{base}` is the review's base commit), the skills it loads itself and its
 * whole-repo contract (`tree`: its arguments there, or false: not run there). */
export type SkillRef = { skill: string; args: string; also?: string[]; uncommitted?: boolean; tree?: string | false };
export type Option = {
  id: string; name: string; description: string; lens: Lens; modes: Mode[]; recommended: Mode[]; kind: "tool" | "skill" | "engine";
  source: { repo: string; version: string; licence: string };
  run: { cmd?: string; harness?: string; skills?: SkillRef[]; tools?: string[]; engine?: string; /** exit codes a tool may end with and still have run (default [0]) */ exits?: number[]; /** an engine's own spend cap (deepsec) */ max_cost_usd?: number };
  when: string[]; output: "sarif" | "vulture" | "scc" | "gcc" | "findings"; runs_code: boolean; cost: "free" | "low" | "high"; unavailable?: string; needs?: string; severity?: "nit";
};

const LENSES = ["correctness", "security", "maintainability", "performance"];
const MODES = ["one_off", "continuous"];

/** The catalog's entries, each checked; throws naming the first bad one. */
export function loadCatalog(text: string): Option[] {
  const list = JSON.parse(text) as Option[];
  if (!Array.isArray(list)) throw new Error("the catalog is a list of options");
  const seen = new Set<string>();
  for (const o of list) {
    const bad = (why: string) => { throw new Error(`catalog option ${String(o?.id)}: ${why}`); };
    if (typeof o?.id !== "string" || !/^[a-z]+\.[a-z0-9-]+$/.test(o.id)) bad("id is lens.name");
    if (seen.has(o.id)) bad("id is listed twice");
    seen.add(o.id);
    if (!LENSES.includes(o.lens)) bad(`lens is one of ${LENSES.join(", ")}`);
    if (!Array.isArray(o.modes) || !o.modes.length || !o.modes.every((m) => MODES.includes(m))) bad("modes lists one_off and/or continuous");
    if (!Array.isArray(o.recommended) || !o.recommended.every((m) => o.modes.includes(m))) bad("recommended is a subset of modes");
    if (!["tool", "skill", "engine"].includes(o.kind)) bad("kind is tool, skill or engine");
    if (!o.source?.version || !o.source?.licence) bad("source names its version and licence");
    if (!Array.isArray(o.when)) bad("when is a list of globs");
    if (typeof o.name !== "string" || !o.name.trim() || typeof o.description !== "string" || !o.description.trim()) bad("name and description are the words the board shows");
    if (o.when.length && (typeof o.needs !== "string" || !o.needs.trim())) bad("an option with `when` says what it needs");
  }
  return list;
}

/** A glob as the recipe reads one: `**` any depth, `*` within a folder, `?` one character. */
function globRe(glob: string) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") (i++, (re += "(?:.*/)?"));
      else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Why an option can't run on a repo's paths in `mode`, in the owner's words; undefined when it can. */
export function whyNot(o: Option, paths: string[], mode: Mode): string | undefined {
  if (o.unavailable) return o.unavailable;
  if (!o.modes.includes(mode)) return mode === "one_off" ? "Runs on pull requests only" : "Runs on whole-repo reviews only";
  if (o.when.length && !o.when.map(globRe).some((re) => paths.some((p) => re.test(p)))) return `Needs ${o.needs}`;
  return undefined;
}

/** The options a repo's paths fit for `mode`, and which of them are ticked by default. */
export function detect(paths: string[], catalog: Option[], mode: Mode): { available: Option[]; recommended: string[] } {
  const available = catalog.filter((o) => !whyNot(o, paths, mode));
  return { available, recommended: available.filter((o) => o.recommended.includes(mode)).map((o) => o.id) };
}

/** What a tools check carries per selected tool option (its `options` spec field, by id): just what the recipe runs. */
export type ToolSpec = Record<string, { lens: Lens; cmd: string; output: Exclude<Option["output"], "findings">; severity?: "nit"; exits?: number[]; runs_code: boolean }>;
export function toolSpec(options: Option[]): ToolSpec {
  return Object.fromEntries(options.filter((o) => o.kind === "tool").map((o) => [o.id, { lens: o.lens, cmd: o.run.cmd!, output: o.output as ToolSpec[string]["output"], runs_code: o.runs_code, ...(o.run.exits ? { exits: o.run.exits } : {}), ...(o.severity ? { severity: o.severity } : {}) }]));
}
