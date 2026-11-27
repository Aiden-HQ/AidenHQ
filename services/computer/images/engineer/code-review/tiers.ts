// Risk tiers (docs/design/code-review.md, "Risk tiers"): one tier per PR head from cheap facts about its own change,
// by a repo's ordered rules (the first whose conditions all hold names it). No model call, no labels. Code review owns the rules and
// serves the tier through its verdict; the CI template classifies a PR itself with this same file. Dependency-free (node:path only):
// scripts/sync-shared.ts copies it into code review's service and recipe, the engineer image and the CI template.
import { posix } from "node:path";

export const TIERS = ["skip", "trivial", "standard", "sensitive"] as const;
export type Tier = (typeof TIERS)[number];
/** A tier's rank: a higher one is riskier (what "loosening" compares). */
export const RANK: Record<Tier, number> = { skip: 0, trivial: 1, standard: 2, sensitive: 3 };
export const REPO_CLASSES = ["critical", "standard", "sandbox"] as const;
export type RepoClass = (typeof REPO_CLASSES)[number];
export const AUTHORS = ["member", "bot", "outsider"] as const;
export type AuthorKind = (typeof AUTHORS)[number];

/** Lockfiles: made, not written. They never count toward `lines`, and any change to one is a sensitive path (SENSITIVE). */
export const LOCKS = ["**/package-lock.json", "**/npm-shrinkwrap.json", "**/*.lock", "**/*-lock.json", "**/*-lock.yaml", "**/go.sum", "**/bun.lockb"];
/** Generated code and build output: never counted toward `lines`. */
export const GENERATED = ["**/generated/**", "**/__generated__/**", "**/node_modules/**", "**/dist/**", "**/*.min.js", "**/*.min.css", "**/*.map", "**/*.snap"];
/** Package manifests: a bot's PR that changes only these and lockfiles (Dependabot) is skipped: no review unless someone asks. */
export const MANIFESTS = ["**/package.json", "**/go.mod", "**/Cargo.toml", "**/pyproject.toml"];
// Globs are case-sensitive, so the default list spells the common capitalised forms too (Auth, Session…).
const RISKY = ["auth", "secur", "token", "session", "permission"].flatMap((w) => [w, w[0]!.toUpperCase() + w.slice(1)]).flatMap((w) => [`**/*${w}*`, `**/*${w}*/**`]);
/** Prose: the docs folder's documents (plans, specs, designs). A change that is only these is judged by what it says, not by a keyword in a path. */
export const PROSE = ["docs/**/*.md", "docs/**/*.rst"]; // not mdx: it can run code
/** The files that steer an agent (a reviewer reads them as guidance): prose, but never demoted. */
export const INSTRUCTIONS = ["**/AGENTS.md", "**/AGENTS.override.md", "**/CLAUDE.md", "**/REVIEW.md"];
/** The default sensitive paths: what CI's critical-path regex and ship's safe.deny meant, in one list. */
export const SENSITIVE = [
  ".github/**", "**/Dockerfile*", "**/package.json", ...INSTRUCTIONS, "**/.codex/**", "**/codex.toml", ...RISKY,
  ...LOCKS, "**/.eslintrc*", "**/eslint.config.*", "**/.oxlintrc*", "**/oxlint-plugin.*", "**/vitest.config.*", "**/jest.config.*", "**/tsconfig*.json", "**/CODEOWNERS",
  "**/migrations/**", "**/*.tf", "infra/**", "**/.env*", "**/config/**", "**/docker-compose*",
];

/** What the rules see: the PR's own change (merge base to head) and who made it, plus the repo's class. */
export type Facts = {
  /** Substantive lines: additions plus deletions over every file but generated files and lockfiles. */
  lines: number;
  /** How many files count toward `lines`. */
  files: number;
  /** Every changed path, a rename's old path and generated files included. */
  paths: string[];
  author: AuthorKind; base: string; repo_class: RepoClass;
};
/** One entry of GitHub's PR files list. */
export type FileChange = { path: string; previous?: string; additions: number; deletions: number };
/** A GitHub files list stops at this many files: a PR with more is sensitive, unread. */
export const TOO_MANY_FILES = 3000;

/** A path's segments without their leading dot: a glob's wildcards skip dot-files and dot-folders, so `.github/**` would miss
 * `.github/.release.yml`. Each glob is also tried with both sides undotted, so a dot-name matches like any other name. */
const undot = (s: string) => s.replace(/(^|\/)\.(?=[^/])/g, "$1");
export const matches = (path: string, globs: readonly string[]) => globs.some((g) => posix.matchesGlob(path, g) || posix.matchesGlob(undot(path), undot(g)));

export function factsOf(files: FileChange[], o: { author: AuthorKind; base: string; repo_class: RepoClass }): Facts {
  const counted = files.filter((f) => !matches(f.path, GENERATED) && !matches(f.path, LOCKS));
  const paths = [...new Set(files.flatMap((f) => (f.previous && f.previous !== f.path ? [f.path, f.previous] : [f.path])))];
  return { lines: counted.reduce((n, f) => n + f.additions + f.deletions, 0), files: counted.length, paths, ...o };
}

/** Who opened the PR: the instance's own App is a member (`own`), Dependabot and Renovate (exact logins, never from a fork) bots,
 * an owner, member or collaborator a member. Any other `*[bot]` is judged by its association, as a person is. */
export function authorKind(login: string, association: string | undefined, own = false, fork = false): AuthorKind {
  if (own) return "member";
  if (!fork && /^(dependabot|renovate)\[bot\]$/i.test(login)) return "bot";
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(association ?? "").toUpperCase()) ? "member" : "outsider";
}

export type When = {
  lines_min?: number; lines_max?: number; files_min?: number; files_max?: number;
  paths?: string[]; only_paths?: string[]; author?: AuthorKind; base?: string[]; repo_class?: RepoClass;
};
export type Rule = { when?: When; tier: Tier };
const COUNTS = ["lines_min", "lines_max", "files_min", "files_max"] as const;
const GLOBS = ["paths", "only_paths", "base"] as const;
export const CONDITIONS = [...COUNTS, ...GLOBS, "author", "repo_class"] as const;

/** The default rules: the first that holds names the tier. */
export const DEFAULT_RULES: Rule[] = [
  { when: { repo_class: "critical" }, tier: "sensitive" },
  { when: { author: "bot", only_paths: [...MANIFESTS, ...LOCKS] }, tier: "skip" },
  { when: { paths: INSTRUCTIONS }, tier: "sensitive" },
  { when: { author: "member", only_paths: PROSE }, tier: "standard" },
  { when: { paths: SENSITIVE }, tier: "sensitive" },
  { when: { author: "outsider" }, tier: "sensitive" },
  { when: { repo_class: "sandbox" }, tier: "trivial" },
  { when: { lines_max: 0 }, tier: "sensitive" },
  { when: { lines_min: 600 }, tier: "sensitive" },
  { when: { author: "member", lines_max: 10, files_max: 20 }, tier: "trivial" },
  { tier: "standard" },
];

/** A rules list checked whole: the rules, or the first reason it isn't one. */
export function parseRules(raw: unknown): Rule[] | { error: string } {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) return { error: "rules is a list of 1 to 100 { when?, tier }, the last with no when" };
  const out: Rule[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `rules[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) return { error: `${at} is { when?, tier }` };
    const extra = Object.keys(r).filter((k) => k !== "when" && k !== "tier");
    if (extra.length) return { error: `${at}: unknown field ${extra.join(", ")}` };
    const { when, tier } = r as { when?: unknown; tier?: unknown };
    if (!TIERS.includes(tier as Tier)) return { error: `${at}.tier is one of ${TIERS.join(", ")}` };
    const last = i === raw.length - 1;
    if (last && when !== undefined) return { error: `${at}: the last rule has no when (it is everything else)` };
    if (!last && when === undefined) return { error: `${at}: only the last rule has no when` };
    if (last) { out.push({ tier: tier as Tier }); continue; }
    if (!when || typeof when !== "object" || Array.isArray(when) || !Object.keys(when).length) return { error: `${at}.when names at least one condition` };
    const w: When = {};
    for (const [k, v] of Object.entries(when)) {
      if ((COUNTS as readonly string[]).includes(k)) {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10_000_000) return { error: `${at}.when.${k} is a whole number` };
      } else if ((GLOBS as readonly string[]).includes(k)) {
        if (!Array.isArray(v) || !v.length || v.length > 300 || !v.every((g) => typeof g === "string" && g.length > 0 && g.length <= 200)) return { error: `${at}.when.${k} is a list of globs` };
      } else if (k === "author") {
        if (!AUTHORS.includes(v as AuthorKind)) return { error: `${at}.when.author is one of ${AUTHORS.join(", ")}` };
      } else if (k === "repo_class") {
        if (!REPO_CLASSES.includes(v as RepoClass)) return { error: `${at}.when.repo_class is one of ${REPO_CLASSES.join(", ")}` };
      } else return { error: `${at}.when: unknown condition ${k} (one of ${CONDITIONS.join(", ")})` };
      (w as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    }
    out.push({ when: w, tier: tier as Tier });
  }
  return out;
}

const holds = (f: Facts, w: When) =>
  (w.lines_min === undefined || f.lines >= w.lines_min) && (w.lines_max === undefined || f.lines <= w.lines_max)
  && (w.files_min === undefined || f.files >= w.files_min) && (w.files_max === undefined || f.files <= w.files_max)
  && (w.paths === undefined || f.paths.some((p) => matches(p, w.paths!)))
  && (w.only_paths === undefined || (f.paths.length > 0 && f.paths.every((p) => matches(p, w.only_paths!))))
  && (w.author === undefined || f.author === w.author)
  && (w.base === undefined || matches(f.base, w.base))
  && (w.repo_class === undefined || f.repo_class === w.repo_class);

/** The tier the first matching rule names, its index, and why in plain words. */
export function classify(f: Facts, rules: Rule[]): { tier: Tier; rule: number; why: string } {
  const i = rules.findIndex((r) => !r.when || holds(f, r.when));
  const r = rules[i]!;
  return { tier: r.tier, rule: i, why: why(f, r.when) };
}

/** A PR whose files list GitHub can't give whole: sensitive, unread. */
export const tooMany = (n: number) => ({ tier: "sensitive" as Tier, rule: -1, why: `too many files to read (${n} changed; GitHub lists at most ${TOO_MANY_FILES})` });

function why(f: Facts, w: When | undefined): string {
  if (!w) return `${f.lines} line${f.lines === 1 ? "" : "s"} in ${f.files} file${f.files === 1 ? "" : "s"}, by a ${f.author}`;
  const parts: string[] = [];
  if (w.repo_class) parts.push(`the repo is ${w.repo_class}`);
  if (w.author) parts.push(`by a ${w.author}`);
  if (w.paths) parts.push(`touches ${f.paths.find((p) => matches(p, w.paths!))}`);
  if (w.only_paths) parts.push(`only ${f.paths.length === 1 ? f.paths[0] : `${f.paths.length} matching files`}`);
  if (w.lines_min !== undefined || w.lines_max !== undefined) parts.push(`${f.lines} line${f.lines === 1 ? "" : "s"}${f.lines === 0 && w.lines_max === 0 ? " of code (only generated files, lockfiles, binaries or renames)" : ""}`);
  if (w.files_min !== undefined || w.files_max !== undefined) parts.push(`${f.files} file${f.files === 1 ? "" : "s"}`);
  if (w.base) parts.push(`into ${f.base}`);
  return parts.join(", ");
}

/** The tiers a rules list can select: those some rule names. */
export const selectable = (rules: Rule[]) => TIERS.filter((t) => rules.some((r) => r.tier === t));
