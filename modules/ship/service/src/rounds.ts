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
import { renderReport, type Facts } from "./report.ts";
import { staleApproval, type Judged, type Risk } from "./safe.ts";
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
  /** safe.ts judge()'s answer at the head, where approval is needed: what the App approves on (and decide's ShipContext.approve). */
  approval?: Judged;
  /** The head's risk tier with its `by_tier` approve and merge (safe.ts riskOf, from code review's verdict). Without one nothing merges. */
  risk?: Risk;
  /** Code review's findings at this head (its digest): a new set at the same head is a new fix_review. */
  findingsKey?: string;
  /** Red at a head behind a green base: GitHub's update-branch is tried once at this head before any fix_ci wake. */
  behindGreen?: boolean;
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
  askFresh(url: string, head: string): Promise<void>;
  /** GitHub's update-branch bound to the head (expected_head_sha): a clean merge of the base, no conflict. */
  updateBranch(repo: string, number: number, head: string): Promise<void>;
  assign(repo: string, number: number, logins: string[]): Promise<void>;
  /** The code host's comment op (POST /v1/codehost/comment): posts, or edits comment `id`; answers the comment's id. */
  comment(repo: string, number: number, body: string, id?: number): Promise<number>;
  log(msg: string, f?: Record<string, unknown>): void;
  /** GitHub as the owner (github's /internal/ship/gh): the repo's own actions and discovery (actions.ts). Without it, neither runs. */
  gh?: Gh;
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
  // A new head clears a stalled hold and its counters: the push is the answer to what held it (a stop or a hand-back stays).
  if (a.hold?.kind === "stalled" && pr.state === "open" && a.counters && a.counters.head !== pr.head) {
    a = { ...a, hold: null, counters: undefined };
    d.state.put(a);
    d.log("hold cleared by a new head", { pr: pr.url });
  }
  // Stopped: nothing moves while ship is paused, the PR is closed or a draft, on hold, stopped by label, or a person is assigned.
  // Landed: a hand-off's task ends with it (a task's PR tells its task instead), whatever else holds the PR.
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
      // Told before it is recorded: a wake the kernel didn't take is sent again next pass.
      if (a.owner?.kind === "task") await tell(d, a, pr, `**Merged:** ${pr.url} is merged at \`${pr.head.slice(0, 12)}\`. Finish your task if this was its change.`, `merged.${pr.head.slice(0, 12)}`);
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
  const facts: Facts = { ...(suggest.length ? { suggest } : {}), state: "working", stopLabel: s.stop_label, ...(risk ? { risk } : {}), ...(f.report ?? {}), ...(f.failing?.length ? { failing: f.failing, onBase: f.onBase ?? [] } : {}),
    ...(j && risk && risk.approve !== "off" ? { approval: risk.approve === "observe" ? (j.ok ? `would approve: ${j.why}` : `would not: ${j.why}`) : j.ok ? `approves: ${j.why}` : `not yet: ${j.why}` } : {}) };
  const save = async (state: string, waits?: string) => { d.state.put(a!); await report(d, a!, pr, { ...facts, state, ...(waits ? { waits } : {}) }); };
  const hold = async (reason: string) => {
    // Its owner is told: a task's PR wakes whoever asked for the task; a member's PR assigns its author (and the report says why).
    const assign = a!.owner?.kind === "task" || pr.authorBot || !pr.author ? [] : [pr.author];
    if (assign.length) await d.assign(pr.repo, pr.number, assign).catch((e) => d.log("assign failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }));
    if (a!.owner?.kind === "task") await tell(d, a!, pr, `**Ship stopped on ${pr.url}** at \`${pr.head.slice(0, 12)}\`: ${reason}. A new push resumes it. Decide its next step: re-scope the task, fix the cause another way, or tell the owner.`, `hold.${pr.head.slice(0, 12)}.${c.rounds}.${c.wakes}`, true);
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
    // The wake's own key: a retry of one whose answer was lost posts nothing twice.
    else if ((await d.kernel.call("POST", "/v1/wakes", { task: a!.task, text, id: wakeKey(`${pr.repo}#${pr.number}:${kind}:${pr.head}:${c.wakes}`) }))?.closed) {
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
   * An App approval of this head issued under another policy (or where the tier's approve is no longer `on`) never counts at a merge or an
   * enqueue (risk tiers §7): its dismissal is filed first (github.approve with `dismiss`, as the App), and the round after it decides
   * again: approved under the current policy, or waiting for a person's. "acted" or "nothing" while it is in hand, else undefined.
   */
  const dismissStale = async (): Promise<"acted" | "nothing" | undefined> => {
    const ap = a!.approve;
    if (!risk || !staleApproval(ap, pr.head, risk)) return undefined;
    if (ap!.dismissed) {
      const r = await d.kernel.call("GET", `/v1/writes/${ap!.dismissed}`);
      if (r.state === "done") { const { approve: _, ...rest } = a!; a = { ...rest, did: [...(a!.did ?? []), `dismissed the App's approval of \`${pr.head.slice(0, 12)}\` (another review policy)`] } as typeof a; return "acted"; }
      if (OPEN.includes(String(r.state))) return "nothing";
      await hold(`dismissing the App's approval at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)} (${String(r.outcome?.text ?? r.reason ?? "no reason given").slice(0, 200)})`);
      return "acted";
    }
    const holder = a!.task || a!.holder ? undefined : await recordTask(d.kernel, pr, a!);
    if (holder) a = { ...a!, holder };
    const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.approve", task: a!.task ?? a!.holder, args: { repo: pr.repo, number: pr.number, head: pr.head, generation: a!.generation, base: pr.base, dismiss: true } });
    a = { ...a!, approve: { ...ap!, dismissed: String(r.id) }, did: [...(a!.did ?? []), `asked to dismiss the App's approval of \`${pr.head.slice(0, 12)}\` (it was issued under another review policy)`] };
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
    if (r.go === "capped") return hold(`${c.rounds} rounds (rounds)`);
    const changed = r.rec !== a!.action;
    a = { ...a!, ...(r.rec ? { action: r.rec } : {}), ...(r.did ? { did: [...(a!.did ?? []), r.did] } : {}) };
    if (r.go === "waiting") return "nothing";
    if (r.go === "started") { await save("working", `the repo's own ${stage.replace("_", " ")} step`); return "acted"; }
    if (r.go === "failed" && stage === "before_merge") return hold(`the repo's before_merge steps didn't pass (${a.action?.why ?? "failed"})`);
    if (changed) d.state.put(a);
  }
  // A queue branch: the removal is read here. A red required check on the merge_group run that is this PR's own is a fix_ci round.
  let qn: QueueNext | undefined, viaQueue = false;
  if (v.do === "enqueue" && merge !== "off") {
    qn = await queueNext(d.kernel, a.queue, pr, f);
    if (qn.act === "fix_ci") { v = { do: "fix_ci", why: "a required check failed on its merge queue run" }; f = { ...f, failing: qn.failing }; facts.failing = qn.failing; facts.onBase = f.onBase ?? []; viaQueue = true; qn = undefined; }
  }
  // A round is a settled head: each (head, action) is taken once; a merge or a conflict's repair is followed by its record instead.
  // A wait is said again when what it waits on, or its approval line, changes; every other action once per head.
  // Review findings are keyed by their digest: a new set at the same head is asked again.
  const act = v.do === "fix_review" && f.findingsKey ? `fix_review:${f.findingsKey}` : v.do;
  const key = v.do === "wait" ? `${pr.head}:wait:${v.why ?? ""}:${facts.approval ?? ""}` : `${pr.head}:${act}`;
  const followed = v.do === "merge" || v.do === "enqueue" || v.do === "approve" || (v.do === "repair" && f.dirty === true);
  // A fix already asked for at this head is not asked again after a `wait` in between (a CI re-run with no push).
  const fix = ["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty);
  if (!followed && (c.lastRound === key || (fix && (c.acted ?? []).includes(act)))) return "nothing";
  // Each new action spends a round; past `rounds` the PR holds.
  const spend = () => (over(c.rounds, caps.rounds) ? hold(`${c.rounds} rounds (rounds)`) : (c.rounds++, undefined));
  let queueWait: string | undefined, updatedOnly = false;
  const step = async (): Promise<"acted" | "nothing"> => {
    if (["fix_ci", "fix_review"].includes(v.do) || (v.do === "repair" && !f.dirty)) {
      const held = spend();
      if (held) return held;
    }
    switch (v.do) {
      case "repair": {
        if (!s.fix.includes("conflicts")) return hold("it needs a repair, and this repo's `fix` setting excludes conflicts");
        // A fork's branch takes ship's writes (update-branch too) only where its author allows maintainer edits.
        if (pr.fork && !pr.canModify) return hold(noEdits);
        if (!f.dirty) {
          // GitHub refusing the update (a rule, a permission) holds with its reason rather than asking every pass.
          try { await d.updateBranch(pr.repo, pr.number, pr.head); }
          catch (e) {
            // A refusal (a 4xx but a rate limit) holds; anything else is asked again next pass.
            const why = String((e as Error).message), status = Number(/: (\d{3})\b/.exec(why)?.[1]);
            if (status >= 400 && status < 500 && status !== 429 && !/rate limit/i.test(why)) return hold(`GitHub refused to update the branch with \`${pr.base}\`: ${why.slice(0, 200)}`);
            throw e;
          }
          a = { ...a!, did: [...(a!.did ?? []), `updated the branch with \`${pr.base}\``] };
          return "acted";
        }
        // A conflict: ship's repair check job (no model) first, as github's `repair` effect; the Engineer gets only what it leaves.
        if (a!.repair?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.repair.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          const text = String(r.outcome?.text ?? r.reason ?? "");
          // Done (or the PR moved meanwhile): the next head is the next round's.
          if (r.state === "done" || /^ship-head-moved/.test(text)) return "nothing";
          if (r.state !== "failed") return hold(`ship's repair was ${r.state}: ${text.slice(0, 300)}`);
          const left = text.split("\n").filter((l) => l.startsWith("leftover: ")).length;
          // The box lacks the generator's tool: the Engineer's computer is the same image, so the PR holds, and the report suggests
          // the repo's own command or workflow as an `actions` step.
          const missing = /^ship-generator/.test(text) && /^toolchain missing: ([\w.+-]{1,60})/m.exec(text)?.[1];
          if (missing) return hold(`toolchain missing: ${missing} (the repair box doesn't have it): configure an \`actions\` step for conflicts, such as the repo's own regenerate command or workflow${suggest.length ? `: ${suggest[0]}` : ""}`);
          if (/^ship-leftovers/.test(text) || /^ship-generator/.test(text)) {
            if (a!.repair.woke) return "nothing";
            a = { ...a!, repair: { ...a!.repair, woke: true } };
            return wake("repair", [
              /^ship-leftovers/.test(text)
                ? `${pr.url} conflicts with \`${pr.base}\` at head ${pr.head}, and ship's repair left ${left} conflict(s) no generator rewrites (its outcome is on record ${a!.repair!.record}).`
                : `${pr.url} conflicts with \`${pr.base}\` at head ${pr.head}, and ship's repair stopped on a generator (its outcome is on record ${a!.repair!.record}).`,
              `Resolve it as the \`ship\` skill says: merge \`origin/${pr.base}\` in, resolve, regenerate the generated files, one commit.`,
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
        a = { ...a!, repair: { head: pr.head, record: String(r.id), ...(retry ? { retried: true } : {}) }, did: [...(a!.did ?? []), `ran the repair (merge \`${pr.base}\`, regenerate) at \`${pr.head.slice(0, 12)}\``] };
        return "acted";
      }
      case "fix_ci": {
        if (!s.fix.includes("ci")) return hold("a required check is red, and this repo's `fix` setting excludes CI");
        if (pr.fork && !pr.canModify) return hold(noEdits);
        // Red while behind a green base: perhaps only the base moved. GitHub updates the branch once at this head before any wake;
        // a refusal has spent its round and the fix follows.
        if (f.behindGreen && c.updated !== pr.head) {
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
          onBase.size ? `These fail on \`${pr.base}\`'s latest run too: ${[...onBase].map((n) => `\`${n}\``).join(", ")}. If the failure is the same there, it is pre-existing: say so on the task with the run you compared, and change nothing for it.` : "",
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
        if (merge === "off") return "nothing";
        const dismissing = await dismissStale();
        if (dismissing) return dismissing;
        if (a!.merge?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.merge.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          // A veto (the AI reviewer's or the owner's) is final for this head: never asked again.
          if (r.state === "rejected") return hold(`the merge at \`${pr.head.slice(0, 12)}\` was rejected (${String(r.reason ?? "no reason given").slice(0, 200)})`);
          // The PR moved meanwhile: the next head is the next round's.
          const text = String(r.outcome?.text ?? r.reason ?? r.state);
          if (/^ship-head-moved/.test(text)) return "nothing";
          // Ended by a pause or a stop (the adoption moved on): filed again now that it is worked again. Anything else didn't land:
          // the PR holds (its owner told, the outcome on the record), never filed again at this head; a new head resumes it.
          if (!/adoption ended or moved on|^ship-generation|^ship-tier-pending/.test(text)) return hold(`ship's merge at \`${pr.head.slice(0, 12)}\` ended ${String(r.state)}; its outcome is on record ${a!.merge.record}`);
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
          if (status !== undefined && status < 500) return hold(`ship's merge couldn't be filed: ${String((e as Error).message).slice(0, 200)}`);
          throw e;
        }
        a = { ...a!, merge: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked to merge at \`${pr.head.slice(0, 12)}\` (attempt ${attempt})`] };
        return "acted";
      }
      case "enqueue": {
        const q = qn;
        if (!q || q.act === "nothing") return "nothing";
        const dismissing = await dismissStale();
        if (dismissing) return dismissing;
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
      case "approve": {
        // Gated in code by the repo's `approve` and the evidence at this head, whatever decide was told.
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
        return hold(v.why ?? "stalled");
      default:
        // wait: the report says what it waits on.
        return "nothing";
    }
  };
  const did = await step();
  if (did === "acted" && fix && !updatedOnly) c.acted = [...(c.acted ?? []), act];
  if (a!.hold) return "acted";
  // A merge already asked for at this head: nothing new to say until its record ends.
  // A queue wait is reported once per head (its own marker), as the enqueue's own key is followed by its record.
  // A branch update alone is not the fix: its own marker, so a head still red next pass is asked to be fixed.
  const marker = queueWait ? `${key}:wait` : updatedOnly ? `${key}:updated` : key;
  if (did === "nothing" && c.lastRound === marker) return did;
  c.lastRound = marker;
  const state = v.do === "done" ? "merged" : v.do === "merge" ? (merge === "off" ? `ready (${risk?.state === "classified" ? `tier \`${risk.tier}\`: ` : ""}merge is off: a person merges it)` : "merging") : v.do === "enqueue" ? (merge === "off" ? `ready (${risk?.state === "classified" ? `tier \`${risk.tier}\`: ` : ""}merge is off: a person queues it)` : "queueing") : v.do === "approve" ? (a!.approve?.why ? "ready: waiting for a person's approval" : "approving") : v.do === "wait" ? "waiting" : "working";
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

/** Posts the report, or edits it in place (its id kept on the adoption). A task's PR gets none: its task is told instead. */
async function report(d: RoundDeps, a: Kept, pr: PrView, f: Facts) {
  if (a.owner?.kind === "task") return;
  try {
    const id = await d.comment(pr.repo, pr.number, renderReport(a, pr, f), a.report);
    if (id !== a.report || a.reportStale) { const { reportStale: _, ...kept } = a; d.state.put({ ...kept, report: id }); }
  } catch (e) {
    d.log("report failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
    d.state.put({ ...a, reportStale: { head: pr.head, facts: f } });
  }
}
