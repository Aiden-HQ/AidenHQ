#!/usr/bin/env node
// An Engineer's review of its own committed change before it publishes (skill write-code), in its box: the code-review check's
// codex-native engine (engines.ts) with the check's brief (brief.ts), on the model its on_push combo uses, through the job's
// gateway with the job's run token. The reviewer gets a fresh Codex home, a read-only shell and no credential, never the job's.
//   node self-review.ts <base-branch>     from the repo's clone, after `aidenhq clone` refreshed origin/<base-branch>
// Prints the evidence line (base, head, outcome) and the findings. Exit 0: clean (no important finding, the diff was read, the
// turn completed, the verdict parsed). 1: important findings. 2: incomplete (nothing counts as clean).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief } from "./brief.ts";
import { runEngine } from "./engines.ts";

const MODEL = "openai/gpt-6.2-sol", EFFORT = "low", MINUTES = 20; // the on_push combo (modules/code-review/service/src/config.ts)

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const done = (outcome: string, code: number, rest = ""): never => { console.log(`${outcome}${rest ? `\n${rest}` : ""}`); process.exit(code); };

const baseBranch = process.argv[2];
if (!baseBranch || !process.env.AIDENHQ_GATEWAY_URL || !process.env.AIDENHQ_RUN_TOKEN) done("usage: self-review.ts <base-branch> (in a job's box)", 2);
const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
let base = "", head = "";
try { head = git("rev-parse", "HEAD"); base = git("merge-base", `origin/${baseBranch}`, "HEAD"); } catch { done(`self-review: incomplete: no merge base with origin/${baseBranch} (run aidenhq clone first)`, 2); }
const at = `base ${base.slice(0, 12)} head ${head.slice(0, 12)}`;
if (git("status", "--porcelain")) done(`self-review: ${at}: incomplete: uncommitted changes (commit them first; the review reads the committed head)`, 2);
if (base === head) done(`self-review: ${at}: incomplete: no change against origin/${baseBranch}`, 2);

// The gateway and token as the engines read them (the check box's names).
process.env.OPENROUTER_BASE_URL = `${process.env.AIDENHQ_GATEWAY_URL!.replace(/\/$/, "")}/api/v1`;
process.env.OPENROUTER_API_KEY = process.env.AIDENHQ_RUN_TOKEN;
const scratch = mkdtempSync(join(tmpdir(), "self-review-"));
try {
  const instructions = brief({ root, guides: [], checks: "", focus: "", excluded: [], incremental: false, addressed: false });
  const r = await runEngine("codex-native", { prompt: "", instructions, model: MODEL, effort: EFFORT, root, base, minutes: MINUTES, scratch, own: true });
  if (!r.message) done(`self-review: ${at}: incomplete: ${r.cause ?? "no review"}`, 2);
  const findings: { severity: string; path: string; line: number; title: string; why: string }[] = JSON.parse(r.message).findings;
  const important = findings.filter((f) => f.severity === "important");
  const list = findings.map((f) => `- [${f.severity}] ${f.path}:${f.line} ${f.title}\n  ${f.why.replace(/\n+/g, "\n  ")}`).join("\n");
  done(`self-review: ${at}: ${important.length ? `${important.length} important finding${important.length === 1 ? "" : "s"}` : "clean"} (${MODEL}, ${EFFORT})`, important.length ? 1 : 0, list);
} finally { rmSync(scratch, { recursive: true, force: true }); }
