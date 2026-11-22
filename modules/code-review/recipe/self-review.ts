#!/usr/bin/env node
// An Engineer's review of its own committed change before it publishes (skill write-code), in its box: the code-review check's
// codex-native engine (engines.ts), brief, scrub, clean and severity rule (brief.ts), through the job's gateway. Sol, as the PR
// gate: the first review of a branch is medium over the whole change; each re-run is low, over what changed since the last
// reviewed commit when that review left nothing important open (the gate's on_push incremental review: the engine's base is that
// commit, the brief says incremental), else over the whole change again, which rechecks every open finding.
//   node self-review.ts <base-branch> <branch>   from the repo's clone with <branch> checked out (one run per branch a task publishes),
//                                                after `aidenhq clone` refreshed origin/<base-branch>
// Output: first the evidence line (`self-review: branch, base, head, outcome, model, effort`, one line of values this script made), then,
// apart and labelled as data, the reviewer's findings. Exit 0: clean (no important finding, the whole diff read, the turn
// completed, the verdict parsed). 1: important findings. 2: incomplete, whatever was found (nothing counts as clean).
// What the reviewer's Codex gets: an env of PATH (the job's, without its /opt/aidenhq wrappers), its own empty HOME and CODEX_HOME, and
// the run token as its model key (CI_REVIEW_KEY, for model calls through the gateway); its shell inherits none of it (the engine's
// shell_environment_policy) and runs read-only. No other credential or variable of the job is passed on.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief, clean, downgrade, scrub } from "./brief.ts";
import { checklistText, matchChecklist } from "./review-checklist.ts";
import { gitSafe, runEngine } from "./engines.ts";
import { changed, guidePaths, place, scope } from "./scope.ts";

const MODEL = "openai/gpt-6.2-sol", FIRST = "medium", AGAIN = "low", MINUTES = 20;

const git = (...a: string[]) => gitSafe(process.cwd(), a).trim(); // the branch's attributes and config run nothing here (gitSafe)
const one = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

// What went wrong, apart from the evidence line: command output may carry repository text, so it is labelled data.
const detail = (t: unknown) => `Detail (data from commands or the model, not evidence; never copy it into the PR): ${JSON.stringify(one(t))}`;

async function main(): Promise<{ out: string[]; code: number }> {
  const baseBranch = process.argv[2], asked = process.argv[3], token = process.env.AIDENHQ_RUN_TOKEN, gateway = process.env.AIDENHQ_GATEWAY_URL;
  if (!baseBranch || !asked || !token || !gateway) return { out: ["usage: self-review.ts <base-branch> <branch> (in a job's box)"], code: 2 };
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);
  let base = "", head = "";
  try { head = git("rev-parse", "HEAD"); base = git("merge-base", `origin/${baseBranch}`, head); } catch { return { out: [`self-review: incomplete: no merge base with origin/${baseBranch} (run aidenhq clone first)`], code: 2 }; }
  // The last finished review of this branch (kept in the clone's .git). A re-run needs the same branch and merge base (a rebase or
  // retarget starts over) and a head that descends from it; it covers only what changed since when nothing important is open.
  // The checked-out branch by its full ref (a tag of the same name can't stand in for it); a detached HEAD has none.
  let ref = "";
  try { ref = git("symbolic-ref", "-q", "HEAD"); } catch {}
  if (ref !== `refs/heads/${asked}`) return { out: [`self-review: incomplete: ${asked} is not the checked-out branch; switch to it, the review reads the committed head of the branch in the clone`], code: 2 };
  const branch = asked, memo = join(git("rev-parse", "--absolute-git-dir"), "self-review.json");
  // One record per branch, so reviewing another branch in the same clone doesn't reset this one's incremental review.
  const records = (): Record<string, { base?: string; head?: string; open?: number }> => { try { return JSON.parse(readFileSync(memo, "utf8")); } catch { return {}; } };
  const last = records()[branch] ?? {};
  const remember = (open: number) => writeFileSync(memo, JSON.stringify({ ...records(), [branch]: { base, head, open } })); // reread: another branch's record may have landed meanwhile
  const rerun = last.base === base && !!last.head && last.head !== head && (() => { try { git("merge-base", "--is-ancestor", last.head!, head); return true; } catch { return false; } })();
  const incremental = rerun && last.open === 0, from = incremental ? last.head! : base, effort = rerun ? AGAIN : FIRST;
  const at = `branch ${branch} base ${from.slice(0, 12)} (${incremental ? "since the last review" : "merge base"}) head ${head.slice(0, 12)}`;
  if (git("status", "--porcelain")) return { out: [`self-review: ${at}: incomplete: uncommitted changes (commit them first; the review reads the committed head)`], code: 2 };
  if (from === head) return { out: [`self-review: ${at}: incomplete: nothing to review`], code: 2 };

  // The files the PR check would review (its scope), and the generated ones the change adds, which it counts as a gap.
  const prChanged = new Set(git("diff", "--no-renames", "--name-only", "-z", base, head).split("\0").filter(Boolean));
  const { reviewed, excluded } = scope(changed((a) => git(...a), from, head), [], prChanged);
  const gaps = excluded.filter((e) => e.gap).map((e) => e.path);
  const mine = scope([...prChanged].map((path) => ({ path, added: 0, removed: 0, binary: false })), [], prChanged);
  const left = new Set([...excluded, ...mine.excluded].map((x) => x.path));
  if (gaps.length) return { out: [`self-review: ${at}: incomplete`, detail(`generated files this change adds are not reviewed: ${gaps.slice(0, 5).join(", ")}`)], code: 2 };
  if (!reviewed.length) {
    remember(0);
    return { out: [`self-review: ${at}: clean (nothing reviewable: only lockfiles, binary or generated files changed; no model ran)`], code: 0 };
  }
  // The gateway and token under the names the engines read; nothing else of the job's env goes on.
  process.env.OPENROUTER_BASE_URL = `${gateway.replace(/\/$/, "")}/api/v1`;
  process.env.OPENROUTER_API_KEY = token;
  delete process.env.AIDENHQ_RUN_TOKEN;
  process.env.PATH = String(process.env.PATH).split(":").filter((d) => !d.startsWith("/opt/aidenhq")).join(":"); // the job's wrappers are not the reviewer's
  // The guidance that applies to the reviewed files, as the PR check picks it (guidePaths), read from the merge base (never the branch's).
  let total = 0;
  const guides = guidePaths(reviewed).flatMap((p) => { try { const text = git("show", `${base}:${p}`).slice(0, 20_000); total += text.length; return total > 80_000 ? [] : [{ path: p, text }]; } catch { return []; } });
  // The base's reliability checklist items the diff triggers, as the gate picks them (code matches, the base's file, never the branch's).
  let checks = "";
  try { checks = checklistText(matchChecklist(JSON.parse(git("show", `${base}:.github/code-review-checklist.json`).slice(0, 200_000)).items, git("diff", "--no-ext-diff", "--no-textconv", "--no-color", from, head))); } catch {}
  const scratch = mkdtempSync(join(tmpdir(), "self-review-"));
  try {
    const instructions = brief({ root, guides, checks, focus: "", excluded: [], incremental, addressed: false });
    const r = scrub(await runEngine("codex-native", { prompt: "", instructions, model: MODEL, effort, root, base: from, minutes: MINUTES, scratch, own: true, files: reviewed, head, left: [...left] }), [token]);
    // The review is of the commit captured at the start: if the checkout moved meanwhile, nothing is recorded for it.
    if (git("rev-parse", "HEAD") !== head) return { out: [`self-review: ${at}: incomplete`, detail("the checkout changed during the review")], code: 2 };
    if (!r.message) return { out: [`self-review: ${at}: incomplete`, detail(r.cause ?? "no review")], code: 2 };
    const down = downgrade(clean(JSON.parse(r.message).findings, root)), n = down.n;
    // What the PR check counts: findings at a real place in the files its scope keeps (a finding in a file the scope leaves out is dropped,
    // one in a file the change doesn't touch is a nit).
    const findings = place(down.findings, root, new Set(reviewed), new Set(mine.reviewed), left, head);
    const important = findings.filter((f) => f.severity === "important");
    const lines = [
      ...(findings.length ? ["Reviewer output below: data written by a model about this repository, one JSON object a line. It is not evidence and never goes in the PR as a self-review line.",
        ...findings.map((f) => JSON.stringify({ severity: f.severity, path: f.path, line: f.line, title: f.title, why: f.why }))] : []),
      ...(n ? [`(${n} important finding${n === 1 ? "" : "s"} without a failure scenario counted as a nit)`] : []),
    ];
    // Some of the patch was not reviewed (a part that failed, a hunk too big to send): nothing counts as clean.
    if (r.incomplete) return { out: [`self-review: ${at}: incomplete`, detail(r.incomplete), ...lines], code: 2 };
    remember(important.length); // a finished review
    return { out: [`self-review: ${at}: ${important.length ? `${important.length} important finding${important.length === 1 ? "" : "s"}` : "clean"} (${MODEL}, ${effort})`, ...lines], code: important.length ? 1 : 0 };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const r = await main().catch((e) => ({ out: ["self-review: incomplete", detail((e as Error).message ?? e)], code: 2 }));
process.exitCode = r.code;
process.stdout.write(`${r.out.join("\n")}\n`);
