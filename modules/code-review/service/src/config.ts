// settings.code_review (instance.yaml), as the module's service reads it (CODE_REVIEW_SETTINGS, the setting as JSON): the watched
// repos, each with the combos (engine, model, effort) each moment runs, their caps, and the instance-wide month cap. Defaults live
// here and in module.yaml; a repo that doesn't validate is dropped loudly (its error is listed), never half-used.

// The recipe's values (recipe/engines.ts runs the review in its own box: no shared import across that image boundary).
// `models`: the short list the board and the Reviewer Manager offer for each (any other OpenRouter id may be typed; the gateway
// refuses one models-openrouter doesn't price).
export const ENGINES = {
  codex: { label: "Codex", efforts: ["minimal", "low", "medium", "high", "xhigh"], run_usd: 1,
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "deepseek/deepseek-v4-pro", "z-ai/glm-5.3"] },
  "claude-code": { label: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"], run_usd: 2,
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5"] },
  codegenie: { label: "Codegenie", efforts: ["low", "medium", "high", "xhigh", "max"], run_usd: 1,
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "z-ai/glm-5.3"] },
} as const;
export type Engine = keyof typeof ENGINES;

/** One review run's reviewer: its engine, model and effort, and the most the run may spend (its reservation and its model token's
 * cap; the engine's default when unset: codex and codegenie $1, claude-code $2). */
export type Combo = { engine: Engine; model: string; effort: string; run_usd: number };
/** The moments a repo is reviewed at. */
export const MOMENTS = ["on_open", "on_push"] as const;
export type Repo = {
  repo: string;
  /** The combos run when a PR opens (or leaves draft), and on each push (only the new changes); each posts its own review. []: none. */
  on_open: Combo[]; on_push: Combo[];
  drafts: boolean;
  /** manual: a fork PR is reviewed only when someone with write access asks; auto: like any other. */
  forks: "manual" | "auto";
  month_usd: number; ignore: string[]; max_nits: number;
};
export type Config = { repos: Repo[]; month_usd: number; errors: string[] };

export const DEFAULT_MODEL = "~deepseek/deepseek-flash-latest";
export const REPO_DEFAULTS: Omit<Repo, "repo"> = {
  on_open: [{ engine: "codex", model: DEFAULT_MODEL, effort: "medium", run_usd: 1 }],
  on_push: [{ engine: "codex", model: DEFAULT_MODEL, effort: "low", run_usd: 1 }],
  drafts: false, forks: "manual", month_usd: 50, ignore: [], max_nits: 5,
};
export const INSTANCE_MONTH_USD = 200;
/** The most combos one moment (or one ask) runs. */
export const MAX_COMBOS = 4;

const SLUG = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const MODEL = /^~?[\w.-]+\/[\w.:~-]+$/;
const num = (v: unknown, d: number, min = 0, max = 100_000) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : v === undefined ? d : NaN);

/** A combo checked whole (engine, model and effort together, the run cap filled in): the combo, or why not. */
export function combo(raw: unknown): Combo | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "a combo is { engine, model, effort }" };
  const c = raw as Record<string, unknown>;
  const extra = Object.keys(c).filter((k) => !["engine", "model", "effort", "run_usd"].includes(k));
  if (extra.length) return { error: `unknown field ${extra.join(", ")} (a combo is engine, model, effort and optionally run_usd)` };
  const e = ENGINES[c.engine as Engine];
  if (!e) return { error: `engine is one of ${Object.keys(ENGINES).join(", ")}` };
  if (typeof c.model !== "string" || !MODEL.test(c.model)) return { error: "model is an OpenRouter model id such as ~deepseek/deepseek-flash-latest" };
  if (!(e.efforts as readonly string[]).includes(c.effort as string)) return { error: `effort for ${c.engine} is one of ${e.efforts.join(", ")}` };
  const run_usd = num(c.run_usd, e.run_usd, 0.01, 20);
  if (Number.isNaN(run_usd)) return { error: "run_usd is a number of dollars, 0.01 to 20" };
  return { engine: c.engine as Engine, model: c.model, effort: c.effort as string, run_usd };
}

/** A list of combos (a moment's, or a one-off's): the combos, or the first reason one isn't. */
export function combos(raw: unknown, what: string): Combo[] | { error: string } {
  if (!Array.isArray(raw)) return { error: `${what} is a list of { engine, model, effort } (it was ${typeof raw === "string" ? `"${raw}"` : typeof raw}; named reviewers are gone)` };
  if (raw.length > MAX_COMBOS) return { error: `${what} holds at most ${MAX_COMBOS} combos` };
  const out: Combo[] = [];
  for (const [i, r] of raw.entries()) {
    const c = combo(r);
    if ("error" in c) return { error: `${what}[${i}]: ${c.error}` };
    out.push(c);
  }
  return out;
}

/** A combo's label (the board's and the posts'): engine, model, effort. */
export const label = (c: Pick<Combo, "engine" | "model" | "effort">) => `${c.engine} · ${c.model} · ${c.effort}`;

function repo(raw: unknown): Repo | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.repo !== "string" || !SLUG.test(r.repo)) return { error: "repo is owner/name" };
  if ("on_risk" in r) return { error: "on_risk is gone: a deeper review is asked for with Review again or `@aiden review`" };
  const out = { ...REPO_DEFAULTS, ...r, repo: r.repo.toLowerCase() } as Repo;
  for (const k of MOMENTS) {
    const c = combos(out[k], k);
    if ("error" in c) return c;
    out[k] = c;
  }
  if (typeof out.drafts !== "boolean") return { error: "drafts is true or false" };
  if (!["manual", "auto"].includes(out.forks)) return { error: "forks is manual or auto" };
  for (const k of ["month_usd", "max_nits"] as const) if (Number.isNaN(num(out[k], 0))) return { error: `${k} is a number` };
  if (!Array.isArray(out.ignore) || !out.ignore.every((g) => typeof g === "string" && g.length <= 200)) return { error: "ignore is a list of globs" };
  return out;
}

/** The setting as the service runs it. Bad JSON is the defaults with nothing watched. */
export function readConfig(text: string | undefined): Config {
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try { raw = text?.trim() ? JSON.parse(text) : {}; } catch { errors.push("settings.code_review isn't JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) (raw = {}, errors.push("settings.code_review is a map"));
  if ("reviewers" in raw) errors.push("reviewers are gone: each repo's on_open and on_push list their combos (engine, model, effort); re-save the repo");
  const repos: Repo[] = [];
  const given = Array.isArray(raw.repos) ? raw.repos : [];
  // A repo listed twice is refused whole (neither entry runs): which one counts would be a guess, and the kernel's tiering of an
  // agent's change reads the same list.
  const twice = new Set(given.map((r) => String((r as { repo?: unknown })?.repo ?? "").toLowerCase()).filter((k, i, a) => k && a.indexOf(k) !== i));
  for (const [i, r] of given.entries()) {
    const v = repo(r);
    if ("error" in v) errors.push(`repos[${i}]: ${v.error}`);
    else if (twice.has(v.repo)) errors.push(`repos[${i}]: ${v.repo} is listed more than once`);
    else repos.push(v);
  }
  const month_usd = num(raw.month_usd, INSTANCE_MONTH_USD);
  if (Number.isNaN(month_usd)) errors.push("month_usd is a number");
  return { repos, month_usd: Number.isNaN(month_usd) ? INSTANCE_MONTH_USD : month_usd, errors };
}
