// `maintainer_repos`, the one list of repos the fleet looks after: the setting as compiled, parsed once here for github-mcp (the
// Maintainer's tools and watcher read), and for the code host's PR watch and merge rules. Each entry's duties are opt-in.
export const AGENT_FIX = "agent-fix";
// The labels of the feature flow, fixed names (not per-repo settings): a feature request awaiting the owner's word, and the
// owner's word that it may be built. Trust is a collaborator's role (maintainer.ts); the owner's login is an admin.
export const FEATURE_LABEL = "feature-request";
export const BUILD_LABEL = "agent-build";
// The roles a repo may trust to vouch for a label: a fixed set in code, never wider than write. A repo's `trusted` picks
// from it (default admin and maintain); triage, read and custom roles never count.
export const TRUST_ROLES = ["admin", "maintain", "write"] as const;
const DEFAULT_TRUSTED = ["admin", "maintain"];
export const TRIAGE = ["off", "new", "new+backlog"] as const;
export const PRESET_NAMES = ["quiet", "triage", "full"] as const;
/** What a preset sets for a repo that doesn't say: its feature-request duty and how much triage it gets. An entry's own field wins. */
export const PRESETS = {
  quiet: { features: false, triage: "off" },
  triage: { features: false, triage: "new" },
  full: { features: true, triage: "new+backlog" },
} as const;
/** What triage may close (the skill `triage` reads the repo's list); anything else it comments on and leaves open. */
export const CLOSE_REASONS = ["duplicate", "invalid", "empty", "incorrect"] as const;
/** Labels that keep an issue out of the resolved-check and the stale-issue sweep, unless the entry names its own. */
export const EXEMPT_LABELS = ["roadmap", "wip", "blocked"];
const KEYS = ["repo", "label", "trusted", "issues", "features", "dependabot", "contributor_prs", "stale_days", "preset", "triage", "triage_cap_per_author_day", "triage_labels", "close", "needs_info_close_days", "stale_issues", "resolved_check"];
const SHAPE = "{ repo, label, trusted, issues, features, dependabot, contributor_prs, stale_days, preset, triage, triage_cap_per_author_day, triage_labels, close, needs_info_close_days, stale_issues, resolved_check }";

export interface MaintainedRepo {
  repo: string;
  owner: string;
  name: string;
  /** The label that asks for a fix. */
  label: string;
  trusted: string[];
  /** Validate `label` issues, hand fixes over and see them through (default on). */
  issues: boolean;
  /** Triage feature requests, and build the ones carrying BUILD_LABEL (default from the preset: off). */
  features: boolean;
  /** Every open Dependabot PR has an Engineer task (default off). */
  dependabot: boolean;
  /** Nudge, then close, quiet human PRs (default off). */
  contributor_prs: boolean;
  /** Quiet days before the nudge, and again before the close; drafts get double. */
  stale_days: number;
  /** The bundle `features` and `triage` default from (default quiet). */
  preset: (typeof PRESET_NAMES)[number];
  /** Whether unlabelled issues are triaged: no, each new one, or each new one and the backlog (default from the preset). */
  triage: (typeof TRIAGE)[number];
  /** The most invalid new issues one author gets triaged in a day (default 5). */
  triage_cap_per_author_day: number;
  /** Whether triage may add labels (the fix label, feature-request) rather than only comment (default true). */
  triage_labels: boolean;
  /** What triage may close (default duplicate only). */
  close: (typeof CLOSE_REASONS)[number][];
  /** Days an issue waiting on its reporter's details is left before it is closed; null never closes it (default null). */
  needs_info_close_days: number | null;
  /** Nudge an issue quiet for `days`, then close it after `grace_days` more, skipping `exempt_labels`; null leaves quiet issues alone (default null). */
  stale_issues: { days: number; grace_days: number; exempt_labels: string[] } | null;
  /** The sweep of recently merged PRs against open issues: the most it closes a run (0 switches it off) and the labels it leaves alone. */
  resolved_check: { max_closes: number; exempt_labels: string[] };
}

const whole = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;
const labelList = (where: string, k: string, v: unknown): string[] => {
  if (!Array.isArray(v) || v.some((l) => typeof l !== "string" || !/^[^\p{Cc}$]{1,50}$/u.test(l))) throw new Error(`${where}: ${k} is a list of labels`);
  return [...new Set(v as string[])];
};

/**
 * `maintainer_repos` as compiled from the setting: JSON when an entry is `{ repo, ... }`, or comma-joined when every entry
 * is a bare "owner/name" (an entry with every default). Anything malformed throws, naming the entry, so the caller refuses
 * every tool rather than act on a list it misread.
 */
export function parseRepos(raw: string): MaintainedRepo[] {
  if (!raw.trim()) return [];
  let list: unknown;
  try {
    list = raw.trim().startsWith("[") ? JSON.parse(raw) : raw.split(",").map((x) => x.trim());
  } catch {
    throw new Error(`maintainer_repos is not a list of ${SHAPE}`);
  }
  if (!Array.isArray(list)) throw new Error("maintainer_repos is not a list");
  const seen = new Set<string>();
  return list.map((entry: any, i) => {
    const where = `maintainer_repos[${i}]`;
    const e = typeof entry === "string" ? { repo: entry } : entry;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${where}: an entry is ${SHAPE}`);
    const unknown = Object.keys(e).filter((k) => !KEYS.includes(k));
    if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(", ")}`);
    const m = String(e.repo ?? "").trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
    if (!m) throw new Error(`${where}: repo must be owner/name`);
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    if (seen.has(key)) throw new Error(`${where}: ${m[1]}/${m[2]} is listed twice`);
    seen.add(key);
    const label = e.label === undefined ? AGENT_FIX : String(e.label);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,49}$/.test(label)) throw new Error(`${where}: label must be 1-50 letters, digits, spaces or ._:-`);
    const trusted = e.trusted === undefined ? DEFAULT_TRUSTED : e.trusted;
    if (!Array.isArray(trusted) || !trusted.length || trusted.some((r) => !(TRUST_ROLES as readonly string[]).includes(r)))
      throw new Error(`${where}: trusted must be one or more of ${TRUST_ROLES.join(", ")}`);
    const bool = (k: string, dflt: boolean) => {
      if (e[k] === undefined) return dflt;
      if (typeof e[k] !== "boolean") throw new Error(`${where}: ${k} must be true or false`);
      return e[k] as boolean;
    };
    const one = <T extends string>(k: string, values: readonly T[], dflt: T): T => {
      if (e[k] === undefined) return dflt;
      if (!values.includes(e[k])) throw new Error(`${where}: ${k} must be one of ${values.join(", ")}`);
      return e[k] as T;
    };
    const days = (k: string, v: unknown, dflt: number, min = 1) => {
      if (v === undefined) return dflt;
      if (!whole(v, min)) throw new Error(`${where}: ${k} must be a whole number${min ? `, ${min} or more` : ""}`);
      return v as number;
    };
    const preset = one("preset", PRESET_NAMES, "quiet");
    const close = e.close === undefined ? ["duplicate"] : e.close;
    if (!Array.isArray(close) || close.some((c) => !(CLOSE_REASONS as readonly string[]).includes(c))) throw new Error(`${where}: close is a list of ${CLOSE_REASONS.join(", ")}`);
    const nic = e.needs_info_close_days === undefined || e.needs_info_close_days === null ? null : days("needs_info_close_days", e.needs_info_close_days, 1);
    let stale_issues: MaintainedRepo["stale_issues"] = null;
    if (e.stale_issues !== undefined && e.stale_issues !== null) {
      const s = e.stale_issues;
      if (typeof s !== "object" || Array.isArray(s) || Object.keys(s).some((k) => !["days", "grace_days", "exempt_labels"].includes(k))) throw new Error(`${where}: stale_issues is { days, grace_days, exempt_labels }`);
      stale_issues = { days: days("stale_issues.days", s.days, 60), grace_days: days("stale_issues.grace_days", s.grace_days, 14), exempt_labels: s.exempt_labels === undefined ? EXEMPT_LABELS : labelList(where, "stale_issues.exempt_labels", s.exempt_labels) };
    }
    const rc = e.resolved_check ?? {};
    if (typeof rc !== "object" || Array.isArray(rc) || Object.keys(rc).some((k) => !["max_closes", "exempt_labels"].includes(k))) throw new Error(`${where}: resolved_check is { max_closes, exempt_labels }`);
    return {
      repo: `${m[1]}/${m[2]}`, owner: m[1]!, name: m[2]!, label, trusted: [...new Set(trusted as string[])],
      issues: bool("issues", true), features: bool("features", PRESETS[preset].features), contributor_prs: bool("contributor_prs", false), stale_days: days("stale_days", e.stale_days, 7),
      dependabot: bool("dependabot", false), preset, triage: one("triage", TRIAGE, PRESETS[preset].triage),
      triage_cap_per_author_day: days("triage_cap_per_author_day", e.triage_cap_per_author_day, 5, 0), triage_labels: bool("triage_labels", true),
      close: [...new Set(close as MaintainedRepo["close"])], needs_info_close_days: nic, stale_issues,
      resolved_check: { max_closes: days("resolved_check.max_closes", rc.max_closes, 10, 0), exempt_labels: rc.exempt_labels === undefined ? EXEMPT_LABELS : labelList(where, "resolved_check.exempt_labels", rc.exempt_labels) },
    };
  });
}

/** Whether `slug` (owner/name, any case) is one of the listed repos. */
export const inMaintained = (repos: MaintainedRepo[], slug: string): boolean => repos.some((r) => r.repo.toLowerCase() === slug.toLowerCase());

/** One line per repo, for tool descriptions: what the Maintainer may act on there. */
export const describeRepos = (repos: MaintainedRepo[]) =>
  repos.length ? repos.map((r) => `${r.repo} (label ${r.label}, trusted ${r.trusted.join("/")})`).join("; ") : "none configured (setting maintainer_repos)";
