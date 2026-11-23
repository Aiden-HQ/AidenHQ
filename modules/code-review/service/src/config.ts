// settings.code_review (instance.yaml), as the module's service reads it (CODE_REVIEW_SETTINGS, the setting as JSON): the watched
// repos, each with the combos (engine, model, effort) each moment runs. Defaults live
// here and in module.yaml; a repo that doesn't validate is dropped loudly (its error is listed), never half-used.

// The recipe's values (recipe/engines.ts runs the review in its own box: no shared import across that image boundary).
// `models`: the short list the board and the Reviewer Manager offer for each (any other OpenRouter id may be typed; the gateway
// refuses one OpenRouter doesn't list).
export const ENGINES = {
  codex: { label: "Codex", efforts: ["minimal", "low", "medium", "high", "xhigh"],
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "deepseek/deepseek-v4-pro", "z-ai/glm-5.3"] },
  "claude-code": { label: "Claude Code", efforts: ["low", "medium", "high", "xhigh", "max"],
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5"] },
  codegenie: { label: "Codegenie", efforts: ["low", "medium", "high", "xhigh", "max"],
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "z-ai/glm-5.3"] },
  "codex-native": { label: "Codex review", efforts: ["minimal", "low", "medium", "high", "xhigh"],
    models: ["openai/gpt-6.2-sol", "~openai/gpt-terra-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "~deepseek/deepseek-flash-latest"] },
} as const;
export type Engine = keyof typeof ENGINES;

/** One review run's reviewer: its engine, model and effort, and whether it is mandatory: a mandatory combo's review gates the repo's merges (the
 * merge queue merges a PR only when its mandatory combos reviewed its head and none of their important findings is open). */
export type Combo = { engine: Engine; model: string; effort: string; mandatory: boolean };
/** The moments a repo is reviewed at. */
export const MOMENTS = ["on_open", "on_push"] as const;
export type Repo = {
  repo: string;
  /** The combos run when a PR opens (or leaves draft), and on each push (only the new changes); each posts its own review. []: none. */
  on_open: Combo[]; on_push: Combo[];
  /** How many pushes of a PR get an on_push review (a round: a pushed head whose on_push review completed); later heads are gated
   * like a repo with no mandatory on_push (engine.ts openOnlyPr). null: every push. */
  push_rounds: number | null;
  drafts: boolean;
  /** manual: a fork PR is reviewed only when someone with write access asks; auto: like any other. */
  forks: "manual" | "auto";
  ignore: string[]; max_nits: number;
};
export type Config = { repos: Repo[]; errors: string[] };

export const DEFAULT_MODEL = "~deepseek/deepseek-flash-latest";
export const REPO_DEFAULTS: Omit<Repo, "repo"> = {
  on_open: [{ engine: "codex", model: DEFAULT_MODEL, effort: "medium", mandatory: false }],
  on_push: [{ engine: "codex-native", model: "openai/gpt-6.2-sol", effort: "low", mandatory: false }],
  push_rounds: 1,
  drafts: false, forks: "manual", ignore: [], max_nits: 5,
};
/** A repo is gated (its merges wait for code review) when any of its combos is mandatory. */
/** A gated repo whose on_push has no mandatory combo: the PR's opening review stands for every later head (engine.ts gateRuns). */
export const openOnly = (r: Pick<Repo, "on_open" | "on_push">) => r.on_open.some((c) => c.mandatory) && !r.on_push.some((c) => c.mandatory);
export const gated = (r: Pick<Repo, "on_open" | "on_push">) => [...r.on_open, ...r.on_push].some((c) => c.mandatory);
/** The most combos one moment (or one ask) runs. */
export const MAX_COMBOS = 4;

const SLUG = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const MODEL = /^~?[\w.-]+\/[\w.:~-]+$/;
const num = (v: unknown, d: number, min = 0, max = 100_000) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : v === undefined ? d : NaN);

/** A combo checked whole (engine, model and effort together): the combo, or why not. */
export function combo(raw: unknown): Combo | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "a combo is { engine, model, effort }" };
  const c = raw as Record<string, unknown>;
  const extra = Object.keys(c).filter((k) => !["engine", "model", "effort", "mandatory"].includes(k));
  if (extra.length) return { error: `unknown field ${extra.join(", ")} (a combo is engine, model, effort and optionally mandatory)` };
  const e = ENGINES[c.engine as Engine];
  if (!e) return { error: `engine is one of ${Object.keys(ENGINES).join(", ")}` };
  if (typeof c.model !== "string" || !MODEL.test(c.model)) return { error: "model is an OpenRouter model id such as ~deepseek/deepseek-flash-latest" };
  if (!(e.efforts as readonly string[]).includes(c.effort as string)) return { error: `effort for ${c.engine} is one of ${e.efforts.join(", ")}` };
  if (c.mandatory !== undefined && typeof c.mandatory !== "boolean") return { error: "mandatory is true or false" };
  return { engine: c.engine as Engine, model: c.model, effort: c.effort as string, mandatory: c.mandatory === true };
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
  if ("on_risk" in r) return { error: "on_risk is gone: a deeper review is asked for with Review again or `aiden review`" };
  if ("mandatory" in r) return { error: "a repo's mandatory is gone: mark the combos whose review gates merges `mandatory: true`" };
  const out = { ...REPO_DEFAULTS, ...r, repo: r.repo.toLowerCase() } as Repo;
  for (const k of MOMENTS) {
    const c = combos(out[k], k);
    if ("error" in c) return c;
    out[k] = c;
  }
  if (typeof out.drafts !== "boolean") return { error: "drafts is true or false" };
  // A mandatory on_push combo needs one in on_open (a PR's first head is reviewed by on_open's). on_push without one is fine: the
  // opening review then stands for every later head, and the findings still open decide.
  if (out.on_push.some((c) => c.mandatory) && !out.on_open.some((c) => c.mandatory)) return { error: "a mandatory on_push combo needs a mandatory on_open one (a PR's first head is reviewed by on_open's)" };
  if (out.push_rounds !== null && !(Number.isInteger(out.push_rounds) && out.push_rounds >= 0 && out.push_rounds <= 100)) return { error: "push_rounds is a whole number of pushes reviewed (0 to 100), or null for every push" };
  if (!["manual", "auto"].includes(out.forks)) return { error: "forks is manual or auto" };
  if (Number.isNaN(num(out.max_nits, 0))) return { error: "max_nits is a number" };
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
  return { repos, errors };
}
