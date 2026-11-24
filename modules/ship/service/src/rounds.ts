// Rounds (spec §3): one decision per pass for an adopted PR, from merge-gate's decide. A round is a settled head: each (head,
// action) is acted on once. Ship's own effects come first (update-branch, the repair check job, the direct merge); the PR's
// Engineer task (the same task across rounds) is woken only for what the repair leaves, a red required check or review findings. Past a cap, or on a step
// the repo's settings exclude, the PR goes on hold with the reason, its author assigned once, and the report says so.
// The loop (loop.ts) calls round() after intake() for each adopted PR it read, with decide's answer and this pass's facts.
import type { Discovered } from "./discover.ts";
import { fileTask, recordTask, tasksOf, type Kept, type PrView } from "./handoff.ts";
import { queueNext, type QueueFacts, type QueueNext, type Queued } from "./queue.ts";
import { renderReport, type Facts } from "./report.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";

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
  /** Discovery on the target branch (discover.ts); the repo's `generated` setting wins over it. */
  discovered?: Discovered;
  /** Report-only facts (risk, review). */
  report?: Omit<Facts, "state" | "waits" | "failing" | "onBase">;
}

export interface RoundDeps {
  state: State;
  settings(repo: string): ShipSettings | null;
  paused(): boolean;
  /** The kernel, as ship: wakes, write records (github.merge), their state, and closing a hand-off's task. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any> };
  /** GitHub's update-branch bound to the head (expected_head_sha): a clean merge of the base, no conflict. */
  updateBranch(repo: string, number: number, head: string): Promise<void>;
  assign(repo: string, number: number, logins: string[]): Promise<void>;
  /** The code host's comment op (POST /v1/codehost/comment): posts, or edits comment `id`; answers the comment's id. */
  comment(repo: string, number: number, body: string, id?: number): Promise<number>;
  log(msg: string, f?: Record<string, unknown>): void;
}

const OPEN = ["review", "owner", "approved", "claimed", "done"];

/** The repair's plan for the box: the repo's `generated` setting, else what discovery found on the target branch. */
export function repairPlan(s: ShipSettings, d?: Discovered) {
  if (s.generated) return { globs: s.generated.globs, commands: s.generated.command ? [{ dir: ".", cmd: s.generated.command }] : [] };
  return { globs: d?.globs ?? [], commands: d?.commands ?? [] };
}

/** One round for an adopted PR. Answers what it did: "stopped", "acted" or "nothing". */
export async function round(d: RoundDeps, pr: PrView, v: Decision, f: RoundFacts = {}): Promise<"stopped" | "acted" | "nothing"> {
  const s = d.settings(pr.repo);
  // Check names are set by whoever can push to the repo: no backtick or line break reaches a wake or the report.
  const clean = (l?: string[]) => l?.map((n) => n.replace(/[`\r\n]/g, ""));
  f = { ...f, failing: clean(f.failing), onBase: clean(f.onBase), groupFailing: clean(f.groupFailing) };
  let a = d.state.get(pr.repo, pr.number) as (Kept & { queue?: Queued }) | undefined;
  if (!a || !s) return "nothing";
  a = await retryReport(d, a, pr);
  // Stopped: nothing moves while ship is paused, the PR is closed or a draft, on hold, stopped by label, or a person is assigned.
  // Landed: a hand-off's task ends with it (a fleet PR's task is its opener's), whatever else holds the PR.
  if (pr.state === "merged" && v.do === "done") {
    if (a.counters?.lastRound !== `${pr.head}:done`) {
      // Closed before it is recorded: a close that failed is tried again next pass (an already-closed task answers ok).
      // A queued merge must land on the base the enqueue was bound to; anywhere else it is reported, not closed as done.
      if (a.queue && a.queue.base !== pr.base) {
        a = { ...a, counters: { ...(a.counters ?? { head: pr.head, wakes: 0, rounds: 0, ci: 0, review: 0, red: {} }), lastRound: `${pr.head}:done` } };
        d.state.put(a);
        await report(d, a, pr, { state: `merged into \`${pr.base}\`, not the base it was queued for (\`${a.queue.base}\`)`, stopLabel: s.stop_label });
        return "acted";
      }
      for (const t of tasksOf(a)) {
        try { await d.kernel.call("POST", `/v1/tasks/${t}/close`, { status: "done", body: `${pr.url} is merged.` }); } catch (e) {
          d.log("task close failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
          return "nothing";
        }
      }
      a = { ...a, counters: { ...(a.counters ?? { head: pr.head, wakes: 0, rounds: 0, ci: 0, review: 0, red: {} }), lastRound: `${pr.head}:done` } };
      d.state.put(a);
      await report(d, a, pr, { state: "merged", stopLabel: s.stop_label });
    }
    return "acted";
  }
  const people = pr.assignees.filter((x) => !(a!.assigned ?? []).includes(x));
  if (d.paused() || a.hold || pr.state !== "open" || pr.draft || pr.labels.includes(s.stop_label) || people.length) return "stopped";

  const c = a.counters && a.counters.head === pr.head ? a.counters : { ...(a.counters ?? { rounds: 0, ci: 0, review: 0, red: {} }), head: pr.head, wakes: 0, acted: [] };
  a = { ...a, counters: c };
  const caps = s.caps;
  const over = (n: number, cap: number | null) => cap !== null && n >= cap;
  const facts: Facts = { state: "working", stopLabel: s.stop_label, ...(f.report ?? {}), ...(f.failing?.length ? { failing: f.failing, onBase: f.onBase ?? [] } : {}) };
  const save = async (state: string, waits?: string) => { d.state.put(a!); await report(d, a!, pr, { ...facts, state, ...(waits ? { waits } : {}) }); };
  const hold = async (reason: string) => {
    const assign = pr.authorBot || !pr.author ? [] : [pr.author];
    if (assign.length) await d.assign(pr.repo, pr.number, assign).catch((e) => d.log("assign failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }));
    a = { ...a!, hold: { kind: "stalled", reason, at: new Date().toISOString() }, assigned: assign };
    d.log("hold", { pr: pr.url, reason });
    await save("on hold");
    return "acted" as const;
  };
  // A fork's branch takes ship's commits only where its author allows maintainer edits (and GitHub accepts the App's write).
  const noEdits = "it needs a change on its fork's branch, and the fork doesn't allow maintainer edits: the contributor can enable \"Allow edits by maintainers\", rebase or fix it";
  const wake = async (kind: string, text: string) => {
    if (over(c.wakes, caps.wakes_per_head)) return hold(`woke the task ${c.wakes} times on this head (wakes_per_head)`);
    // The kernel keeps 2,000 characters of a wake.
    text = text.slice(0, 2000);
    // The first job files the adoption's task (which starts the Engineer on it); later ones wake that same task.
    if (!a!.task) a = { ...a!, task: await fileTask(d.kernel, pr, a!.generation, text) };
    else if ((await d.kernel.call("POST", "/v1/wakes", { task: a!.task, text }))?.closed) {
      // Someone closed or cancelled the task: that ends the adoption until a fresh hand-off.
      a = { ...a!, hold: { kind: "handed_back", reason: "its task was closed", at: new Date().toISOString() } };
      await save("on hold");
      return "acted" as const;
    }
    c.wakes++;
    a = { ...a!, did: [...(a!.did ?? []), `${kind} at \`${pr.head.slice(0, 12)}\``] };
    return "acted" as const;
  };

  const push = () => `Start from the PR's head with \`aidenhq ship checkout ${pr.url} ${pr.head}\`, commit your fix there, and push it with \`aidenhq ship push ${pr.url} ${pr.head} ${a!.generation}\`.`;
  // Behind only, under `rebase: conflict`: brought up to date only at the front of the repo's merge order; the rest wait their turn.
  if (v.do === "repair" && !f.dirty && s.rebase === "conflict" && !f.front && !f.queue) return "nothing";
  // A queue branch: the removal is read here. A red required check on the merge_group run that is this PR's own is a fix_ci round.
  let qn: QueueNext | undefined, viaQueue = false;
  if (v.do === "enqueue" && s.merge !== "off") {
    qn = await queueNext(d.kernel, a.queue, pr, f);
    if (qn.act === "fix_ci") { v = { do: "fix_ci", why: "a required check failed on its merge queue run" }; f = { ...f, failing: qn.failing }; facts.failing = qn.failing; facts.onBase = f.onBase ?? []; viaQueue = true; qn = undefined; }
  }
  // A round is a settled head: each (head, action) is taken once; a merge or a conflict's repair is followed by its record instead.
  const key = `${pr.head}:${v.do}`;
  const followed = v.do === "merge" || v.do === "enqueue" || (v.do === "repair" && f.dirty === true);
  // A fix already asked for at this head is not asked again after a `wait` in between (a CI re-run with no push).
  const fix = ["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty);
  if (!followed && (c.lastRound === key || (fix && (c.acted ?? []).includes(v.do)))) return "nothing";
  // Each new action spends a round; past `rounds` the PR holds.
  const spend = () => (over(c.rounds, caps.rounds) ? hold(`${c.rounds} rounds (rounds)`) : (c.rounds++, undefined));
  let queueWait: string | undefined;
  const step = async (): Promise<"acted" | "nothing"> => {
    if (["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty)) {
      const held = spend();
      if (held) return held;
    }
    switch (v.do) {
      case "repair": {
        if (!s.fix.includes("conflicts")) return hold("it needs a repair, and this repo's `fix` setting excludes conflicts");
        if (!f.dirty) {
          await d.updateBranch(pr.repo, pr.number, pr.head);
          a = { ...a!, did: [...(a!.did ?? []), `updated the branch with \`${pr.defaultBranch}\``] };
          return "acted";
        }
        if (pr.fork && !pr.canModify) return hold(noEdits);
        // A conflict: ship's repair check job (no model) first, as github's `repair` effect; the Engineer gets only what it leaves.
        if (a!.repair?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.repair.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          const text = String(r.outcome?.text ?? r.reason ?? "");
          // Done (or the PR moved meanwhile): the next head is the next round's.
          if (r.state === "done" || /^ship-head-moved/.test(text)) return "nothing";
          if (r.state !== "failed") return hold(`ship's repair was ${r.state}: ${text.slice(0, 300)}`);
          const left = text.split("\n").filter((l) => l.startsWith("leftover: ")).length;
          if (/^ship-leftovers/.test(text) || /^ship-generator/.test(text)) {
            if (a!.repair.woke) return "nothing";
            a = { ...a!, repair: { ...a!.repair, woke: true } };
            return wake("repair", [
              /^ship-leftovers/.test(text)
                ? `${pr.url} conflicts with \`${pr.defaultBranch}\` at head ${pr.head}, and ship's repair left ${left} conflict(s) no generator rewrites (its outcome is on record ${a!.repair!.record}).`
                : `${pr.url} conflicts with \`${pr.defaultBranch}\` at head ${pr.head}, and ship's repair stopped on a generator (its outcome is on record ${a!.repair!.record}).`,
              `Resolve it as the \`ship\` skill says: merge \`origin/${pr.defaultBranch}\` in, resolve, regenerate the generated files, one commit.`,
              push(),
            ].join("\n"));
          }
          // A run that didn't finish (nothing kept) is asked for once more at this head; anything else holds with its reason.
          if (!/^ship-repair:/.test(text) || a!.repair.retried) return hold(`ship's repair couldn't write the branch: ${text.split("\n")[0]!.slice(0, 300)}`);
        }
        const retry = a!.repair?.head === pr.head;
        const held = spend();
        if (held) return held;
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.repair", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, plan: repairPlan(s, f.discovered), ...(retry ? { attempt: 2 } : {}) } });
        a = { ...a!, repair: { head: pr.head, record: String(r.id), ...(retry ? { retried: true } : {}) }, did: [...(a!.did ?? []), `ran the repair (merge \`${pr.defaultBranch}\`, regenerate) at \`${pr.head.slice(0, 12)}\``] };
        return "acted";
      }
      case "fix_ci": {
        if (!s.fix.includes("ci")) return hold("a required check is red, and this repo's `fix` setting excludes CI");
        if (pr.fork && !pr.canModify) return hold(noEdits);
        const failing = f.failing ?? [];
        const onBase = new Set(f.onBase ?? []);
        const own = failing.filter((n) => !onBase.has(n));
        // Failing on the target branch too: likely pre-existing. The Engineer judges it with evidence; it spends no CI round.
        if (own.length) {
          for (const n of own) c.red[n] = [...new Set([...(c.red[n] ?? []), pr.head])];
          const repeat = own.find((n) => over(c.red[n]!.length, caps.same_check_heads));
          if (repeat) return hold(`required check \`${repeat}\` failed on ${c.red[repeat]!.length} heads (same_check_heads)`);
          if (over(c.ci, caps.ci_rounds)) return hold(`${c.ci} CI fix rounds (ci_rounds)`);
          c.ci++;
        }
        return wake("fix_ci", [
          `${pr.url}: required checks are red at head ${pr.head}: ${failing.map((n) => `\`${n}\``).join(", ") || "(see the PR's checks)"}.`,
          viaQueue ? "They passed on the PR's head but failed on the merge queue's run for it (the `merge_group` run): read that run's logs, the failure is in the PR merged onto the base." : "",
          onBase.size ? `These fail on \`${pr.defaultBranch}\`'s latest run too: ${[...onBase].map((n) => `\`${n}\``).join(", ")}. If the failure is the same there, it is pre-existing: say so on the task with the run you compared, and change nothing for it.` : "",
          "Fix what this PR broke as the `ship` skill says: one commit, never weaken a check.",
          push(),
        ].filter(Boolean).join("\n"));
      }
      case "fix_review": {
        if (!s.fix.includes("review")) return hold("review findings are open, and this repo's `fix` setting excludes review");
        if (pr.fork && !pr.canModify) return hold(noEdits);
        // How many review and fix cycles a PR gets is code review's (its push_rounds): ship fixes what each review finds.
        c.review++;
        return wake("fix_review", `${pr.url}: code review has open important findings (or changes requested) at head ${pr.head}. Verify each as the \`ship\` skill says: fix the real ones in one commit, decline the rest with evidence through code_review_resolve.\n${push()}`);
      }
      case "merge": {
        if (s.merge === "off") return "nothing";
        if (a!.merge?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.merge.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          // A veto (the AI reviewer's or the owner's) is final for this head: never asked again.
          if (r.state === "rejected") return hold(`the merge at \`${pr.head.slice(0, 12)}\` was rejected (${String(r.reason ?? "no reason given").slice(0, 200)})`);
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`);
          c.rounds++;
        }
        const attempt = a!.merge?.head === pr.head ? a!.merge.attempt + 1 : 1;
        // A reviewed merge needs a task: the Engineer's, or the adoption's quiet records task.
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.merge", task: a!.task ?? a!.holder, args: { prs: [{ repo: pr.repo, number: pr.number, head: pr.head, base: pr.base }], generation: a!.generation, attempt } });
        a = { ...a!, merge: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked to merge at \`${pr.head.slice(0, 12)}\` (attempt ${attempt})`] };
        return "acted";
      }
      case "enqueue": {
        const q = qn;
        if (!q || q.act === "nothing") return "nothing";
        if (q.act === "hold") return hold(q.why);
        if (q.act === "wait") { queueWait = q.why; return "nothing"; }
        if (q.attempt > 1) {
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`);
          c.rounds++;
        }
        // A reviewed enqueue needs a task: the Engineer's, or the adoption's quiet records task.
        const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
        if (holder) a = { ...a!, holder };
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.enqueue", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, base: pr.base, generation: a!.generation, attempt: q.attempt } });
        a = { ...a!, queue: { head: pr.head, base: pr.base, attempt: q.attempt, record: String(r.id), ...(q.retried ? { retried: true } : {}) }, did: [...(a!.did ?? []), `${q.retried ? "queued again" : "asked to queue"} at \`${pr.head.slice(0, 12)}\` (attempt ${q.attempt})`] };
        return "acted";
      }
      case "stall":
        return hold(v.why ?? "stalled");
      default:
        // wait, and approve (a later lane, D2): the report says what it waits on.
        return "nothing";
    }
  };
  const did = await step();
  if (did === "acted" && fix) c.acted = [...(c.acted ?? []), v.do];
  if (a!.hold) return "acted";
  // A merge already asked for at this head: nothing new to say until its record ends.
  // A queue wait is reported once per head (its own marker), as the enqueue's own key is followed by its record.
  const marker = queueWait ? `${key}:wait` : key;
  if (did === "nothing" && c.lastRound === marker) return did;
  c.lastRound = marker;
  const state = v.do === "done" ? "merged" : v.do === "merge" ? (s.merge === "off" ? "ready (its `merge` setting is off: a person merges it)" : "merging") : v.do === "enqueue" ? (s.merge === "off" ? "ready (its `merge` setting is off: a person queues it)" : "queueing") : v.do === "approve" ? "ready" : v.do === "wait" ? "waiting" : "working";
  await save(queueWait ? "waiting" : state, queueWait ?? (["wait", "approve", "enqueue"].includes(v.do) ? v.why : undefined));
  return did;
}

/** A report that failed last pass is posted again (at the head it was for; a new head's round writes its own). */
export async function retryReport(d: RoundDeps, a: Kept, pr: PrView): Promise<Kept> {
  const stale = a.reportStale;
  if (!stale) return a;
  if (stale.head === pr.head) await report(d, a, pr, stale.facts);
  else { const { reportStale: _, ...kept } = a; d.state.put(kept); }
  return d.state.get(pr.repo, pr.number) as Kept;
}

/** Posts the report, or edits it in place (its id kept on the adoption). */
async function report(d: RoundDeps, a: Kept, pr: PrView, f: Facts) {
  try {
    const id = await d.comment(pr.repo, pr.number, renderReport(a, pr, f), a.report);
    if (id !== a.report || a.reportStale) { const { reportStale: _, ...kept } = a; d.state.put({ ...kept, report: id }); }
  } catch (e) {
    d.log("report failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
    d.state.put({ ...a, reportStale: { head: pr.head, facts: f } });
  }
}
