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
const KEYS = ["repo", "label", "trusted", "issues", "features", "dependabot", "contributor_prs", "stale_days"];
const DUTIES = ["issues", "features", "dependabot", "contributor_prs"] as const;

export interface MaintainedRepo {
  repo: string;
  owner: string;
  name: string;
  label: string;
  trusted: string[];
  /** Validate `label` issues, hand fixes over and see them through (default on). */
  issues: boolean;
  /** Triage feature requests, and build the ones carrying BUILD_LABEL (default off). */
  features: boolean;
  /** Every open Dependabot PR has an Engineer task (default off). */
  dependabot: boolean;
  /** Nudge, then close, quiet human PRs (default off). */
  contributor_prs: boolean;
  /** Quiet days before the nudge, and again before the close; drafts get double. */
  stale_days: number;
}

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
    throw new Error("maintainer_repos is not a list of { repo, label, trusted, issues, features, dependabot, contributor_prs, stale_days }");
  }
  if (!Array.isArray(list)) throw new Error("maintainer_repos is not a list");
  const seen = new Set<string>();
  return list.map((entry: any, i) => {
    const where = `maintainer_repos[${i}]`;
    const e = typeof entry === "string" ? { repo: entry } : entry;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${where}: an entry is { repo, label, trusted, issues, features, dependabot, contributor_prs, stale_days }`);
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
    const duty = (k: (typeof DUTIES)[number], dflt: boolean) => {
      if (e[k] === undefined) return dflt;
      if (typeof e[k] !== "boolean") throw new Error(`${where}: ${k} must be true or false`);
      return e[k] as boolean;
    };
    const stale = e.stale_days === undefined ? 7 : e.stale_days;
    if (!Number.isInteger(stale) || stale < 1 || stale > 90) throw new Error(`${where}: stale_days must be a whole number of days, 1 to 90`);
    return {
      repo: `${m[1]}/${m[2]}`, owner: m[1]!, name: m[2]!, label, trusted: [...new Set(trusted as string[])],
      issues: duty("issues", true), features: duty("features", false), dependabot: duty("dependabot", false), contributor_prs: duty("contributor_prs", false), stale_days: stale,
    };
  });
}

/** Whether `slug` (owner/name, any case) is one of the listed repos. */
export const inMaintained = (repos: MaintainedRepo[], slug: string): boolean => repos.some((r) => r.repo.toLowerCase() === slug.toLowerCase());

/** One line per repo, for tool descriptions: what the Maintainer may act on there. */
export const describeRepos = (repos: MaintainedRepo[]) =>
  repos.length ? repos.map((r) => `${r.repo} (label ${r.label}, trusted ${r.trusted.join("/")})`).join("; ") : "none configured (setting maintainer_repos)";
