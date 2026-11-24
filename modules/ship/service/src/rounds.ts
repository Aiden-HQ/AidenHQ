// Rounds (spec §3): one decision per pass for an adopted PR, from merge-gate's decide. A round is a settled head: each (head,
// action) is acted on once. Ship's own effects come first (update-branch, the repair check job, the direct merge); the PR's
// Engineer task (the same task across rounds) is woken only for what the repair leaves, a red required check or review findings. Past a cap, or on a step
// the repo's settings exclude, the PR goes on hold with the reason, its author assigned once, and the report says so.
// The loop (loop.ts) calls round() after intake() for each adopted PR it read, with decide's answer and this pass's facts.
import type { Discovered } from "./discover.ts";
import { fileTask, type Kept, type PrView } from "./handoff.ts";
import { renderReport, type Facts } from "./report.ts";
import type { Judged } from "./safe.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";

/** merge-gate's decide answer for the PR at its head, with ship's context (github's merge-gate.ts Action). */
export type Decision = { do: "wait" | "repair" | "fix_ci" | "fix_review" | "approve" | "enqueue" | "merge" | "done" | "stall" | "fail"; why?: string };

/** This pass's facts beside decide: GitHub's mergeable state, the failing required checks and main's, and the generated paths. */
export interface RoundFacts {
  /** The head conflicts with the base (DIRTY), as opposed to merely being behind it. */
  dirty?: boolean;
  /** The PR is first in the repo's merge order (merges.ts) while its rules require up-to-date branches and there is no merge queue:
   * under `rebase: conflict`, only that PR is brought up to date (item 19). */
  front?: boolean;
  /** Required checks red on the head, and the same names red on the target branch's latest completed run. */
  failing?: string[]; onBase?: string[];
  /** Discovery on the target branch (discover.ts); the repo's `generated` setting wins over it. */
  discovered?: Discovered;
  /** safe.ts judge()'s answer at the head, where approval is needed: what the App approves on (and decide's ShipContext.approve). */
  approval?: Judged;
  /** Report-only facts (risk, review). */
  report?: Omit<Facts, "state" | "waits" | "failing" | "onBase">;
}

export interface RoundDeps {
  state: State;
  settings(repo: string): ShipSettings | null;
  paused(): boolean;
  /** The kernel, as ship: wakes, write records (github.merge), their state, and closing a hand-off's task. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any> };
  /** Code review's gating review of the PR's head (effects.ts askFresh): a model fix its last review doesn't carry to. */
  askFresh(url: string): Promise<void>;
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
  let a = d.state.get(pr.repo, pr.number) as Kept | undefined;
  if (!a || !s) return "nothing";
  // Stopped: nothing moves while ship is paused, the PR is closed or a draft, on hold, stopped by label, or a person is assigned.
  // Landed: a hand-off's task ends with it (a fleet PR's task is its opener's), whatever else holds the PR.
  if (pr.state === "merged" && v.do === "done") {
    if (a.counters?.lastRound !== `${pr.head}:done`) {
      // Closed before it is recorded: a close that failed is tried again next pass (an already-closed task answers ok).
      if (a.task && a.trigger.kind !== "fleet") {
        try { await d.kernel.call("POST", `/v1/tasks/${a.task}/close`, { status: "done", body: `${pr.url} is merged.` }); } catch (e) {
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

  const c = a.counters && a.counters.head === pr.head ? a.counters : { ...(a.counters ?? { rounds: 0, ci: 0, review: 0, red: {} }), head: pr.head, wakes: 0 };
  a = { ...a, counters: c };
  const caps = s.caps;
  const over = (n: number, cap: number | null) => cap !== null && n >= cap;
  const j = f.approval;
  const facts: Facts = { state: "working", stopLabel: s.stop_label, ...(j ? { lines: j.safe.lines, files: j.safe.files, safe: j.safe } : {}), ...(f.report ?? {}), ...(f.failing?.length ? { failing: f.failing, onBase: f.onBase ?? [] } : {}),
    ...(j && s.approve !== "off" ? { approval: s.approve === "observe" ? (j.ok ? `would approve: ${j.why}` : `would not: ${j.why}`) : j.ok ? `approves: ${j.why}` : `not yet: ${j.why}` } : {}) };
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
    // The kernel keeps 2,000 characters of a wake: a longer one (a very long repair plan) would reach the task cut.
    if (text.length > 2000) return hold(`the ${kind} wake is ${text.length} characters (over 2,000): narrow the repo's \`generated\` setting`);
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

  // A model fix the last review doesn't carry to: code review is asked once for a review of this head (never under observe).
  if (j?.ask && (s.approve === "safe" || s.approve === "all") && a.asked !== pr.head) {
    try {
      await d.askFresh(pr.url);
      a = { ...a, asked: pr.head, did: [...(a.did ?? []), `asked code review for a review of \`${pr.head.slice(0, 12)}\``] };
      d.state.put(a);
    } catch (e) {
      d.log("fresh review ask failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
    }
  }

  const push = () => `Start from the PR's head with \`aidenhq ship checkout ${pr.url} ${pr.head}\`, commit your fix there, and push it with \`aidenhq ship push ${pr.url} ${pr.head} ${a!.generation}\`.`;
  // Behind only, under `rebase: conflict`: brought up to date only at the front of the repo's merge order; the rest wait their turn.
  if (v.do === "repair" && !f.dirty && s.rebase === "conflict" && !f.front) return "nothing";
  // A round is a settled head: each (head, action) is taken once; a merge or a conflict's repair is followed by its record instead.
  const key = `${pr.head}:${v.do}`;
  const followed = v.do === "merge" || v.do === "approve" || (v.do === "repair" && f.dirty === true);
  if (!followed && c.lastRound === key) return "nothing";
  // Each new action spends a round; past `rounds` the PR holds.
  const spend = () => (over(c.rounds, caps.rounds) ? hold(`${c.rounds} rounds (rounds)`) : (c.rounds++, undefined));
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
          return hold(`ship's repair couldn't write the branch: ${text.split("\n")[0]!.slice(0, 300)}`);
        }
        const held = spend();
        if (held) return held;
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.repair", ...(a!.task ? { task: a!.task } : {}), args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, plan: repairPlan(s, f.discovered) } });
        a = { ...a!, repair: { head: pr.head, record: String(r.id) }, did: [...(a!.did ?? []), `ran the repair (merge \`${pr.defaultBranch}\`, regenerate) at \`${pr.head.slice(0, 12)}\``] };
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
          onBase.size ? `These fail on \`${pr.defaultBranch}\`'s latest run too: ${[...onBase].map((n) => `\`${n}\``).join(", ")}. If the failure is the same there, it is pre-existing: say so on the task with the run you compared, and change nothing for it.` : "",
          "Fix what this PR broke as the `ship` skill says: one commit, never weaken a check.",
          push(),
        ].filter(Boolean).join("\n"));
      }
      case "fix_review": {
        if (!s.fix.includes("review")) return hold("review findings are open, and this repo's `fix` setting excludes review");
        if (pr.fork && !pr.canModify) return hold(noEdits);
        if (over(c.review, caps.review_rounds)) return hold(`${c.review} review fix rounds (review_rounds)`);
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
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.merge", ...(a!.task ? { task: a!.task } : {}), args: { prs: [{ repo: pr.repo, number: pr.number, head: pr.head, base: pr.base }], generation: a!.generation, attempt } });
        a = { ...a!, merge: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked to merge at \`${pr.head.slice(0, 12)}\` (attempt ${attempt})`] };
        return "acted";
      }
      case "approve": {
        // Gated in code by the repo's `approve` and the evidence at this head, whatever decide was told.
        if (!(s.approve === "safe" || s.approve === "all") || !j?.ok) return "nothing";
        // No App that may approve it (github refuses at planning or at the effect): a person's approval is what it waits for, said once.
        const NO_APP = /ship-no-app|approval needs a human/;
        const person = (text: string) => {
          a = { ...a!, approve: { head: pr.head, attempt: a!.approve?.attempt ?? 1, record: a!.approve?.record ?? "", why: text.slice(0, 300) }, did: [...(a!.did ?? []), `the App can't approve at \`${pr.head.slice(0, 12)}\` (${text.slice(0, 200)}): a person approves it`] };
          return "acted" as const;
        };
        if (a!.approve?.head === pr.head) {
          if (a!.approve.why) return "nothing";
          const r = await d.kernel.call("GET", `/v1/writes/${a!.approve.record}`);
          if (OPEN.includes(String(r.state)) || r.state === "done") return "nothing";
          const text = String(r.outcome?.text ?? r.reason ?? "");
          if (/^ship-head-moved/.test(text)) return "nothing";
          if (NO_APP.test(text)) return person(text);
          if (r.state === "rejected") return hold(`the approval at \`${pr.head.slice(0, 12)}\` was rejected (${text.slice(0, 200) || "no reason given"})`);
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`);
          c.rounds++;
        }
        const attempt = a!.approve?.head === pr.head ? a!.approve.attempt + 1 : 1;
        let r: any;
        try {
          r = await d.kernel.call("POST", "/v1/writes", { kind: "github.approve", ...(a!.task ? { task: a!.task } : {}), args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base } });
        } catch (e) {
          const text = String((e as Error).message);
          if (NO_APP.test(text)) return person(text);
          throw e;
        }
        a = { ...a!, approve: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked the App to approve \`${pr.head.slice(0, 12)}\` (${j.why})`] };
        return "acted";
      }
      case "stall":
        return hold(v.why ?? "stalled");
      default:
        // wait; enqueue is a later lane (D3): the report says what it waits on.
        return "nothing";
    }
  };
  const did = await step();
  if (a!.hold) return "acted";
  // A merge already asked for at this head: nothing new to say until its record ends.
  if (did === "nothing" && c.lastRound === key) return did;
  c.lastRound = key;
  const state = v.do === "done" ? "merged" : v.do === "merge" ? (s.merge === "off" ? "ready (its `merge` setting is off: a person merges it)" : "merging") : v.do === "approve" ? (a!.approve?.why ? "ready: waiting for a person's approval" : "approving") : v.do === "enqueue" ? "ready" : v.do === "wait" ? "waiting" : "working";
  await save(state, ["wait", "approve", "enqueue"].includes(v.do) ? v.why : undefined);
  return did;
}

/** Posts the report, or edits it in place (its id kept on the adoption). */
async function report(d: RoundDeps, a: Kept, pr: PrView, f: Facts) {
  try {
    const id = await d.comment(pr.repo, pr.number, renderReport(a, pr, f), a.report);
    const kept: Kept = { ...a, report: id };
    if (id !== a.report) d.state.put(kept);
  } catch (e) {
    d.log("report failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
  }
}
