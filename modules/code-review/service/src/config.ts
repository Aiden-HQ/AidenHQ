// settings.code_review (instance.yaml), as the module's service reads it (CODE_REVIEW_SETTINGS, the setting as JSON): the watched
// repos, each with its class, its risk tier rules and the combos (engine, model, effort) each tier runs at each moment (a preset with
// by_tier over it). Defaults live here and in module.yaml; a repo that doesn't validate is dropped loudly (its error is listed),
// never half-used. The one parser: the compile (scripts/modules.ts) and the Fleet page's save call readConfig too.
import { createHash } from "node:crypto";
import { DEFAULT_RULES, parseRules, REPO_CLASSES, selectable, TIERS, type RepoClass, type Rule, type Tier } from "./aidenhq-sdk/tiers.ts";

// The recipe's values (recipe/engines.ts runs the review in its own box: no shared import across that image boundary).
// `models`: the short list the board and the Reviewer Manager offer for each, the "Recommended" group of the board's picker.
// `accepts`: which of OpenRouter's models the engine can run, which filters the picker's full list: `provider` one vendor's
// models only, `tools` models that call tools. The gateway refuses an id OpenRouter doesn't list.
export const ENGINES = {
  codex: { label: "Codex", accepts: { tools: true }, efforts: ["minimal", "low", "medium", "high", "xhigh"],
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "deepseek/deepseek-v4-pro", "z-ai/glm-5.3"] },
  "claude-code": { label: "Claude Code", accepts: { provider: "anthropic" }, efforts: ["low", "medium", "high", "xhigh", "max"],
    models: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-haiku-5.5"] },
  codegenie: { label: "Codegenie", accepts: { tools: true }, efforts: ["low", "medium", "high", "xhigh", "max"],
    models: ["~deepseek/deepseek-flash-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "z-ai/glm-5.3"] },
  "codex-native": { label: "Codex review", accepts: { tools: true }, efforts: ["minimal", "low", "medium", "high", "xhigh"],
    models: ["openai/gpt-6.2-sol", "~openai/gpt-terra-latest", "~openai/gpt-luna-latest", "~openai/gpt-sol-latest", "~deepseek/deepseek-flash-latest"] },
} as const;
export type Engine = keyof typeof ENGINES;

/** One review run's reviewer: its engine, model and effort, and whether it is mandatory: a mandatory combo's review gates the repo's merges (the
 * merge queue merges a PR only when its mandatory combos reviewed its head and none of their important findings is open). */
export type Combo = { engine: Engine; model: string; effort: string; mandatory: boolean };
/** The moments a PR is reviewed at. */
export const MOMENTS = ["on_open", "on_push"] as const;
/** What one tier runs: the combos when a PR opens (or its tier changes) and on each push, and how many pushes get one. */
export type TierCfg = {
  /** The combos run when a PR opens (or leaves draft, or enters this tier), and on each push (only the new changes); each posts its own review. []: none. */
  on_open: Combo[]; on_push: Combo[];
  /** How many pushes of a PR in this tier get an on_push review (a round: a pushed head whose on_push review completed); later heads
   * are gated like a tier with no mandatory on_push (engine.ts openOnlyPr). null: every push. */
  push_rounds: number | null;
};
/** A watched repo as the service runs it: its class and tier rules (the risk tiers, aidenhq-sdk/tiers.ts), what each tier runs (its
 * preset with by_tier over it), and the repo-level fields. */
export type Entry = {
  repo: string; preset: Preset; repo_class: RepoClass;
  /** The rules (the default ones unless the entry lists its own: `custom`). */
  rules: Rule[]; custom: boolean;
  tiers: Record<Tier, TierCfg>;
  drafts: boolean;
  /** manual: a fork PR is reviewed only when someone with write access asks; auto: like any other. */
  forks: "manual" | "auto";
  ignore: string[]; max_nits: number;
  /** A hash of what classifies a PR (class and rules): a stored tier computed under another is stale (pending). */
  hash: string;
};
/** One tier of an entry in the shape the engine reviews with (tierCfg). */
export type Repo = TierCfg & Pick<Entry, "repo" | "drafts" | "forks" | "ignore" | "max_nits"> & { tier: Tier };
export type Config = { repos: Entry[]; errors: string[] };

export const DEFAULT_MODEL = "~deepseek/deepseek-flash-latest";
const SOL = "openai/gpt-6.2-sol";
const m = (engine: Engine, model: string, effort: string): Combo => ({ engine, model, effort, mandatory: true });
const NONE: TierCfg = { on_open: [], on_push: [], push_rounds: 0 };
/** The presets a repo starts from (`preset`, default standard): what each tier runs. Every combo is mandatory (ship approves only on a
 * review that covers the head); a repo that wants advice turns mandatory off per combo in by_tier. */
export const PRESETS = {
  light: {
    skip: NONE,
    trivial: { on_open: [m("codex", DEFAULT_MODEL, "low")], on_push: [], push_rounds: 0 },
    standard: { on_open: [m("codex", DEFAULT_MODEL, "medium")], on_push: [], push_rounds: 0 },
    sensitive: { on_open: [m("codex-native", SOL, "medium")], on_push: [m("codex-native", SOL, "low")], push_rounds: 1 },
  },
  standard: {
    skip: NONE,
    trivial: { on_open: [m("codex", DEFAULT_MODEL, "medium")], on_push: [], push_rounds: 0 },
    standard: { on_open: [m("codex", DEFAULT_MODEL, "medium")], on_push: [m("codex-native", SOL, "low")], push_rounds: 1 },
    sensitive: { on_open: [m("codex-native", SOL, "medium"), m("claude-code", "anthropic/claude-sonnet-5.5", "medium")], on_push: [m("codex-native", SOL, "low")], push_rounds: 2 },
  },
  thorough: {
    skip: NONE,
    trivial: { on_open: [m("codex", DEFAULT_MODEL, "medium")], on_push: [m("codex-native", SOL, "low")], push_rounds: 1 },
    standard: { on_open: [m("codex-native", SOL, "medium"), m("codex", DEFAULT_MODEL, "medium")], on_push: [m("codex-native", SOL, "low")], push_rounds: 2 },
    sensitive: { on_open: [m("codex-native", SOL, "high"), m("claude-code", "anthropic/claude-sonnet-5.5", "high")], on_push: [m("codex-native", SOL, "medium")], push_rounds: 3 },
  },
} satisfies Record<string, Record<Tier, TierCfg>>;
export type Preset = keyof typeof PRESETS;
export const REPO_DEFAULTS = { preset: "standard" as Preset, repo_class: "standard" as RepoClass, drafts: false, forks: "manual" as const, ignore: [] as string[], max_nits: 5 };

/** One tier of an entry, as the engine reviews with it. */
export const tierCfg = (e: Entry, tier: Tier): Repo => ({ repo: e.repo, drafts: e.drafts, forks: e.forks, ignore: e.ignore, max_nits: e.max_nits, tier, ...e.tiers[tier] });
/** A tier gates merges when any of its combos is mandatory. */
export const gated = (t: Pick<TierCfg, "on_open" | "on_push">) => [...t.on_open, ...t.on_push].some((c) => c.mandatory);
/** A gated tier whose on_push has no mandatory combo: the PR's opening review stands for every later head (engine.ts gateRuns). */
export const openOnly = (t: Pick<TierCfg, "on_open" | "on_push">) => t.on_open.some((c) => c.mandatory) && !t.on_push.some((c) => c.mandatory);
/** Some tier the repo's rules can select gates: its PRs get the commit status and their answers are read. */
export const gatesAny = (e: Entry) => selectable(e.rules).some((t) => gated(e.tiers[t]));
/** Every tier a head can get gates: the AI reviewer may leave its agents' pushes to code review. Those the rules name, and sensitive,
 * which a PR over GitHub's 3,000-file list gets whatever the rules say. */
export const gatesAll = (e: Entry) => [...selectable(e.rules), "sensitive" as Tier].every((t) => gated(e.tiers[t]));
/** A head's review policy: everything about how it is reviewed (its tier, the tier's mandatory combos, the base branch and the ignore
 * globs), never a commit. Runs and coverage count for a head only under its current policy. */
export const policyOf = (e: Entry, tier: Tier, base_ref: string) => createHash("sha256").update(JSON.stringify([tier,
  MOMENTS.flatMap((k) => e.tiers[tier][k].filter((c) => c.mandatory).map((c) => [k, c.engine, c.model, c.effort])), base_ref, e.ignore])).digest("hex").slice(0, 16);
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

const OLD = "on_open, on_push and push_rounds are per tier now: by_tier.<tier>.… (see the Reviews page)";
const ENTRY_FIELDS = ["repo", "preset", "repo_class", "rules", "by_tier", "drafts", "forks", "ignore", "max_nits"];

/** One tier's own fields over its preset's: the tier, or why not. */
function tier(name: Tier, base: TierCfg, raw: unknown): TierCfg | { error: string } {
  const at = `by_tier.${name}`;
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: `${at} is { on_open?, on_push?, push_rounds? }` };
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !["on_open", "on_push", "push_rounds"].includes(k));
  if (extra.length) return { error: `${at}: unknown field ${extra.join(", ")}` };
  if (name === "skip" && Object.keys(r).length) return { error: "by_tier.skip runs no review: point the rules at another tier instead" };
  const out: TierCfg = { ...base };
  for (const k of MOMENTS) if (r[k] !== undefined) {
    const c = combos(r[k], `${at}.${k}`);
    if ("error" in c) return c;
    out[k] = c;
  }
  if (r.push_rounds !== undefined) out.push_rounds = r.push_rounds as number | null;
  // A mandatory on_push combo needs one in on_open (a PR's first head in the tier is reviewed by on_open's). on_push without one is
  // fine: the opening review then stands for every later head, and the findings still open decide.
  if (out.on_push.some((c) => c.mandatory) && !out.on_open.some((c) => c.mandatory)) return { error: `${at}: a mandatory on_push combo needs a mandatory on_open one (a PR's first head in the tier is reviewed by on_open's)` };
  if (out.push_rounds !== null && !(Number.isInteger(out.push_rounds) && out.push_rounds >= 0 && out.push_rounds <= 100)) return { error: `${at}.push_rounds is a whole number of pushes reviewed (0 to 100), or null for every push` };
  return out;
}

function repo(raw: unknown): Entry | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.repo !== "string" || !SLUG.test(r.repo)) return { error: "repo is owner/name" };
  if (MOMENTS.some((k) => k in r) || "push_rounds" in r) return { error: OLD };
  if ("on_risk" in r) return { error: "on_risk is gone: a deeper review is asked for with Review again or `aiden review`" };
  if ("mandatory" in r) return { error: "a repo's mandatory is gone: mark the combos whose review gates merges `mandatory: true`" };
  const extra = Object.keys(r).filter((k) => !ENTRY_FIELDS.includes(k));
  if (extra.length) return { error: `unknown field ${extra.join(", ")}` };
  const o = { ...REPO_DEFAULTS, ...r } as typeof REPO_DEFAULTS & Record<string, unknown>;
  if (!Object.hasOwn(PRESETS, o.preset)) return { error: `preset is one of ${Object.keys(PRESETS).join(", ")}` };
  if (!REPO_CLASSES.includes(o.repo_class)) return { error: `repo_class is one of ${REPO_CLASSES.join(", ")}` };
  const rules = r.rules === undefined ? DEFAULT_RULES : parseRules(r.rules);
  if ("error" in rules) return rules;
  const by = (r.by_tier ?? {}) as Record<string, unknown>;
  if (typeof by !== "object" || Array.isArray(by)) return { error: "by_tier is a map of tier to { on_open?, on_push?, push_rounds? }" };
  const unknown = Object.keys(by).filter((k) => !TIERS.includes(k as Tier));
  if (unknown.length) return { error: `by_tier: unknown tier ${unknown.join(", ")} (one of ${TIERS.join(", ")})` };
  const tiers = {} as Record<Tier, TierCfg>;
  for (const t of TIERS) {
    const v = tier(t, PRESETS[o.preset][t], by[t]);
    if ("error" in v) return v;
    tiers[t] = v;
  }
  if (typeof o.drafts !== "boolean") return { error: "drafts is true or false" };
  if (!["manual", "auto"].includes(o.forks)) return { error: "forks is manual or auto" };
  if (Number.isNaN(num(o.max_nits, 0))) return { error: "max_nits is a number" };
  if (!Array.isArray(o.ignore) || !o.ignore.every((g) => typeof g === "string" && g.length <= 200)) return { error: "ignore is a list of globs" };
  const hash = createHash("sha256").update(JSON.stringify([o.repo_class, rules])).digest("hex").slice(0, 16);
  return { repo: r.repo.toLowerCase(), preset: o.preset, repo_class: o.repo_class, rules, custom: r.rules !== undefined, tiers, drafts: o.drafts, forks: o.forks, ignore: o.ignore, max_nits: o.max_nits, hash };
}

/** The setting as the service runs it. Bad JSON is the defaults with nothing watched. */
export function readConfig(text: string | undefined): Config {
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try { raw = text?.trim() ? JSON.parse(text) : {}; } catch { errors.push("settings.code_review isn't JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) (raw = {}, errors.push("settings.code_review is a map"));
  if ("reviewers" in raw) errors.push("reviewers are gone: each repo's by_tier lists its combos (engine, model, effort); re-save the repo");
  const repos: Entry[] = [];
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
