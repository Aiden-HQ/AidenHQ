// `maintainer_repos`, the Maintainer's own list of repos (issues only: pull requests are Ship's): the setting as compiled, parsed
// once here for github-mcp (the Maintainer's tools and watcher read) and the Maintainer's page. Each entry's duties are opt-in.
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
/** What happens to an issue triage (or the resolved-check) finds a duplicate, not a bug or request, or already fixed: always a comment
 * saying why; `label` adds the verdict's label (its name, below) and leaves the issue open; `close` closes it. */
export const ACTIONS = ["comment", "label", "close"] as const;
export const VERDICTS = ["duplicate", "invalid", "fixed"] as const;
/** The label each verdict adds under `label`: GitHub's own names, the same on every repo. */
export const VERDICT_LABELS: Record<(typeof VERDICTS)[number], string> = { duplicate: "duplicate", invalid: "invalid", fixed: "fixed" };
/** Labels every automatic close skips, unless the entry names its own list. */
export const PROTECTED_LABELS = ["roadmap", "wip", "blocked"];
/** Product constants, not settings: triage runs a day per outside author on invalid issues, closes per resolved-check run, and the days
 * between an inactive issue's notice and its close. */
export const TRIAGE_CAP_PER_AUTHOR_DAY = 5;
export const RESOLVED_CLOSES_PER_RUN = 10;
export const INACTIVE_GRACE_DAYS = 14;
const KEYS = ["repo", "fixes", "triage", "features", "actions", "no_reply_days", "inactive_issue_days", "fix_label", "trusted", "protected_labels"];
const SHAPE = `{ ${KEYS.join(", ")} }`;
/** Keys an older entry may still carry, with what replaced each: named in the refusal. */
const REMOVED: Record<string, string> = {
  label: "it is now fix_label", issues: "it is now fixes", preset: "removed: set triage and features", triage_labels: "removed",
  close: "removed: see actions", triage_cap_per_author_day: "removed: 5 a day is fixed", resolved_check: "removed: see actions.fixed and protected_labels",
  needs_info_close_days: "it is now no_reply_days", stale_issues: "it is now inactive_issue_days", contributor_prs: "moved to Ship: quiet_pr_days on the repo's ship.repos entry",
  stale_days: "moved to Ship: quiet_pr_days on the repo's ship.repos entry",
  // Pull-request duties are Ship's (owner, 2026-11-27): each is a field of the repo's ship entry now.
  dependabot: "moved to Ship: dependabot on the repo's ship.repos entry", quiet_pr_days: "moved to Ship: quiet_pr_days on the repo's ship.repos entry",
};

export interface MaintainedRepo {
  repo: string;
  owner: string;
  name: string;
  /** Validate `fix_label` issues, hand fixes over and see them through (default on). */
  fixes: boolean;
  /** Whether unlabelled issues are triaged: no, each new one, or each new one and the backlog (default new). */
  triage: (typeof TRIAGE)[number];
  /** Triage feature requests, and build the ones carrying BUILD_LABEL (default off). */
  features: boolean;
  /** What each verdict does (default label for all three). */
  actions: Record<(typeof VERDICTS)[number], (typeof ACTIONS)[number]>;
  /** Close an issue this many days after asking its reporter for details with no reply; null leaves it open (default). */
  no_reply_days: number | null;
  /** Give an issue quiet this many days one notice, close it INACTIVE_GRACE_DAYS later; null leaves it open (default). */
  inactive_issue_days: number | null;
  /** The label that asks for a fix. */
  fix_label: string;
  trusted: string[];
  /** Labels every automatic close skips. */
  protected_labels: string[];
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
    if (unknown.length) throw new Error(`${where}: unknown key ${unknown.map((k) => (REMOVED[k] ? `${k} (${REMOVED[k]})` : k)).join(", ")}`);
    const m = String(e.repo ?? "").trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
    if (!m) throw new Error(`${where}: repo must be owner/name`);
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    if (seen.has(key)) throw new Error(`${where}: ${m[1]}/${m[2]} is listed twice`);
    seen.add(key);
    const fix_label = e.fix_label === undefined ? AGENT_FIX : String(e.fix_label);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,49}$/.test(fix_label)) throw new Error(`${where}: fix_label must be 1-50 letters, digits, spaces or ._:-`);
    if ([...Object.values(VERDICT_LABELS), FEATURE_LABEL, BUILD_LABEL].includes(fix_label.toLowerCase())) throw new Error(`${where}: fix_label ${fix_label} is a label the Maintainer uses for something else`);
    const trusted = e.trusted === undefined ? DEFAULT_TRUSTED : e.trusted;
    if (!Array.isArray(trusted) || !trusted.length || trusted.some((r) => !(TRUST_ROLES as readonly string[]).includes(r)))
      throw new Error(`${where}: trusted must be one or more of ${TRUST_ROLES.join(", ")}`);
    const bool = (k: string, dflt: boolean) => {
      if (e[k] === undefined) return dflt;
      if (typeof e[k] !== "boolean") throw new Error(`${where}: ${k} must be true or false`);
      return e[k] as boolean;
    };
    const one = <T extends string>(k: string, v: unknown, values: readonly T[], dflt: T): T => {
      if (v === undefined) return dflt;
      if (!values.includes(v as T)) throw new Error(`${where}: ${k} must be one of ${values.join(", ")}`);
      return v as T;
    };
    const days = (k: string) => {
      if (e[k] === undefined || e[k] === null) return null;
      if (!whole(e[k], 1)) throw new Error(`${where}: ${k} must be a whole number of days, 1 or more, or null (off)`);
      return e[k] as number;
    };
    const a = e.actions ?? {};
    if (typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => !(VERDICTS as readonly string[]).includes(k))) throw new Error(`${where}: actions is { ${VERDICTS.join(", ")} }, each ${ACTIONS.join(" | ")}`);
    const actions = Object.fromEntries(VERDICTS.map((v) => [v, one(`actions.${v}`, a[v], ACTIONS, "label")])) as MaintainedRepo["actions"];
    return {
      repo: `${m[1]}/${m[2]}`, owner: m[1]!, name: m[2]!,
      fixes: bool("fixes", true), triage: one("triage", e.triage, TRIAGE, "new"), features: bool("features", false),
      actions,
      no_reply_days: days("no_reply_days"), inactive_issue_days: days("inactive_issue_days"),
      fix_label, trusted: [...new Set(trusted as string[])],
      protected_labels: e.protected_labels === undefined ? PROTECTED_LABELS : labelList(where, "protected_labels", e.protected_labels),
    };
  });
}

/**
 * The one way a repo joins maintainer_repos (the Maintainer page's add; Ship keeps its own list): the list with `repo`
 * appended as an entry carrying `fields` (none = every default). Throws with the owner-readable reason for a malformed or already
 * listed repo; the caller still runs parseRepos over the result.
 */
export function addListed(list: unknown[], repo: string, fields: Record<string, unknown> = {}): unknown[] {
  if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo)) throw new Error(`${repo.slice(0, 100)} isn't owner/name, for example acme/api`);
  if (list.some((e) => String(typeof e === "string" ? e : (e as { repo?: unknown })?.repo).toLowerCase() === repo.toLowerCase())) throw new Error(`${repo} is already listed`);
  return [...list, { repo, ...fields }];
}

/** Whether `slug` (owner/name, any case) is one of the listed repos. */
export const inMaintained = (repos: MaintainedRepo[], slug: string): boolean => repos.some((r) => r.repo.toLowerCase() === slug.toLowerCase());

/** One line per repo, for tool descriptions: what the Maintainer may act on there. */
export const describeRepos = (repos: MaintainedRepo[]) =>
  repos.length ? repos.map((r) => `${r.repo} (label ${r.fix_label}, trusted ${r.trusted.join("/")})`).join("; ") : "none configured (setting maintainer_repos)";
