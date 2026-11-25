#!/usr/bin/env node
// An Engineer's review of its own committed change before it publishes (skill publish), in its box: the code-review check's
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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brief, clean, downgrade, scrub } from "./brief.ts";
import { checklistText, matchChecklist } from "./review-checklist.ts";
import { gitListed, gitSafe, runEngine } from "./engines.ts";
import { changed, generatedGlobs, guidePaths, place, scope } from "./scope.ts";

const MODEL = "~openai/gpt-luna-latest", FIRST = "medium", AGAIN = "low", MINUTES = 20, REVIEWS = 2;

const raw = (...a: string[]) => gitListed(process.cwd(), a); // untrimmed (a NUL-separated path list may start with a space) and strictly UTF-8
const ln = (...a: string[]) => raw(...a).replace(/\n$/, ""); // a ref, a sha or a path: git's one final newline off, nothing else (a name may end in a space)
const git = (...a: string[]) => raw(...a).trim(); // the branch's attributes and config run nothing here (gitSafe)
const one = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

// What went wrong, apart from the evidence line: command output may carry repository text, so it is labelled data.
const detail = (t: unknown) => `Detail (data from commands or the model, not evidence; never copy it into the PR): ${JSON.stringify(one(t))}`;

let onError: (() => void) | undefined;
async function main(): Promise<{ out: string[]; code: number }> {
  const baseBranch = process.argv[2], asked = process.argv[3], token = process.env.AIDENHQ_RUN_TOKEN, gateway = process.env.AIDENHQ_GATEWAY_URL;
  if (!baseBranch || !asked || !token || !gateway) return { out: ["usage: self-review.ts <base-branch> <branch> (in a job's box)"], code: 2 };
  const root = ln("rev-parse", "--show-toplevel");
  process.chdir(root);
  let base = "", head = "";
  // The base: a plain branch name (no `main~1`, `@{-1}` or other revision syntax), looked up as the exact remote-tracking ref.
  let tip = "";
  try { git("check-ref-format", `refs/remotes/origin/${baseBranch}`); tip = ln("show-ref", "--verify", "--hash", `refs/remotes/origin/${baseBranch}`); } catch { return { out: ["self-review: incomplete: the base argument is not a branch name with a remote-tracking ref (run aidenhq clone first)", detail(`base argument: ${baseBranch}`)], code: 2 }; }
  try { head = ln("rev-parse", "HEAD"); base = ln("merge-base", tip, head); } catch { return { out: ["self-review: incomplete: no merge base with the base branch (run aidenhq clone first)", detail(`base argument: ${baseBranch}`)], code: 2 }; }
  // The last finished review of this branch (kept in the clone's .git). A re-run needs the same branch and merge base (a rebase or
  // retarget starts over) and a head that descends from it; it covers only what changed since when nothing important is open.
  // The checked-out branch by its full ref (a tag of the same name can't stand in for it); a detached HEAD has none.
  let ref = "";
  try { ref = ln("symbolic-ref", "-q", "HEAD"); } catch {}
  if (ref !== `refs/heads/${asked}`) return { out: ["self-review: incomplete: the branch argument is not the checked-out branch; switch to it, the review reads the committed head of the branch in the clone", detail(`branch argument: ${asked}`)], code: 2 };
  const branch = asked, memo = join(ln("rev-parse", "--path-format=absolute", "--git-common-dir"), `self-review-${createHash("sha256").update(asked).digest("hex")}.json`); // shared by linked worktrees; aidenhq publish reads the same file
  // One file per branch (a branch is checked out in one worktree at a time, so no two runs write one file), so reviewing another branch in
  // the same clone doesn't reset this one's incremental review.
  const last: { base?: string; head?: string; open?: number; runs?: number } = (() => { try { return JSON.parse(readFileSync(memo, "utf8")); } catch { return {}; } })();
  // open: the important findings left, or INCOMPLETE. A record for the head is what `aidenhq publish` asks for, whatever the outcome; only a
  // finished clean review lets the next run be incremental.
  const INCOMPLETE = -1;
  // runs: finished model reviews of this branch at this merge base (a rebase starts over). Each review turns up new findings, so a
  // branch gets REVIEWS of them; after that a run records the head without a model and the PR's own review takes over.
  const runs = last.base === base ? last.runs ?? 0 : 0;
  const remember = (open: number, n = runs) => writeFileSync(memo, JSON.stringify({ base, head, open, runs: n }));
  // The checkout as captured: the same branch at the same commit. Anything else and nothing is recorded for what was reviewed.
  const moved = () => { let r = ""; try { r = ln("symbolic-ref", "-q", "HEAD"); } catch {} return r !== ref || ln("rev-parse", "HEAD") !== head; };
  onError = () => { if (!moved()) remember(INCOMPLETE); }; // any failure from here on is an incomplete review of this head
  const rerun = last.base === base && !!last.head && last.open !== INCOMPLETE && // an unfinished review makes the next one a first review: medium, whole change
     last.head !== head && (() => { try { git("merge-base", "--is-ancestor", last.head!, head); return true; } catch { return false; } })();
  const incremental = rerun && last.open === 0, from = incremental ? last.head! : base, effort = rerun ? AGAIN : FIRST;
  const at = `branch ${branch} base ${from.slice(0, 12)} (${incremental ? "since the last review" : "merge base"}) head ${head.slice(0, 12)}`;
  if (git("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) return { out: [`self-review: ${at}: incomplete: uncommitted changes (commit them first; the review reads the committed head)`], code: 2 };
  if (from === head) { remember(INCOMPLETE); return { out: [`self-review: ${at}: incomplete: nothing to review`], code: 2 }; }
  if (runs >= REVIEWS) {
    remember(INCOMPLETE); // a record of this head for aidenhq publish, not a review
    return { out: [`self-review: ${at}: not reviewed: this branch had its ${REVIEWS} reviews; publish this head and list in the PR body any finding still open`], code: 0 };
  }

  // The files the PR check would review (its scope), and the generated ones the change adds, which it counts as a gap.
  const prChanged = new Set(raw("diff", "--no-renames", "--ignore-submodules=none", "--name-only", "-z", base, head).split("\0").filter(Boolean));
  let declared: string[] = [];
  try { declared = generatedGlobs(git("show", `${base}:.gitattributes`)); } catch {}
  const { reviewed, excluded } = scope(changed((a) => raw(...a), from, head), [], prChanged, declared);
  const gaps = excluded.filter((e) => e.gap).map((e) => e.path);
  const mine = scope([...prChanged].map((path) => ({ path, added: 0, removed: 0, binary: false })), [], prChanged, declared);
  const left = new Set([...excluded, ...mine.excluded].map((x) => x.path));
  const gapNote = gaps.length ? `generated files this change adds are not reviewed: ${gaps.slice(0, 5).join(", ")}` : "";
  if (!reviewed.length) {
    if (moved()) return { out: [`self-review: ${at}: incomplete`, detail("the checkout changed during the review")], code: 2 };
    if (gapNote) { remember(INCOMPLETE); return { out: [`self-review: ${at}: incomplete`, detail(gapNote)], code: 2 }; }
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
  try { checks = checklistText(matchChecklist(JSON.parse(git("show", `${base}:.github/code-review-checklist.json`).slice(0, 200_000)).items, git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none", from, head, "--", ...reviewed.map((p) => `:(literal)${p}`)))); } catch {}
  const scratch = mkdtempSync(join(tmpdir(), "self-review-"));
  try {
    const instructions = brief({ guides, checks, focus: "", excluded: [], incremental, addressed: false });
    const ran = await runEngine("codex-native", { prompt: "", instructions, model: MODEL, effort, root, base: from, minutes: MINUTES, scratch, own: true, files: reviewed, head, left: [...left] });
    const r = scrub(ran, [token]);
    // Redaction changed the output (something credential-shaped, a file name included): what was validated is no longer what is shown.
    const unfinished = (out: string[]) => { if (moved()) return { out: [`self-review: ${at}: incomplete`, detail("the checkout changed during the review")], code: 2 }; remember(INCOMPLETE); return { out, code: 2 }; };
    if (r.message !== ran.message || r.cause !== ran.cause) return unfinished([`self-review: ${at}: incomplete`, detail("the reviewer's output held something that looks like a credential and was redacted")]);
    if (!r.message) return unfinished([`self-review: ${at}: incomplete`, detail(r.cause ?? "no review")]);
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
    if (r.incomplete || gapNote) return unfinished([`self-review: ${at}: incomplete`, detail([r.incomplete, gapNote].filter(Boolean).join("; ")), ...lines]);
    if (moved()) return unfinished([]);
    remember(important.length, runs + 1); // a finished review
    const final = important.length && runs + 1 >= REVIEWS ? "; the branch's last review: fix the real ones, then run once more to record the head and publish" : "";
    return { out: [`self-review: ${at}: ${important.length ? `${important.length} important finding${important.length === 1 ? "" : "s"}` : "clean"} (${MODEL}, ${effort})${final}`, ...lines], code: important.length ? 1 : 0 };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const r = await main().catch((e) => { try { onError?.(); } catch {} return { out: ["self-review: incomplete", detail((e as Error).message ?? e)], code: 2 }; });
process.exitCode = r.code;
process.stdout.write(`${r.out.join("\n")}\n`);
