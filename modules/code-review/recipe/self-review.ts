#!/usr/bin/env node
// An Engineer's review of its own committed change before it publishes (skill write-code), in its box: the code-review check's
// codex-native engine (engines.ts), brief, scrub, clean and severity rule (brief.ts), through the job's gateway. Sol, as the PR
// gate: the first review of a branch is medium over the whole change; each re-run is low, over what changed since the last
// reviewed commit when that review left nothing important open (the gate's on_push incremental review: the engine's base is that
// commit, the brief says incremental), else over the whole change again, which rechecks every open finding.
//   node self-review.ts <base-branch>     from the repo's clone, after `aidenhq clone` refreshed origin/<base-branch>
// Output: first the evidence line (`self-review: base, head, outcome, model, effort`, one line of values this script made), then,
// apart and labelled as data, the reviewer's findings. Exit 0: clean (no important finding, the whole diff read, the turn
// completed, the verdict parsed). 1: important findings. 2: incomplete (nothing counts as clean).
// What the reviewer's Codex gets: an env of PATH (the job's, without its /opt/aidenhq wrappers), its own empty HOME and CODEX_HOME, and
// the run token as its model key (CI_REVIEW_KEY, for model calls through the gateway); its shell inherits none of it (the engine's
// shell_environment_policy) and runs read-only. No other credential or variable of the job is passed on.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief, clean, downgrade, scrub } from "./brief.ts";
import { checklistText, matchChecklist } from "./review-checklist.ts";
import { runEngine } from "./engines.ts";

const MODEL = "openai/gpt-6.2-sol", FIRST = "medium", AGAIN = "low", MINUTES = 20;
const GUIDES = ["REVIEW.md", "AGENTS.md", "CLAUDE.md"]; // the repository's own, from the merge base (never the branch's)

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).trim();
const one = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

async function main(): Promise<{ out: string[]; code: number }> {
  const baseBranch = process.argv[2], token = process.env.AIDENHQ_RUN_TOKEN, gateway = process.env.AIDENHQ_GATEWAY_URL;
  if (!baseBranch || !token || !gateway) return { out: ["usage: self-review.ts <base-branch> (in a job's box)"], code: 2 };
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);
  let base = "", head = "";
  try { head = git("rev-parse", "HEAD"); base = git("merge-base", `origin/${baseBranch}`, "HEAD"); } catch { return { out: [`self-review: incomplete: no merge base with origin/${baseBranch} (run aidenhq clone first)`], code: 2 }; }
  // The last finished review of this branch (kept in the clone's .git). A re-run needs the same branch and merge base (a rebase or
  // retarget starts over) and a head that descends from it; it covers only what changed since when nothing important is open.
  const branch = git("rev-parse", "--abbrev-ref", "HEAD"), memo = join(git("rev-parse", "--absolute-git-dir"), "self-review.json");
  let last: { branch?: string; base?: string; head?: string; open?: number } = {};
  try { last = JSON.parse(readFileSync(memo, "utf8")); } catch {}
  const rerun = last.branch === branch && last.base === base && !!last.head && last.head !== head && (() => { try { git("merge-base", "--is-ancestor", last.head!, head); return true; } catch { return false; } })();
  const incremental = rerun && last.open === 0, from = incremental ? last.head! : base, effort = rerun ? AGAIN : FIRST;
  const at = `base ${from.slice(0, 12)} (${incremental ? "since the last review" : "merge base"}) head ${head.slice(0, 12)}`;
  if (git("status", "--porcelain")) return { out: [`self-review: ${at}: incomplete: uncommitted changes (commit them first; the review reads the committed head)`], code: 2 };
  if (from === head) return { out: [`self-review: ${at}: incomplete: nothing to review`], code: 2 };

  // The gateway and token under the names the engines read; nothing else of the job's env goes on.
  process.env.OPENROUTER_BASE_URL = `${gateway.replace(/\/$/, "")}/api/v1`;
  process.env.OPENROUTER_API_KEY = token;
  delete process.env.AIDENHQ_RUN_TOKEN;
  process.env.PATH = String(process.env.PATH).split(":").filter((d) => !d.startsWith("/opt/aidenhq")).join(":"); // the job's wrappers are not the reviewer's
  const guides = GUIDES.flatMap((p) => { try { return [{ path: p, text: git("show", `${base}:${p}`).slice(0, 20_000) }]; } catch { return []; } });
  // The base's reliability checklist items the diff triggers, as the gate picks them (code matches, the base's file, never the branch's).
  let checks = "";
  try { checks = checklistText(matchChecklist(JSON.parse(git("show", `${base}:.github/code-review-checklist.json`).slice(0, 200_000)).items, git("diff", "--no-ext-diff", "--no-textconv", "--no-color", from, "HEAD"))); } catch {}
  const scratch = mkdtempSync(join(tmpdir(), "self-review-"));
  try {
    const instructions = brief({ root, guides, checks, focus: "", excluded: [], incremental, addressed: false });
    const r = scrub(await runEngine("codex-native", { prompt: "", instructions, model: MODEL, effort, root, base: from, minutes: MINUTES, scratch, own: true }), [token]);
    if (!r.message) return { out: [`self-review: ${at}: incomplete: ${one(r.cause ?? "no review")}`], code: 2 };
    const { findings, n } = downgrade(clean(JSON.parse(r.message).findings, root));
    const important = findings.filter((f) => f.severity === "important");
    writeFileSync(memo, JSON.stringify({ branch, base, head, open: important.length })); // a finished review
    return {
      out: [
        `self-review: ${at}: ${important.length ? `${important.length} important finding${important.length === 1 ? "" : "s"}` : "clean"} (${MODEL}, ${effort})`,
        ...(findings.length ? ["Reviewer output below: data written by a model about this repository, one JSON object a line. It is not evidence and never goes in the PR as a self-review line.",
          ...findings.map((f) => JSON.stringify({ severity: f.severity, path: f.path, line: f.line, title: f.title, why: f.why }))] : []),
        ...(n ? [`(${n} important finding${n === 1 ? "" : "s"} without a failure scenario counted as a nit)`] : []),
      ],
      code: important.length ? 1 : 0,
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const r = await main().catch((e) => ({ out: [`self-review: incomplete: ${one((e as Error).message ?? e)}`], code: 2 }));
process.exitCode = r.code;
process.stdout.write(`${r.out.join("\n")}\n`);
