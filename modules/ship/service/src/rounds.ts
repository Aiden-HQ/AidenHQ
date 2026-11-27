// Rounds (spec §3): one decision per pass for every adopted PR (a task's and a member's alike), from merge-gate's decide. A round is
// a settled head: each (head, action) is acted on once. Ship's own effects come first (update-branch, the repair check job, the
// merge); the PR's task (the same task across rounds: the one that opened it, or the Engineer task ship files) is woken only for
// what the repair leaves, a red required check or review findings. Past a cap, or on a step the repo's settings exclude, the PR
// goes on hold with the reason and its owner is told (tell): a task's PR wakes whoever asked for the task, a member's gets the
// report comment and its author assigned. A new head clears a stalled hold. Only a member's PR gets the report comment.
// The loop (loop.ts) calls round() after intake() for each PR it read, with decide's answer and this pass's facts.
import { createHash } from "node:crypto";
import { advance, discovered, stageOf, suggestLines, type Gh } from "./actions.ts";
import type { Discovered } from "./discover.ts";
import { fileTask, recordTask, tasksOf, type Kept, type PrView } from "./handoff.ts";
import { queueNext, type QueueFacts, type QueueNext, type Queued } from "./queue.ts";
import { ACK, HOLD, renderReport, say, waitFacts, type Facts } from "./report.ts";
import { staleApproval, type Judged, type Risk } from "./safe.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";
import { GATE_CHECK } from "./aidenhq-sdk/checks.ts";
import { conventional } from "./title.ts";

/** merge-gate's decide answer for the PR at its head, with ship's context (github's merge-gate.ts Action). */
export type Decision = { do: "wait" | "repair" | "fix_ci" | "fix_review" | "approve" | "enqueue" | "merge" | "done" | "stall" | "fail"; why?: string };

/** This pass's facts beside decide: GitHub's mergeable state, the failing required checks and main's, and the generated paths. */
export interface RoundFacts extends QueueFacts {
  /** The head conflicts with the base (DIRTY), as opposed to merely being behind it. */
  dirty?: boolean;
  /** The PR is first in the repo's merge order (merges.ts) while its rules require up-to-date branches and there is no merge queue:
   * under `rebase: conflict`, only that PR is brought up to date (item 19). */
  front?: boolean;
  /** The target branch merges through a merge queue (mergePath): a behind branch is the queue's to handle, not "front"'s. */
  queue?: boolean;
  /** Required checks red on the head, and the same names red on the target branch's latest completed run. */
  failing?: string[]; onBase?: string[];
  /** Every named check red on the head, required or not: the product's branch protection requires only `ci-required`, so the
   * `policy` job's own red check is not in `failing` there, and the title-only wake needs it. */
  redChecks?: string[];
  /** Discovery on the target branch (discover.ts); the repo's `generated` setting wins over it. */
  discovered?: Discovered;
  /** safe.ts judge()'s answer at the head, where approval is needed: what the App approves on (and decide's ShipContext.approve). */
  approval?: Judged;
  /** The head's risk tier with its `by_tier` approve and merge (safe.ts riskOf, from code review's verdict). Without one nothing merges. */
  risk?: Risk;
  /** The merge gate's own decision (adopted.ts), as opposed to a stall ship raised itself: a stall from it clears on any later pass that decides otherwise. */
  decided?: boolean;
  /** Code review's findings at this head (its digest): a new set at the same head is a new fix_review. */
  findingsKey?: string;
  /** Members' review comments nobody has answered (github's member-comments.ts): they stand like findings, and a new one is a new fix_review. */
  memberComments?: { id: string; kind: string; author: string; path?: string; line?: number }[];
  /** Red at a head behind a green base: GitHub's update-branch is tried once at this head before any fix_ci wake. */
  behindGreen?: boolean;
}

export interface RoundDeps {
  state: State;
  settings(repo: string): ShipSettings | null;
  paused(): boolean;
  /** The kernel, as ship: wakes, write records (github.merge), their state, and closing a hand-off's task. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any> };
  /** Code review's gating review of the PR's head (effects.ts askFresh): a model fix its last review doesn't carry to. */
  askFresh(url: string, head: string): Promise<void>;
  /** GitHub's update-branch bound to the head (expected_head_sha): a clean merge of the base, no conflict. */
  updateBranch(repo: string, number: number, head: string): Promise<void>;
  assign(repo: string, number: number, logins: string[]): Promise<void>;
  /** Removes the logins ship itself assigned when it raised a hold; a person's own assignment is never one of them. */
  unassign(repo: string, number: number, logins: string[]): Promise<void>;
  /** The code host's comment op (POST /v1/codehost/comment): posts, or edits comment `id`; answers the comment's id. */
  comment(repo: string, number: number, body: string, id?: number): Promise<number>;
  log(msg: string, f?: Record<string, unknown>): void;
  /** GitHub as the owner (github's /internal/ship/gh): the repo's own actions and discovery (actions.ts). Without it, neither runs. */
  gh?: Gh;
  /** The `policy` job at the head: its Actions job id (re-run on an unreadable failure) and which of its steps failed. `"other"`
   * when another of the job's steps (the age and pin checks) failed too, so no title edit clears the check; `"unknown"` when its
   * steps can't be read. Undefined when the job itself can't be found. */
  policyJob?: (repo: string, head: string) => Promise<{ job: string; step: "title" | "other" | "unknown" } | undefined>;
  /** Re-runs the `policy` job (POST actions/jobs/{id}/rerun): a fresh attempt's steps can be read where a timed-out one's can't. */
  policyRerun?: (repo: string, head: string, job: string) => Promise<"accepted" | "refused">;
}

const OPEN = ["review", "owner", "approved", "claimed", "done"];

/** The repair's plan for the box: the repo's `generated` setting, else what discovery found on the target branch. `command: null`
 * is the repo's CI regenerating those paths: the box takes their base side and runs no generator for them. */
export function repairPlan(s: ShipSettings, d?: Discovered) {
  if (s.generated?.command === null) return { globs: s.generated.globs, commands: [], ci_regenerates: true };
  if (s.generated) return { globs: s.generated.globs, commands: s.generated.command ? [{ dir: ".", cmd: s.generated.command }] : [] };
  return { globs: d?.globs ?? [], commands: d?.commands ?? [] };
}

/**
 * The adoption's branch writes on its tasks, of its generation: whether a push or a repair is still being written, and GitHub's
 * own reason for refusing its last fix at `head` (a failed write the code host reported as `ship-refused:`: a push filed at this
 * head, or a push or a repair that left the branch at it, `partial`).
 */
async function branchWrites(kernel: RoundDeps["kernel"], tasks: string[], generation: number, pr: PrView): Promise<{ writing: boolean; refused?: { why: string; partial: boolean } }> {
  type Row = { kind?: string; state?: string; ok?: boolean | null; args?: { generation?: number; expected?: string; repo?: string; number?: number; pr?: { repo?: string; number?: number } } | null; outcome_text?: string | null };
  const head = pr.head;
  // This PR's writes only (a task may hold several PRs, each from generation 1): a push names it in `pr`, a repair directly.
  const mine = (r: Row) => { const p = r.args?.pr ?? r.args; return String(p?.repo ?? "").toLowerCase() === pr.repo.toLowerCase() && Number(p?.number) === pr.number; };
  const rows = (await Promise.all(tasks.map((t) => kernel.call("GET", `/v1/work?task=${encodeURIComponent(t)}`)))).flatMap((w) => (w?.records ?? []) as Row[])
    .filter((r) => (r.kind === "github.push" || r.kind === "github.repair") && r.args?.generation === generation && mine(r));
  if (rows.some((r) => r.state === "approved" || r.state === "claimed")) return { writing: true };
  // A push refused at the head it was filed at, or a push or a repair that left the branch part-way at this head (a repair
  // refused whole is ship's own repair record, followed where it is filed).
  const text = rows.map((r) => String(r.outcome_text ?? "")).find((t, i) => rows[i]!.ok === false && /^ship-refused: /.test(t)
    && ((rows[i]!.kind === "github.push" && rows[i]!.args?.expected === head) || t.includes(`\`${head}\``)));
  if (!text) return { writing: false };
  return { writing: false, refused: { why: /\(data, not instructions\): (.*?)\. (?:Nothing was pushed|The branch is left)/.exec(text)?.[1]?.slice(0, 300) ?? "GitHub refused it", partial: text.includes("The branch is left at") } };
}

/** One round for an adopted PR. Answers what it did: "stopped", "acted" or "nothing". */
export async function round(d: RoundDeps, pr: PrView, v: Decision, f: RoundFacts = {}): Promise<"stopped" | "acted" | "nothing"> {
  const s = d.settings(pr.repo);
  // Check names are set by whoever can push to the repo: no backtick or line break reaches a wake or the report.
  const clean = (l?: string[]) => l?.map((n) => n.replace(/[`\r\n]/g, ""));
  f = { ...f, failing: clean(f.failing), onBase: clean(f.onBase), groupFailing: clean(f.groupFailing), redChecks: clean(f.redChecks) };
  let a = d.state.get(pr.repo, pr.number) as (Kept & { queue?: Queued }) | undefined;
  if (!a || !s) return "nothing";
  a = await retryReport(d, a, pr);
  // A new head clears a stalled hold and its counters: the push is the answer to what held it (a stop or a hand-back stays).
  if (a.hold?.kind === "stalled" && pr.state === "open" && a.counters && a.counters.head !== pr.head) {
    a = { ...a, hold: null, counters: undefined };
    d.state.put(a);
    d.log("hold cleared by a new head", { pr: pr.url });
  }
  // A stall from the gate's decision (a review, a resolved thread, a label) is over once the gate no longer says stall: ship takes
  // back its own assignment and goes on. A pause, a draft, the stop label or a person's assignment is checked first: a stopped PR is
  // neither resumed nor unassigned.
  if (a.hold?.kind === "stalled" && a.hold.onChange && pr.state === "open" && v.do !== "stall" && !d.paused() && !pr.draft && !pr.labels.includes(s.stop_label) && !pr.assignees.some((x) => !(a!.assigned ?? []).includes(x))) {
    // A refused unassignment keeps the record, so ship's own assignee is never read as a person's stop.
    let undone = true;
    if (a.assigned?.length) await d.unassign(pr.repo, pr.number, a.assigned).catch((e) => { undone = false; d.log("unassign failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }); });
    const { assigned: kept, ...rest } = a;
    // The hold's report is replaced by what this pass says, even when it is the line said before the stall.
    a = { ...rest, ...(undone ? {} : { assigned: kept }), hold: null, ...(a.counters ? { counters: { ...a.counters, lastRound: undefined } } : {}) } as typeof a;
    d.state.put(a);
    d.log("stall cleared: the gate no longer says stall", { pr: pr.url });
  }
  // Stopped: nothing moves while ship is paused, the PR is closed or a draft, on hold, stopped by label, or a person is assigned.
  // Landed: a hand-off's task ends with it (a task's PR tells its task instead), whatever else holds the PR.
  if (pr.state === "merged" && v.do === "done") {
    if (a.counters?.lastRound !== `${pr.head}:done`) {
      // Closed before it is recorded: a close that failed is tried again next pass (an already-closed task answers ok).
      // A queued merge must land on the base the enqueue was bound to; anywhere else it is reported, not closed as done.
      if (a.queue && a.queue.base !== pr.base) {
        // A person checks the mismatch: ship settles none of its tasks here, and the record says so to `gone()`'s reconciler.
        const { closing: _, ...settled } = a;
        a = { ...settled, tasksClosed: true, counters: { ...(a.counters ?? { head: pr.head, wakes: 0, rounds: 0, ci: 0, review: 0, red: {} }), lastRound: `${pr.head}:done` } };
        d.state.put(a);
        a = await report(d, a, pr, { kind: "hold", text: `Merged into \`${pr.base}\`, not the base it was queued for (\`${a.queue.base}\`). A person checks that this is what was meant.` });
        return "acted";
      }
      // A hold's queued closes (`closing`, a refusal kept for the next pass) land here too, so the queue never outlives the PR.
      for (const t of [...new Set([...(a.closing ?? []), ...tasksOf(a)])]) {
        try { await d.kernel.call("POST", `/v1/tasks/${t}/close`, { status: "done", body: `${pr.url} is merged.` }); } catch (e) {
          d.log("task close failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
          return "nothing";
        }
      }
      // Told before it is recorded: a wake the kernel didn't take is sent again next pass.
      if (a.owner?.kind === "task") await tell(d, a, pr, `**Merged:** ${pr.url} is merged at \`${pr.head.slice(0, 12)}\`. Finish your task if this was its change.`, `merged.${pr.head.slice(0, 12)}`);
      // The closes are done: the queue goes with the `done` marker and the record is settled, so nothing reads it again.
      const { closing: _, ...settled } = a;
      a = { ...settled, tasksClosed: true, counters: { ...(a.counters ?? { head: pr.head, wakes: 0, rounds: 0, ci: 0, review: 0, red: {} }), lastRound: `${pr.head}:done` } };
      d.state.put(a);
      a = await report(d, a, pr, { kind: "merged" });
    }
    return "acted";
  }
  const people = pr.assignees.filter((x) => !(a!.assigned ?? []).includes(x));
  if (d.paused() || a.hold || pr.state !== "open" || pr.draft || pr.labels.includes(s.stop_label) || people.length) return "stopped";

  const c = a.counters && a.counters.head === pr.head ? a.counters : { ...(a.counters ?? { rounds: 0, ci: 0, review: 0, red: {} }), head: pr.head, wakes: 0, acted: [], membersAsked: [] };
  a = { ...a, counters: c };
  // A head whose required checks are green (it is ready, or waits only on review) ends a run of red heads: the CI caps count again.
  if (["merge", "approve"].includes(v.do) && (c.ci || Object.keys(c.red).length)) { c.ci = 0; c.red = {}; }
  const caps = s.caps;
  const over = (n: number, cap: number | null) => cap !== null && n >= cap;
  // A conflict's repair needs the generated paths: the repo's setting, else discovery on the target branch (actions.ts). Discovery
  // also proposes the repo's own regenerate command for the report.
  if (v.do === "repair" && f.dirty && !f.discovered && d.gh) {
    try { f = { ...f, discovered: await discovered(d.gh, pr.repo, pr.base) }; } catch (e) { d.log("discovery failed", { repo: pr.repo, err: String((e as Error).message).slice(0, 200) }); }
  }
  const suggest = suggestLines(f.discovered, s.actions);
  const j = f.approval;
  const risk = f.risk;
  const merge = risk?.merge ?? "off";
  const save = async (f: Facts) => { d.state.put(a!); a = await report(d, a!, pr, f); };
  const hold = async (reason: string, plain: string, onChange = false) => {
    // Its owner is told: a task's PR wakes whoever asked for the task; a member's PR assigns its author (and the report says why).
    const assign = a!.owner?.kind === "task" || pr.authorBot || !pr.author ? [] : [pr.author];
    if (assign.length) await d.assign(pr.repo, pr.number, assign).catch((e) => d.log("assign failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }));
    if (a!.owner?.kind === "task") await tell(d, a!, pr, `**Ship stopped on ${pr.url}** at \`${pr.head.slice(0, 12)}\`: ${reason}. A new push resumes it. Decide its next step: re-scope the task, fix the cause another way, or tell the owner.`, `hold.${pr.head.slice(0, 12)}.${c.rounds}.${c.wakes}`, true);
    a = { ...a!, hold: { kind: "stalled", reason, at: new Date().toISOString(), ...(onChange ? { onChange: true as const } : {}) }, assigned: assign };
    d.log("hold", { pr: pr.url, reason });
    await save({ kind: "hold", text: plain });
    return "acted" as const;
  };
  // A fork's branch takes ship's commits only where its author allows maintainer edits (and GitHub accepts the App's write).
  const noEdits = "it needs a change on its fork's branch, and the fork doesn't allow maintainer edits: the contributor can enable \"Allow edits by maintainers\", rebase or fix it (a new commit from the contributor then needs a member to hand it off again)";
  const wake = async (kind: string, text: string) => {
    if (over(c.wakes, caps.wakes_per_head)) return hold(`woke the task ${c.wakes} times on this head (wakes_per_head)`, HOLD.cap);
    // The kernel keeps 2,000 characters of a wake.
    text = text.slice(0, 2000);
    // The first job files the adoption's task (which starts the Engineer on it); later ones wake that same task.
    if (!a!.task) a = { ...a!, task: await fileTask(d.kernel, pr, a!.generation, text) };
    // The wake's own key: a retry of one whose answer was lost posts nothing twice.
    else if ((await d.kernel.call("POST", "/v1/wakes", { task: a!.task, text, id: wakeKey(`${pr.repo}#${pr.number}:${kind}:${pr.head}:${c.wakes}`) }))?.closed) {
      // Someone closed or cancelled the task: that ends the adoption until a fresh hand-off.
      a = { ...a!, hold: { kind: "handed_back", reason: "its task was closed", at: new Date().toISOString() } };
      await save({ kind: "hold", text: HOLD.closed });
      return "acted" as const;
    }
    c.wakes++;
    a = { ...a!, did: [...(a!.did ?? []), `${kind} at \`${pr.head.slice(0, 12)}\``] };
    return "acted" as const;
  };

  // The adoption's own branch writes, read on a head's first round and while a wake at it is out. A push or a repair still being
  // written moves the branch more than once (GitHub's signed commits, its merge of the base): its in-between heads are its own,
  // so nothing is decided on them. A fix GitHub refused to take (a repository rule) holds the PR with GitHub's reason for a
  // person, as a refused enqueue does. A read that fails decides nothing this pass.
  const writers = [a.task, a.holder].filter((t): t is string => Boolean(t));
  if (writers.length && (c.wakes > 0 || !String(c.lastRound ?? "").startsWith(pr.head))) {
    let w: { writing: boolean; refused?: { why: string; partial: boolean } };
    try { w = await branchWrites(d.kernel, writers, a.generation, pr); }
    catch (e) { d.log("branch writes unread", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }); return "nothing"; }
    if (w.writing) return "nothing";
    if (w.refused) return hold(`GitHub refused the push of ship's fix: ${w.refused.why}`, w.refused.partial ? HOLD.pushPartial : HOLD.pushRefused(w.refused.why));
  }

  // A model fix the last review doesn't carry to: code review is asked once for a review of this head (never under observe).
  if (j?.ask && risk?.approve === "on" && a.freshAsked !== pr.head) {
    try {
      await d.askFresh(pr.url, pr.head);
      a = { ...a, freshAsked: pr.head, did: [...(a.did ?? []), `asked code review for a review of \`${pr.head.slice(0, 12)}\``] };
      d.state.put(a);
    } catch (e) {
      d.log("fresh review ask failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
    }
  }

  /**
   * An App approval made on an earlier head, under another policy, or where the tier's approve is no longer `on` never counts
   * (staleApproval): its dismissal is filed first (github.approve with `dismiss`, as the App), at a wait, a merge, an enqueue or an
   * approve, and the round after it decides again: approved at this head under the current policy, or waiting for a person's.
   * "acted" or "nothing" while it is in hand, else undefined.
   */
  const dismissStale = async (): Promise<"acted" | "nothing" | undefined> => {
    const ap = a!.approve;
    if (!risk || !staleApproval(ap, pr.head, risk)) return undefined;
    if (ap!.dismissed) {
      const r = await d.kernel.call("GET", `/v1/writes/${ap!.dismissed}`);
      if (r.state === "done") { const { approve: _, ...rest } = a!; a = { ...rest, did: [...(a!.did ?? []), `dismissed the App's earlier approval (made on another commit or under another review policy)`] } as typeof a; return "acted"; }
      if (OPEN.includes(String(r.state))) return "nothing";
      // The PR moved while it was filed (it is bound to the head it was filed at): filed again at this one, below.
      if (!/^ship-head-moved/.test(String(r.outcome?.text ?? ""))) {
        await hold(`dismissing the App's approval at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)} (${String(r.outcome?.text ?? r.reason ?? "no reason given").slice(0, 200)})`, HOLD.failed);
        return "acted";
      }
    }
    const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
    if (holder) a = { ...a!, holder };
    const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.approve", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, dismiss: true } });
    a = { ...a!, approve: { ...ap!, dismissed: String(r.id) }, did: [...(a!.did ?? []), `asked to dismiss the App's approval of \`${ap!.head.slice(0, 12)}\` (made on another commit or under another review policy)`] };
    return "acted";
  };
  const push = () => `Start from the PR's head with \`aidenhq ship checkout ${pr.url} ${pr.head}\`, commit your fix there, and push it with \`aidenhq ship push ${pr.url} ${pr.head} ${a!.generation}\`.`;
  // Behind only, under `rebase: conflict`: brought up to date only at the front of the repo's merge order; the rest wait their turn.
  if (v.do === "repair" && !f.dirty && s.rebase === "conflict" && !f.front && !f.queue) return "nothing";
  // The repo's own commands and workflows for the stage this round needs (actions.ts), before ship's own step for it.
  const stage = stageOf(v.do, f.dirty);
  const steps = stage && d.gh && (stage === "before_merge" ? merge !== "off" : s.fix.includes("conflicts")) ? s.actions[stage] ?? [] : [];
  if (stage && steps.length) {
    // Each step started spends a round.
    const r = await advance(d.gh!, pr, stage, steps, a!.action, () => (over(c.rounds, caps.rounds) ? false : (c.rounds++, true)));
    if (r.go === "capped") return hold(`${c.rounds} rounds (rounds)`, HOLD.cap);
    const changed = r.rec !== a!.action;
    a = { ...a!, ...(r.rec ? { action: r.rec } : {}), ...(r.did ? { did: [...(a!.did ?? []), r.did] } : {}) };
    if (r.go === "waiting") return "nothing";
    if (r.go === "started") { await save({ kind: "active" }); return "acted"; }
    if (r.go === "failed" && stage === "before_merge") return hold(`the repo's before_merge steps didn't pass (${a.action?.why ?? "failed"})`, HOLD.steps);
    if (changed) d.state.put(a);
  }
  // A queue branch: the removal is read here. A red required check on the merge_group run that is this PR's own is a fix_ci round.
  let qn: QueueNext | undefined, viaQueue = false;
  if (v.do === "enqueue" && merge !== "off") {
    qn = await queueNext(d.kernel, a.queue, pr, f);
    if (qn.act === "fix_ci") { v = { do: "fix_ci", why: "a required check failed on its merge queue run" }; f = { ...f, failing: qn.failing }; viaQueue = true; qn = undefined; }
  }
  // A round is a settled head: each (head, action) is taken once; a merge or a conflict's repair is followed by its record instead.
  // A wait is said again when its kind (what a person is asked for) changes; every other action once per head.
  // Review findings are keyed by their digest: a new set at the same head is asked again.
  // The `policy` job's title step (and `ci-required`, the aggregate that rolls it up) is the PR's metadata, not its code: no
  // commit can turn it green (ci.yml re-runs `policy` on `edited`), so the wake asks for the title instead of "one commit". The
  // test is on this head's own required reds: a check that also fails on the base is pre-existing and its name must not hide the
  // metadata case. Since branch protection may require only `ci-required`, the `policy` job's own red is read from every named
  // check at the head (`redChecks`), and `policy` failing on the base too is not this PR's. A queue run is the merge tree's, not
  // this head's: there the commit instruction stays.
  const baseRed = new Set(f.onBase ?? []);
  const headRed = [...new Set([...(f.failing ?? []), ...(f.redChecks ?? [])])];
  const metadata = (n: string) => n === "policy" || n === GATE_CHECK;
  // `policy` is judged by its own job's steps below, never by its base-red name alone: a base run red on the age check says
  // nothing about whether this head's title step is the failure.
  const ownHead = headRed.filter((n) => n !== "policy" && !baseRed.has(n));
  const candidate = v.do === "fix_ci" && !viaQueue && headRed.includes("policy") && ownHead.every(metadata);
  // The `policy` job also runs the lockfile age and pin checks: a title edit clears only the title step. Its own steps are read on
  // every pass a metadata-only red sits at the head, not only the first: a title edit re-runs the job at the same SHA, and a new
  // run's failure (an age or pin step red now) is judged on its own instead of deduplicating against the old title diagnosis.
  const policy = candidate && d.policyJob ? await d.policyJob(pr.repo, pr.head).catch(() => undefined) : undefined;
  const policyStep = policy?.step;
  const titleInvalid = pr.title !== undefined && !conventional(pr.title);
  // A retitle is asked for on two evidences, both required: the job names its title step as the failure, and the PR's title actually
  // fails the Conventional Commit rule. The step also fails when its own request to GitHub did, on a title the rule accepts: a
  // retitle of that title writes nothing (the write answers "already this title") and the check never re-runs, so it is no fix.
  const titleFix = candidate && policyStep === "title" && titleInvalid;
  // The job blames its title step on a title that already passes the rule (the step's own GitHub request failed): a fresh attempt is
  // the recovery, never a title edit. Unreadable steps are the same recovery with less to say: neither asks the Engineer to guess.
  const policyUnclear = candidate && !titleFix && policyStep !== "other";
  // Why the job's own verdict is no fix: it blamed its title step on a title the rule already accepts (`titleStep`) or on a title
  // the view didn't carry (`titleUnread`), or its steps couldn't be read at all (`unreadable`).
  const policyWhy: "titleStep" | "titleUnread" | "unreadable" = policyStep !== "title" ? "unreadable" : pr.title === undefined ? "titleUnread" : "titleStep";
  // A title-only CI wake is its own action at the head: it fixes no commit, so a real red check at the same head is still woke for.
  // The unclear case is keyed apart too, so a later confirmed diagnosis wakes as its own action.
  // Members' comments key the fix by the ones not asked about yet; the same ones still open at this head are not asked again
  // (answering one of two threads wakes nobody), and a new head asks again for any left.
  const open = f.memberComments ?? [];
  const fresh = open.filter((i) => !(c.membersAsked ?? []).includes(i.id));
  // A wake names the new items (every open one when none is new: a new head's re-ask), at most eight conversation comments: the key,
  // the wake's text and what is recorded as asked are all this batch, so the ones left over are new again next pass.
  const pool = fresh.length ? fresh : open;
  const named = [...pool.filter((i) => i.kind === "thread"), ...pool.filter((i) => i.kind === "comment").slice(0, 8)];
  const reviewKey = [f.findingsKey, fresh.length ? createHash("sha256").update(named.filter((i) => fresh.includes(i)).map((i) => i.id).join(",")).digest("hex").slice(0, 12) : ""].filter(Boolean).join(":") || (open.length ? "comments" : "");
  const act = v.do === "fix_review" && reviewKey ? `fix_review:${reviewKey}`
    : v.do === "fix_ci" && titleFix ? "fix_ci:title"
    : v.do === "fix_ci" && policyUnclear ? "fix_ci:policy-unread"
    : v.do;
  const key = v.do === "wait" ? `${pr.head}:wait:${say(waitFacts(v.why)).text}` : `${pr.head}:${act}`;
  // A wait with an App approval to dismiss (or a dismissal in flight) is followed too: its record is read each pass.
  const followed = v.do === "merge" || v.do === "enqueue" || v.do === "approve" || (v.do === "repair" && f.dirty === true) || (v.do === "wait" && !!risk && staleApproval(a.approve, pr.head, risk));
  // A fix already asked for at this head is not asked again after a `wait` in between (a CI re-run with no push).
  const fix = ["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty);
  if (!followed && (c.lastRound === key || (fix && (c.acted ?? []).includes(act)))) return "nothing";
  // Each new action spends a round; past `rounds` the PR holds.
  const spend = () => (over(c.rounds, caps.rounds) ? hold(`${c.rounds} rounds (rounds)`, HOLD.cap) : (c.rounds++, undefined));
  let queueWait: string | undefined, updatedOnly = false, ownerWait = false;
  const step = async (): Promise<"acted" | "nothing"> => {
    if (["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty)) {
      const held = spend();
      if (held) return held;
    }
    switch (v.do) {
      case "repair": {
        if (!s.fix.includes("conflicts")) return hold("it needs a repair, and this repo's `fix` setting excludes conflicts", HOLD.settings("fix merge conflicts"));
        // A fork's branch takes ship's writes (update-branch too) only where its author allows maintainer edits.
        if (pr.fork && !pr.canModify) return hold(noEdits, HOLD.noEdits);
        if (!f.dirty) {
          // GitHub refusing the update (a rule, a permission) holds with its reason rather than asking every pass.
          try { await d.updateBranch(pr.repo, pr.number, pr.head); }
          catch (e) {
            // A refusal (a 4xx but a rate limit) holds; anything else is asked again next pass.
            const why = String((e as Error).message), status = Number(/: (\d{3})\b/.exec(why)?.[1]);
            if (status >= 400 && status < 500 && status !== 429 && !/rate limit/i.test(why)) return hold(`GitHub refused to update the branch with \`${pr.base}\`: ${why.slice(0, 200)}`, HOLD.github);
            throw e;
          }
          a = { ...a!, did: [...(a!.did ?? []), `updated the branch with \`${pr.base}\``] };
          return "acted";
        }
        // A conflict: ship's repair check job (no model) first, as github's `repair` effect; the Engineer gets only what it leaves.
        // `noop`: the base tip the repair found already in the head (GitHub's DIRTY outlived the push that took the base in).
        let noop: string | undefined;
        if (a!.repair?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.repair.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          const text = String(r.outcome?.text ?? r.reason ?? "");
          // Done (or the PR moved meanwhile): the next head is the next round's.
          if (r.state === "done" || /^ship-head-moved/.test(text)) return "nothing";
          if (r.state !== "failed") return hold(`ship's repair was ${r.state}: ${text.slice(0, 300)}`, HOLD.repair);
          // Nothing to merge: nobody is woken, and this head and base tip are not asked again while GitHub still says DIRTY. A new
          // head is a new round; a new tip of the default branch (the only base this pass reads) is repaired again.
          noop = /^ship-noop: .* already holds `[^`]*` at `([0-9a-f]{40})`/.exec(text)?.[1];
          if (noop && (!pr.baseOid || pr.baseOid === noop)) return "nothing";
          const left = text.split("\n").filter((l) => l.startsWith("leftover: ")).length;
          // The box lacks the generator's tool: the Engineer's computer is the same image, so the PR holds, and the report suggests
          // the repo's own workflow as an `actions` step.
          const missing = /^ship-generator/.test(text) && /^toolchain missing: ([\w.+-]{1,60})/m.exec(text)?.[1];
          if (missing) return hold(`toolchain missing: ${missing} (the repair box doesn't have it): configure the repo's own regenerate workflow as an \`actions\` step for conflicts${suggest.length ? ` (${suggest[0]})` : ""}, or set \`generated.command: null\` when the repo's CI regenerates these paths`, HOLD.repair);
          if (/^ship-leftovers/.test(text) || /^ship-generator/.test(text)) {
            if (a!.repair.woke) return "nothing";
            a = { ...a!, repair: { ...a!.repair, woke: true } };
            return wake("repair", [
              /^ship-leftovers/.test(text)
                ? `${pr.url} conflicts with \`${pr.base}\` at head ${pr.head}, and ship's repair left ${left} conflict(s) no generator rewrites (its outcome is on record ${a!.repair!.record}).`
                : `${pr.url} conflicts with \`${pr.base}\` at head ${pr.head}, and ship's repair stopped on a generator (its outcome is on record ${a!.repair!.record}).`,
              s.generated?.command === null
                ? `Resolve it as the \`ship\` skill says: merge \`origin/${pr.base}\` in, resolve, take the base side of the generated files (${s.generated.globs.map((g) => `\`${g}\``).join(", ") || "none listed"}) and don't regenerate them: the repo's CI does. One commit.`
                : `Resolve it as the \`ship\` skill says: merge \`origin/${pr.base}\` in, resolve, regenerate the generated files, one commit.`,
              push(),
            ].join("\n"));
          }
          // A run that didn't finish (nothing kept) is asked for once more at this head; anything else holds with its reason.
          if (!noop && (!/^ship-repair:/.test(text) || a!.repair.retried)) return hold(`ship's repair couldn't write the branch: ${text.split("\n")[0]!.slice(0, 300)}`, HOLD.repair);
        }
        // A no-op at a base that has since moved is a fresh repair, not a retry.
        const retry = a!.repair?.head === pr.head && !noop;
        const held = spend();
        if (held) return held;
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.repair", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, plan: repairPlan(s, f.discovered), ...(retry ? { attempt: 2 } : {}) } });
        a = { ...a!, repair: { head: pr.head, record: String(r.id), ...(retry ? { retried: true } : {}) }, did: [...(a!.did ?? []), `ran the repair (merge \`${pr.base}\`, regenerate) at \`${pr.head.slice(0, 12)}\``] };
        return "acted";
      }
      case "fix_ci": {
        if (!s.fix.includes("ci")) return hold("a required check is red, and this repo's `fix` setting excludes CI", HOLD.settings("fix CI"));
        // A metadata-only failure is a title edit or a log read: neither touches the fork's branch, so a fork the fleet can't push to
        // (the title is the base repo's, and the job's log needs no edit permission) gets the same wake the base repo's PR does.
        if (!titleFix && !policyUnclear && pr.fork && !pr.canModify) return hold(noEdits, HOLD.noEdits);
        // Red while behind a green base: perhaps only the base moved. GitHub updates the branch once at this head before any wake;
        // a refusal has spent its round and the fix follows.
        if (!titleFix && !policyUnclear && f.behindGreen && c.updated !== pr.head) {
          c.updated = pr.head;
          try {
            await d.updateBranch(pr.repo, pr.number, pr.head);
            a = { ...a!, did: [...(a!.did ?? []), `updated the branch with \`${pr.base}\` (red while behind it)`] };
            // Not the fix: if the head is still red here next pass, the task is woken.
            updatedOnly = true;
            return "acted";
          } catch (e) { d.log("update-branch refused", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }); }
        }
        const failing = f.failing ?? [];
        const onBase = new Set(f.onBase ?? []);
        const own = failing.filter((n) => !onBase.has(n));
        // Failing on the target branch too: likely pre-existing. The Engineer judges it with evidence; it spends no CI round. A
        // title-only wake spends no CI round either: it asks for no code, so a real code failure at the same head after it still
        // has the head's rounds to fix (titleFix was computed above). The wake that only asks for the job's log spends none either.
        if (own.length && !titleFix && !policyUnclear) {
          for (const n of own) c.red[n] = [...new Set([...(c.red[n] ?? []), pr.head])];
          const repeat = own.find((n) => over(c.red[n]!.length, caps.same_check_heads));
          if (repeat) return hold(`required check \`${repeat}\` failed on ${c.red[repeat]!.length} heads (same_check_heads)`, HOLD.cap);
          if (over(c.ci, caps.ci_rounds)) return hold(`${c.ci} CI fix rounds (ci_rounds)`, HOLD.cap);
          c.ci++;
        }
        // The `policy` job's steps can't be read (a timed-out attempt leaves no failed step): one re-run at this head gives a fresh
        // attempt whose steps can be, after which the round wakes the fix that matches it (a title edit, or a code fix) instead of
        // asking for a log read forever. Asked once per head; a refusal is reported and never retried, so a job GitHub won't re-run
        // cannot spend a wake on every pass.
        let reran: "accepted" | "refused" | undefined;
        if (policyUnclear && policy && d.policyRerun && c.policyRerun !== pr.head) {
          c.policyRerun = pr.head;
          reran = await d.policyRerun(pr.repo, pr.head, policy.job).catch(() => "refused" as const);
          a = { ...a!, did: [...(a!.did ?? []), `asked GitHub to re-run the \`policy\` job at \`${pr.head.slice(0, 12)}\` (${reran})`] };
          d.log("policy job re-run", { pr: pr.url, job: policy.job, reran });
        }
        return wake("fix_ci", [
          `${pr.url}: required checks are red at head ${pr.head}: ${(titleFix || policyUnclear ? [...new Set([...failing, ...(f.redChecks ?? [])])] : failing).map((n) => `\`${n}\``).join(", ") || "(see the PR's checks)"}.`,
          viaQueue ? "They passed on the PR's head but failed on the merge queue's run for it (the `merge_group` run): read that run's logs, the failure is in the PR merged onto the base." : "",
          // A `policy` red on the base is a step of that job, not necessarily the title step: the wake says so only where the job
          // itself named the title step as this head's failure.
          onBase.size ? `These fail on \`${pr.base}\`'s latest run too: ${[...onBase].filter((n) => !(n === "policy" && titleFix)).map((n) => `\`${n}\``).join(", ")}. If the failure is the same there, it is pre-existing: say so on the task with the run you compared, and change nothing for it.` : "",
          ...(titleFix ? [
            "The red check is the PR's Conventional Commit title (the `policy` job's title step), which no commit can fix: a title edit re-runs `policy` in place.",
            `Fix the title with \`aidenhq ship title ${pr.url} ${pr.head} ${a!.generation} "<type>(<scope>): <summary>"\` (types: feat, fix, docs, chore, test, refactor, perf, ci, build, style, revert), giving the title that describes this PR. Change nothing in the code for it: a check, test or lint rule stays as strict as you found it.`,
          ] : policyUnclear ? [
            policyWhy === "titleStep"
              ? `Only metadata is red here, and the \`policy\` job blames its title step, but this PR's title already passes the Conventional Commit rule: the step failed for another reason (its own request to GitHub), and a title edit would change nothing. ${reran === "accepted" ? "Ship asked GitHub to re-run `policy` once at this head; change nothing while it runs." : `Read that job's run (${pr.url}/checks) and say on the task why it failed; no title edit is asked for.`}`
              : policyWhy === "titleUnread"
              ? `Only metadata is red here, and the \`policy\` job blames its title step, but the PR's title didn't reach this pass: read the title (${pr.url}) and, if it doesn't read as a Conventional Commit, re-file with \`aidenhq ship title\`; say on the task what you found either way.`
              : reran === "accepted"
              ? `Only metadata is red here, and the \`policy\` job's own steps at this head don't show which step failed: ship asked GitHub to re-run \`policy\` once at this head, and wakes the fix that matches the fresh run's steps (a title edit, or a code fix). Change nothing while it runs; if its steps still can't be read afterwards, say on the task what ${pr.url}/checks shows.`
              : `Only metadata is red here, but the \`policy\` job's own steps at this head don't show which step failed, and ship can't re-run it (${reran === "refused" ? "GitHub refused the re-run" : d.policyRerun ? "no re-run was asked" : "no re-run is available here"}): read that job's run (${pr.url}/checks) and say on the task which step failed. Ship wakes the fix that matches it; nothing here asks you to guess.`,
          ] : [
            "Fix what this PR broke as the `ship` skill says: one commit, never weaken a check.",
            push(),
          ]),
        ].filter(Boolean).join("\n"));
      }
      case "fix_review": {
        if (!s.fix.includes("review")) return hold("review findings are open, and this repo's `fix` setting excludes review", HOLD.settings("fix review findings"));
        // Answering a comment needs no push: only a fork with nothing open to answer needs its edits (replies go on without them).
        const replyOnly = pr.fork && !pr.canModify;
        if (replyOnly && !f.memberComments?.length) return hold(noEdits, HOLD.noEdits);
        // How many review and fix cycles a PR gets is code review's (its push_rounds): ship fixes what each review finds.
        c.review++;
        const threads = named.filter((i) => i.kind === "thread"), comments = named.filter((i) => i.kind === "comment");
        const did = await wake("fix_review", [
          open.length && !f.findingsKey && v.why !== "changes are requested on it"
            ? `${pr.url}: members have open review comments at head ${pr.head}. Verify each as the \`ship\` skill says: fix the real ones in one commit, decline the rest with evidence.`
            : `${pr.url}: code review has open important findings (or changes requested) at head ${pr.head}. Verify each as the \`ship\` skill says: fix the real ones in one commit, decline the rest with evidence through code_review_resolve.`,
          // Authors and places only (a path is the PR's own text: bounded to plain path characters): the comments' own text is untrusted
          // and the wake keeps 2,000 characters.
          threads.length ? `Open review threads (read them with github_pr_threads): ${threads.slice(0, 8).map((t) => `${(t.path ?? "?").replace(/[^\w./@+-]/g, "?").slice(0, 80)}:${t.line ?? "?"} by ${t.author.replace(/[^\w-]/g, "?").slice(0, 40)}`).join("; ")}${threads.length > 8 ? `; and ${threads.length - 8} more` : ""}.` : "",
          comments.length ? `Conversation comments (github_issue_read), by id: ${comments.map((x) => `${x.id.replace("comment:", "")} (${x.author.replace(/[^\w-]/g, "?").slice(0, 40)})`).join(", ")}: act on those that ask for a change, and answer them all in one comment that names each id.` : "",
          replyOnly ? "This fork takes no pushes from ship: answer each comment on GitHub; one that needs a change is declined, saying the fork allows no maintainer edits." : push(),
        ].filter(Boolean).join("\n"));
        // What was asked is recorded unless the wake held the PR: those items wait, blocking, for their answers.
        if (open.length && !a!.hold) { c.membersAsked = open.filter((i) => named.includes(i) || (c.membersAsked ?? []).includes(i.id)).map((i) => i.id); c.acted = [...(c.acted ?? []), "fix_review:comments", ...(f.findingsKey ? [`fix_review:${f.findingsKey}`] : [])]; }
        return did;
      }
      case "merge": {
        if (merge === "off") return "nothing";
        const dismissing = await dismissStale();
        if (dismissing) return dismissing;
        if (a!.merge?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.merge.record}`);
          if (OPEN.includes(String(r.state))) { if (r.state === "owner") ownerWait = true; return "nothing"; }
          // A veto (the AI reviewer's or the owner's) is final for this head: never asked again.
          if (r.state === "rejected") return hold(`the merge at \`${pr.head.slice(0, 12)}\` was rejected (${String(r.reason ?? "no reason given").slice(0, 200)})`, HOLD.failed);
          // The PR moved meanwhile: the next head is the next round's.
          const text = String(r.outcome?.text ?? r.reason ?? r.state);
          if (/^ship-head-moved/.test(text)) return "nothing";
          // Ended by a pause or a stop (the adoption moved on): filed again now that it is worked again. Anything else didn't land:
          // the PR holds (its owner told, the outcome on the record), never filed again at this head; a new head resumes it.
          if (!/adoption ended or moved on|^ship-generation|ship-tier-pending/.test(text)) return hold(`ship's merge at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)}; its outcome is on record ${a!.merge.record}`, HOLD.failed);
        }
        const attempt = a!.merge?.head === pr.head ? a!.merge.attempt + 1 : 1;
        // A reviewed merge needs a task: the Engineer's, or the adoption's quiet records task.
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        let r: any;
        try { r = await d.kernel.call("POST", "/v1/writes", { kind: "github.merge", task: a!.task ?? a!.holder, args: { prs: [{ repo: pr.repo, number: pr.number, head: pr.head, base: pr.base }], generation: a!.generation, attempt } }); }
        catch (e) {
          // The kernel refused to file it (its policy, a closed task): that is the owner's to decide; anything else is asked again.
          const status = (e as { status?: number }).status;
          if (status !== undefined && status < 500) return hold(`ship's merge couldn't be filed: ${String((e as Error).message).slice(0, 200)}`, HOLD.failed);
          throw e;
        }
        a = { ...a!, merge: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked to merge at \`${pr.head.slice(0, 12)}\` (attempt ${attempt})`] };
        return "acted";
      }
      case "enqueue": {
        const q = qn;
        if (q?.act === "nothing" && q.owner) ownerWait = true;
        if (!q || q.act === "nothing") return "nothing";
        const dismissing = await dismissStale();
        if (dismissing) return dismissing;
        if (q.act === "hold") return hold(q.why, q.refused ? HOLD.refused(q.refused) : HOLD.failed);
        if (q.act === "wait") { queueWait = q.why; return "nothing"; }
        // Asking again after a wait (a pending async request, an unread gate) spends no repair round and is never capped: nothing
        // was attempted and refused, and a capped PR would sit held long after GitHub recovered. A real re-enqueue still spends one.
        if (q.attempt > 1 && !q.pending) {
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`, HOLD.cap);
          c.rounds++;
        }
        // A reviewed enqueue needs a task: the Engineer's, or the adoption's quiet records task.
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.enqueue", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, base: pr.base, generation: a!.generation, attempt: q.attempt } });
        a = { ...a!, queue: { head: pr.head, base: pr.base, attempt: q.attempt, record: String(r.id), ...(q.retried ? { retried: true } : {}) }, did: [...(a!.did ?? []), `${q.retried ? "queued again" : "asked to queue"} at \`${pr.head.slice(0, 12)}\` (attempt ${q.attempt})`] };
        return "acted";
      }
      case "approve": {
        // Gated in code by the repo's `approve` and the evidence at this head, whatever decide was told.
        // A dismissal in hand is reconciled first: once it is done GitHub asks for an approval again, and this round files it.
        const dismissing = await dismissStale();
        if (dismissing) return dismissing;
        if (risk?.approve !== "on" || !j?.ok) return "nothing";
        // No App that may approve it (github refuses at planning or at the effect): a person's approval is what it waits for, said once.
        const NO_APP = /ship-no-app|approval needs a human/;
        const person = (text: string) => {
          a = { ...a!, approve: { head: pr.head, attempt: a!.approve?.attempt ?? 1, record: a!.approve?.record ?? "", why: text.slice(0, 300) }, did: [...(a!.did ?? []), `the App can't approve at \`${pr.head.slice(0, 12)}\` (${text.slice(0, 200)}): a person approves it`] };
          return "acted" as const;
        };
        if (a!.approve?.head === pr.head) {
          if (a!.approve.why) return "nothing";
          const r = await d.kernel.call("GET", `/v1/writes/${a!.approve.record}`);
          if (r.state === "owner") ownerWait = true;
          if (OPEN.includes(String(r.state)) || r.state === "done") return "nothing";
          const text = String(r.outcome?.text ?? r.reason ?? "");
          if (/^ship-head-moved/.test(text)) return "nothing";
          if (NO_APP.test(text)) return person(text);
          if (r.state === "rejected") return hold(`the approval at \`${pr.head.slice(0, 12)}\` was rejected (${text.slice(0, 200) || "no reason given"})`, HOLD.failed);
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`, HOLD.cap);
          c.rounds++;
        }
        const attempt = a!.approve?.head === pr.head ? a!.approve.attempt + 1 : 1;
        let r: any;
        try {
          // A reviewed approval needs a task: the Engineer's, or the adoption's quiet records task.
          const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
          if (holder) a = { ...a!, holder };
          r = await d.kernel.call("POST", "/v1/writes", { kind: "github.approve", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, ...(risk?.policy ? { policy: risk.policy } : {}) } });
        } catch (e) {
          const text = String((e as Error).message);
          if (NO_APP.test(text)) return person(text);
          throw e;
        }
        a = { ...a!, approve: { head: pr.head, attempt, record: String(r.id), ...(risk?.policy ? { policy: risk.policy } : {}) }, did: [...(a!.did ?? []), `asked the App to approve \`${pr.head.slice(0, 12)}\` (${j.why})`] };
        return "acted";
      }
      case "stall":
        return hold(v.why ?? "stalled", HOLD.stall, f.decided === true);
      default: {
        // wait: the report says what it waits on. An App approval that no longer stands for this head goes first.
        const dismissing = await dismissStale();
        return dismissing ?? "nothing";
      }
    }
  };
  const did = await step();
  if (did === "acted" && fix && !updatedOnly) c.acted = [...(c.acted ?? []), act];
  if (a!.hold) return "acted";
  // A merge already asked for at this head: nothing new to say until its record ends.
  // A queue wait is reported once per head (its own marker), as the enqueue's own key is followed by its record.
  // A branch update alone is not the fix: its own marker, so a head still red next pass is asked to be fixed.
  const marker = ownerWait ? `${key}:owner` : queueWait ? `${key}:wait` : updatedOnly ? `${key}:updated` : key;
  if (did === "nothing" && c.lastRound === marker) return did;
  c.lastRound = marker;
  // What a person is asked for, if anything; the rest is Ship's own work and says so only once a comment exists.
  const person = risk?.state !== "pending" && merge === "off";
  await save(ownerWait ? { kind: "owner_card" } : queueWait ? { kind: "requeue" } : v.do === "merge" || v.do === "enqueue" ? { kind: person ? "person_merge" : "active" } : v.do === "approve" ? { kind: a!.approve?.why ? "approval" : "active" } : v.do === "wait" ? waitFacts(v.why) : v.do === "fix_review" ? { kind: "findings" } : { kind: "active" });
  return did;
}

/** A report that failed last pass is posted again; the round that follows says whatever the new head needs. */
export async function retryReport(d: RoundDeps, a: Kept, pr: PrView): Promise<Kept> {
  const stale = a.reportStale;
  if (!stale) return a;
  // At any head: the comment (or its edit) may have landed, and a later round that has nothing new to say would never reconcile it.
  return report(d, a, pr, stale.facts);
}

/**
 * Tells a task-owned PR's task (a wake; `asker`: whoever asked for the task, on a hold). It throws when the kernel didn't take the
 * wake, so the caller records nothing and the next pass tells again; a refusal (the task is gone) is final and only logged.
 */
export async function tell(d: Pick<RoundDeps, "kernel" | "log">, a: Kept, pr: PrView, text: string, what: string, asker = false) {
  if (a.owner?.kind !== "task") return;
  // The notice's own key: a retry of a wake whose answer was lost posts nothing twice.
  const id = wakeKey(`${pr.repo}#${pr.number}:${what}`);
  try { await d.kernel.call("POST", "/v1/wakes", { task: a.owner.task, text: text.slice(0, 2000), id, ...(asker ? { to: "asker" } : {}) }); }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status === undefined || status >= 500) throw e;
    d.log("tell refused", { pr: pr.url, status, err: String((e as Error).message).slice(0, 200) });
  }
}

/** A wake's bounded key from its whole identity: a retry reuses it, distinct wakes never share one. */
const wakeKey = (identity: string) => `ship.${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;

/**
 * Says what a person must act on, or acknowledges a member's hand-off, in the PR's one comment (edited in place; the code host finds
 * it by its marker before it creates one, so a lost id never makes a second). Answers the adoption with the comment's id in it:
 * callers keep it, so a later save can't drop the id. A task's PR gets one only for what a person must do (its task is told the rest), nor does a PR nobody must act on
 * unless its hand-off was explicit. A comment that exists is kept true.
 */
async function report(d: RoundDeps, a: Kept, pr: PrView, f: Facts): Promise<Kept> {
  const s = say(f);
  // A task's PR is its task's to hear about (a wake); a comment only for what a person must do.
  if (a.owner?.kind === "task" && !a.report && !s.act) return a;
  const explicit = a.trigger.kind === "label" || a.trigger.kind === "comment";
  // Nothing to say yet: no comment exists, and no person must act or was handed the PR on purpose (a merged one is never news).
  const text = a.report || s.act ? s.text : explicit && f.kind !== "merged" ? ACK : undefined;
  const { reportStale: stale, ...kept } = a;
  if (!text || (a.report && a.said === text)) {
    if (stale) d.state.put(kept);
    return stale ? kept : a;
  }
  try {
    const id = await d.comment(pr.repo, pr.number, renderReport(text), a.report);
    const next = { ...kept, report: id, said: text };
    d.state.put(next);
    return next;
  } catch (e) {
    d.log("report failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
    // What the comment says is unknown now (the write may have landed): the next write is never skipped as already said.
    const { said: _, ...unsure } = a;
    const next = { ...unsure, reportStale: { head: pr.head, facts: f } };
    d.state.put(next);
    return next;
  }
}
