// settings.code_review (instance.yaml), as the module's service reads it (CODE_REVIEW_SETTINGS, the setting as JSON): the named
// reviewer profiles, the watched repos with their triggers and caps, and the instance-wide month cap. Defaults live here and in
// module.yaml; a profile or repo that doesn't validate is dropped loudly (its error is listed), never half-used.

export const ENGINES = ["codex", "claude-code", "codegenie"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Engine = (typeof ENGINES)[number];

/** A reviewer: a whole profile (engine, model, effort, finders, verification and its model, extra context, a focus). */
export type Profile = {
  engine: Engine; model: string; effort: (typeof EFFORTS)[number]; finders: number; verify: boolean;
  verifier?: string; context?: string[]; focus?: string; label?: string;
  /** The most one run of this reviewer may spend, finders, verifier and retries together: the budget reserved before it starts
   * and the cap on its box's model token. Default: $0.50 a finder, $0.50 more to verify. */
  run_usd: number;
};
export type Repo = {
  repo: string;
  /** The reviewer on a new PR (and one leaving draft); on every push (incremental); on a PR the triage reviewer calls high-risk. "off": none. */
  on_open: string; on_push: string; on_risk: string;
  drafts: boolean;
  /** manual: a fork PR is reviewed only when someone with write access asks; auto: like any other. */
  forks: "manual" | "auto";
  month_usd: number; ignore: string[]; max_nits: number;
  /** Automatic runs a day, per PR author and per repo: past either, a PR waits for someone to ask. */
  per_author_day: number; per_repo_day: number;
};
export type Config = { reviewers: Record<string, Profile>; repos: Repo[]; month_usd: number; errors: string[] };

export const DEFAULT_REVIEWERS: Record<string, Profile> = {
  quick: { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "low", finders: 1, verify: false, run_usd: 0.5 },
  standard: { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "high", finders: 2, verify: true, run_usd: 1.5 },
  deep: { engine: "codex", model: "~openai/gpt-sol-latest", effort: "high", finders: 4, verify: true, verifier: "~anthropic/claude-latest", run_usd: 2.5 },
  triage: { engine: "codex", model: "~deepseek/deepseek-flash-latest", effort: "low", finders: 1, verify: false, focus: "triage", run_usd: 0.5 },
};
export const REPO_DEFAULTS: Omit<Repo, "repo"> = {
  on_open: "standard", on_push: "quick", on_risk: "deep", drafts: false, forks: "manual", month_usd: 50, ignore: [], max_nits: 5, per_author_day: 10, per_repo_day: 60,
};
export const INSTANCE_MONTH_USD = 200;
/** The reviewer the triage step runs, when the profiles have one. */
export const TRIAGE = "triage";
export const OFF = "off";

const SLUG = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const NAME = /^[a-z][a-z0-9_-]{0,30}$/;
const MODEL = /^~?[\w.-]+\/[\w.:-]+$/;
const PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w./*-]{1,200}$/;
const num = (v: unknown, d: number, min = 0, max = 100_000) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : v === undefined ? d : NaN);

/** A profile checked whole (engine, model and effort together): the profile, or why not. */
export function profile(raw: unknown): Profile | { error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "a reviewer is a map" };
  const known = ["engine", "model", "effort", "finders", "verify", "verifier", "context", "focus", "label", "run_usd"];
  const extra = Object.keys(p).filter((k) => !known.includes(k));
  if (extra.length) return { error: `unknown field ${extra.join(", ")} (known: ${known.join(", ")})` };
  if (!ENGINES.includes(p.engine as Engine)) return { error: `engine is one of ${ENGINES.join(", ")}` };
  if (typeof p.model !== "string" || !MODEL.test(p.model)) return { error: "model is a model id such as ~deepseek/deepseek-flash-latest" };
  if (!EFFORTS.includes(p.effort as (typeof EFFORTS)[number])) return { error: `effort is one of ${EFFORTS.join(", ")}` };
  if (!Number.isInteger(p.finders) || (p.finders as number) < 1 || (p.finders as number) > 8) return { error: "finders is 1 to 8" };
  if (typeof p.verify !== "boolean") return { error: "verify is true or false" };
  if (p.verifier !== undefined && (typeof p.verifier !== "string" || !MODEL.test(p.verifier))) return { error: "verifier is a model id" };
  if (p.verifier !== undefined && !p.verify) return { error: "a verifier needs verify: true" };
  if (p.context !== undefined && !(Array.isArray(p.context) && p.context.length <= 20 && p.context.every((c) => typeof c === "string" && PATH.test(c)))) return { error: "context is a list of repo paths" };
  if (p.focus !== undefined && (typeof p.focus !== "string" || p.focus.length > 500)) return { error: "focus is a short text" };
  if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 60)) return { error: "label is a short name" };
  const run_usd = num(p.run_usd, 0.5 * (p.finders as number) + (p.verify ? 0.5 : 0), 0.01, 100);
  if (Number.isNaN(run_usd)) return { error: "run_usd is a number of dollars, 0.01 to 100" };
  const out: Profile = { engine: p.engine as Engine, model: p.model, effort: p.effort as Profile["effort"], finders: p.finders as number, verify: p.verify, run_usd };
  for (const k of ["verifier", "context", "focus", "label"] as const) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

function repo(raw: unknown, reviewers: Record<string, Profile>): Repo | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.repo !== "string" || !SLUG.test(r.repo)) return { error: "repo is owner/name" };
  const out = { ...REPO_DEFAULTS, ...r, repo: r.repo.toLowerCase() } as Repo;
  for (const k of ["on_open", "on_push", "on_risk"] as const) if (out[k] !== OFF && !reviewers[out[k]]) return { error: `${k} names no reviewer (${Object.keys(reviewers).join(", ")}, or off)` };
  if (typeof out.drafts !== "boolean") return { error: "drafts is true or false" };
  if (!["manual", "auto"].includes(out.forks)) return { error: "forks is manual or auto" };
  for (const k of ["month_usd", "max_nits", "per_author_day", "per_repo_day"] as const) if (Number.isNaN(num(out[k], 0))) return { error: `${k} is a number` };
  if (!Array.isArray(out.ignore) || !out.ignore.every((g) => typeof g === "string" && g.length <= 200)) return { error: "ignore is a list of globs" };
  return out;
}

/** The setting as the service runs it. Bad JSON is the defaults with nothing watched. */
export function readConfig(text: string | undefined): Config {
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try { raw = text?.trim() ? JSON.parse(text) : {}; } catch { errors.push("settings.code_review isn't JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) (raw = {}, errors.push("settings.code_review is a map"));
  const reviewers: Record<string, Profile> = {};
  const given = { ...DEFAULT_REVIEWERS, ...((raw.reviewers as object) ?? {}) } as Record<string, unknown>;
  for (const [name, p] of Object.entries(given)) {
    if (p === null) continue; // a default switched off
    const v = NAME.test(name) ? profile(p) : { error: "a reviewer's name is lowercase letters, digits, - and _" };
    if ("error" in v) errors.push(`reviewers.${name}: ${v.error}`);
    else reviewers[name] = v;
  }
  const repos: Repo[] = [];
  const given_repos = Array.isArray(raw.repos) ? raw.repos : [];
  // A repo listed twice is refused whole (neither entry runs): which one counts would be a guess, and the kernel's tiering of an
  // agent's change reads the same list.
  const twice = new Set(given_repos.map((r) => String((r as { repo?: unknown })?.repo ?? "").toLowerCase()).filter((k, i, a) => k && a.indexOf(k) !== i));
  for (const [i, r] of given_repos.entries()) {
    const v = repo(r, reviewers);
    if ("error" in v) errors.push(`repos[${i}]: ${v.error}`);
    else if (twice.has(v.repo)) errors.push(`repos[${i}]: ${v.repo} is listed more than once`);
    else repos.push(v);
  }
  const month_usd = num(raw.month_usd, INSTANCE_MONTH_USD);
  if (Number.isNaN(month_usd)) errors.push("month_usd is a number");
  return { reviewers, repos, month_usd: Number.isNaN(month_usd) ? INSTANCE_MONTH_USD : month_usd, errors };
}
