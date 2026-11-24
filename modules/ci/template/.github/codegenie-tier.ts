#!/usr/bin/env node
// The `code-review` check's risk tier (docs/superpowers/specs/2026-11-24-risk-tiers-design.md §8): the whole PR (merge base to
// head) classified by the shared rules in tiers.ts, the same function code review runs, so no label or model call decides it.
//   node codegenie-tier.ts refuse  ->  the first path of a PR that changes codex config, or nothing
//   node codegenie-tier.ts         ->  one JSON line: { tier, rule, why, effort, lines }
// Env: BASE_SHA, HEAD_SHA, BASE_REF (the PR's base branch), PR_AUTHOR and PR_ASSOCIATION (GitHub's own record of who opened it),
// EFFORT (the review's effort), TIERS (a file: the gateway's `{ rules?, repo_class?, self? }` for this repo; absent, the default
// rules, a standard repo and no own App). A sensitive PR is reviewed one effort higher. No dependencies; Node 22+.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { authorKind, classify, DEFAULT_RULES, factsOf, parseRules, REPO_CLASSES, tooMany, TOO_MANY_FILES, type FileChange, type RepoClass } from "./tiers.ts";

const UP: Record<string, string> = { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "xhigh" };
const CODEX_CONFIG = /(^|\/)\.codex\/|(^|\/)codex\.toml$|(^|\/)AGENTS\.override\.md$/;

/** `git diff --numstat -z -M`: a binary file has no counted lines (as on GitHub's files list), a rename carries its old path. */
export function changes(raw: string): FileChange[] {
  const out: FileChange[] = [];
  const t = raw.split("\0");
  for (let i = 0; i < t.length;) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(t[i++]!);
    if (!m) continue;
    const c = { additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) };
    if (m[3] === "") { const previous = t[i++]!; out.push({ path: t[i++]!, previous, ...c }); } else out.push({ path: m[3]!, ...c });
  }
  return out;
}

/** The first path of the change that is codex's own config, hooks, skills or instruction overrides: never in an app repo. */
export const codexConfig = (files: FileChange[]) => files.flatMap((f) => [f.path, f.previous ?? ""]).find((p) => CODEX_CONFIG.test(p));

type Tiers = { rules?: unknown; repo_class?: unknown; self?: unknown };
export function tierOf(files: FileChange[], o: { author: string; association?: string; base: string; effort: string; tiers?: Tiers }) {
  const { rules: given, repo_class = "standard", self } = o.tiers ?? {};
  const rules = given == null ? DEFAULT_RULES : parseRules(given);
  if ("error" in rules) throw new Error(`the repo's tier rules: ${rules.error}`);
  if (!REPO_CLASSES.includes(repo_class as RepoClass)) throw new Error(`the repo's class is one of ${REPO_CLASSES.join(", ")}`);
  const own = typeof self === "string" && self !== "" && self.toLowerCase() === o.author.toLowerCase();
  const facts = factsOf(files, { author: authorKind(o.author, o.association, own), base: o.base, repo_class: repo_class as RepoClass });
  const r = files.length > TOO_MANY_FILES ? tooMany(files.length) : classify(facts, rules);
  return { ...r, effort: r.tier === "sensitive" ? UP[o.effort] ?? o.effort : o.effort, lines: facts.lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const e = process.env;
    const files = changes(execFileSync("git", ["diff", "--numstat", "-z", "-M", `${e.BASE_SHA}...${e.HEAD_SHA}`], { encoding: "utf8", maxBuffer: 1 << 28 }));
    if (process.argv[2] === "refuse") console.log(codexConfig(files) ?? "");
    else console.log(JSON.stringify(tierOf(files, { author: e.PR_AUTHOR ?? "", association: e.PR_ASSOCIATION, base: e.BASE_REF ?? "", effort: e.EFFORT || "high", tiers: e.TIERS ? JSON.parse(readFileSync(e.TIERS, "utf8")) : undefined })));
  } catch (err) {
    console.error((err as Error).message.split("\n")[0]);
    process.exit(1);
  }
}
