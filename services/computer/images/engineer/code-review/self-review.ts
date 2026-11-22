#!/usr/bin/env node
// An Engineer's review of its own committed change before it publishes (skill write-code), in its box: the code-review check's
// codex-native engine (engines.ts) with the check's brief (brief.ts), through the job's gateway with the job's run token. Sol, as
// the PR gate: the first review of a branch is medium over the whole change; each re-run is low over what changed since the
// last reviewed commit (the gate's on_push incremental review: the engine's base is that commit, the brief says incremental). The reviewer gets a fresh Codex home, a read-only shell and no credential, never the job's.
//   node self-review.ts <base-branch>     from the repo's clone, after `aidenhq clone` refreshed origin/<base-branch>
// Prints the evidence line (base, head, outcome) and the findings. Exit 0: clean (no important finding, the diff was read, the
// turn completed, the verdict parsed). 1: important findings. 2: incomplete (nothing counts as clean).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief } from "./brief.ts";
import { runEngine } from "./engines.ts";

const MODEL = "openai/gpt-6.2-sol", FIRST = "medium", AGAIN = "low", MINUTES = 20;

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const done = (outcome: string, code: number, rest = ""): never => { console.log(`${outcome}${rest ? `\n${rest}` : ""}`); process.exit(code); };

const baseBranch = process.argv[2];
if (!baseBranch || !process.env.AIDENHQ_GATEWAY_URL || !process.env.AIDENHQ_RUN_TOKEN) done("usage: self-review.ts <base-branch> (in a job's box)", 2);
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
let base = "", head = "";
try { head = git("rev-parse", "HEAD"); base = git("merge-base", `origin/${baseBranch}`, "HEAD"); } catch { done(`self-review: incomplete: no merge base with origin/${baseBranch} (run aidenhq clone first)`, 2); }
// The last review of this branch (kept in the clone's .git): a re-run starts from it when it is still an ancestor of the head.
const branch = git("rev-parse", "--abbrev-ref", "HEAD"), memo = join(git("rev-parse", "--absolute-git-dir"), "self-review.json");
let last: { branch?: string; head?: string } = {};
try { last = JSON.parse(readFileSync(memo, "utf8")); } catch {}
const again = last.branch === branch && !!last.head && last.head !== head && (() => { try { git("merge-base", "--is-ancestor", last.head!, head); return true; } catch { return false; } })();
const effort = again ? AGAIN : FIRST, from = again ? last.head! : base;
const at = `base ${from.slice(0, 12)} (${again ? "since the last review" : "merge base"}) head ${head.slice(0, 12)}`;
if (git("status", "--porcelain")) done(`self-review: ${at}: incomplete: uncommitted changes (commit them first; the review reads the committed head)`, 2);
if (from === head) done(`self-review: ${at}: incomplete: nothing new to review since that point`, 2);

// The gateway and token as the engines read them (the check box's names).
process.env.OPENROUTER_BASE_URL = `${process.env.AIDENHQ_GATEWAY_URL!.replace(/\/$/, "")}/api/v1`;
process.env.OPENROUTER_API_KEY = process.env.AIDENHQ_RUN_TOKEN;
const scratch = mkdtempSync(join(tmpdir(), "self-review-"));
try {
  const instructions = brief({ root, guides: [], checks: "", focus: "", excluded: [], incremental: again, addressed: false });
  const r = await runEngine("codex-native", { prompt: "", instructions, model: MODEL, effort, root, base: from, minutes: MINUTES, scratch, own: true });
  if (!r.message) done(`self-review: ${at}: incomplete: ${r.cause ?? "no review"}`, 2);
  writeFileSync(memo, JSON.stringify({ branch, head })); // a finished review: the next run covers what changes after it
  const findings: { severity: string; path: string; line: number; title: string; why: string }[] = JSON.parse(r.message).findings;
  const important = findings.filter((f) => f.severity === "important");
  const list = findings.map((f) => `- [${f.severity}] ${f.path}:${f.line} ${f.title}\n  ${f.why.replace(/\n+/g, "\n  ")}`).join("\n");
  done(`self-review: ${at}: ${important.length ? `${important.length} important finding${important.length === 1 ? "" : "s"}` : "clean"} (${MODEL}, ${effort})`, important.length ? 1 : 0, list);
} finally { rmSync(scratch, { recursive: true, force: true }); }
