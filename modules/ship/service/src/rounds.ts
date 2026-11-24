// Rounds (spec §3): one decision per pass for an adopted PR, from merge-gate's decide. A round is a settled head: each (head,
// action) is acted on once. Ship's own effects come first (update-branch, the direct merge); the PR's Engineer task (the same task
// across rounds) is woken only for a conflict to repair, a red required check or open review findings. Past a cap, or on a step
// the repo's settings exclude, the PR goes on hold with the reason, its author assigned once, and the report says so.
// The loop (loop.ts) calls round() after intake() for each adopted PR it read, with decide's answer and this pass's facts.
import type { Discovered } from "./discover.ts";
import type { Kept, PrView } from "./handoff.ts";
import { renderReport, type Facts } from "./report.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";

/** merge-gate's decide answer for the PR at its head, with ship's context (github's merge-gate.ts Action). */
export type Decision = { do: "wait" | "repair" | "fix_ci" | "fix_review" | "approve" | "enqueue" | "merge" | "done" | "stall" | "fail"; why?: string };

/** This pass's facts beside decide: GitHub's mergeable state, the failing required checks and main's, and the generated paths. */
export interface RoundFacts {
  /** The head conflicts with the base (DIRTY), as opposed to merely being behind it. */
  dirty?: boolean;
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
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

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
  const people = pr.assignees.filter((x) => !(a!.assigned ?? []).includes(x));
  if (d.paused() || a.hold || pr.state !== "open" || pr.draft || pr.labels.includes(s.stop_label) || people.length) return "stopped";

  const c = a.counters && a.counters.head === pr.head ? a.counters : { ...(a.counters ?? { rounds: 0, ci: 0, review: 0, red: {} }), head: pr.head, wakes: 0 };
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
  const wake = async (kind: string, text: string) => {
    if (over(c.wakes, caps.wakes_per_head)) return hold(`woke the task ${c.wakes} times on this head (wakes_per_head)`);
    await d.kernel.call("POST", "/v1/wakes", { task: a!.task, text });
    c.wakes++;
    a = { ...a!, did: [...(a!.did ?? []), `${kind} at \`${pr.head.slice(0, 12)}\``] };
    return "acted" as const;
  };

  const push = () => `Push it onto the PR's branch with \`aidenhq ship push ${pr.url} ${pr.head} ${a!.generation}\`.`;
  // A round is a settled head: each (head, action) is taken once; a merge is followed by its record instead.
  const key = `${pr.head}:${v.do}`;
  if (v.do !== "merge" && c.lastRound === key) return "nothing";
  const step = async (): Promise<"acted" | "nothing"> => {
    if (["repair", "fix_ci", "fix_review"].includes(v.do)) {
      if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`);
      c.rounds++;
    }
    switch (v.do) {
      case "repair": {
        if (!s.fix.includes("conflicts")) return hold("it needs a repair, and this repo's `fix` setting excludes conflicts");
        if (!f.dirty) {
          await d.updateBranch(pr.repo, pr.number, pr.head);
          a = { ...a!, did: [...(a!.did ?? []), `updated the branch with \`${pr.defaultBranch}\``] };
          return "acted";
        }
        if (pr.fork && !pr.canModify) return hold("it conflicts, and its fork doesn't allow maintainer edits: the contributor can enable \"Allow edits by maintainers\" or rebase it");
        const plan = repairPlan(s, f.discovered);
        return wake("repair", [
          `${pr.url} conflicts with \`${pr.defaultBranch}\` at head ${pr.head}. Repair it as the \`ship\` skill says: first run`,
          "",
          `    aidenhq ship repair ${pr.url} ${pr.head} ${a!.generation} ${pr.defaultBranch} ${b64(plan)}`,
          "",
          "It merges the base, takes the base side of generated paths, regenerates them and pushes. Exit 3 lists the conflicts left for you (`leftover: <path>`); exit 4 is a generator failure.",
        ].join("\n"));
      }
      case "fix_ci": {
        if (!s.fix.includes("ci")) return hold("a required check is red, and this repo's `fix` setting excludes CI");
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
        if (over(c.review, caps.review_rounds)) return hold(`${c.review} review fix rounds (review_rounds)`);
        c.review++;
        return wake("fix_review", `${pr.url}: code review has open important findings (or changes requested) at head ${pr.head}. Verify each as the \`ship\` skill says: fix the real ones in one commit, decline the rest with evidence through code_review_resolve.\n${push()}`);
      }
      case "merge": {
        if (s.merge === "off") return "nothing";
        if (a!.merge?.head === pr.head) {
          const r = await d.kernel.call("GET", `/v1/writes/${a!.merge.record}`);
          if (OPEN.includes(String(r.state))) return "nothing";
          if (over(c.rounds, caps.rounds)) return hold(`${c.rounds} rounds (rounds)`);
          c.rounds++;
        }
        const attempt = a!.merge?.head === pr.head ? a!.merge.attempt + 1 : 1;
        const r = await d.kernel.call("POST", "/v1/writes", { kind: "github.merge", task: a!.task, args: { prs: [{ repo: pr.repo, number: pr.number, head: pr.head, base: pr.base }], generation: a!.generation, attempt } });
        a = { ...a!, merge: { head: pr.head, attempt, record: String(r.id) }, did: [...(a!.did ?? []), `asked to merge at \`${pr.head.slice(0, 12)}\` (attempt ${attempt})`] };
        return "acted";
      }
      case "stall":
        return hold(v.why ?? "stalled");
      case "done":
        // A handed-over PR's task ends once it landed; a fleet PR's task is its opener's.
        if (a!.trigger.kind !== "fleet") await d.kernel.call("POST", `/v1/tasks/${a!.task}/close`, { status: "done", body: `${pr.url} is merged.` }).catch((e) => d.log("task close failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) }));
        return "acted";
      default:
        // wait; approve and enqueue are later lanes (D2, D3): the report says what it waits on.
        return "nothing";
    }
  };
  const did = await step();
  if (a!.hold) return "acted";
  // A merge already asked for at this head: nothing new to say until its record ends.
  if (did === "nothing" && c.lastRound === key) return did;
  c.lastRound = key;
  const state = v.do === "done" ? "merged" : v.do === "merge" ? "merging" : ["approve", "enqueue"].includes(v.do) ? "ready" : v.do === "wait" ? "waiting" : "working";
  await save(state, ["wait", "approve", "enqueue"].includes(v.do) ? v.why : undefined);
  return did;
}

/** Posts the report, or edits it in place (its id kept on the adoption). */
async function report(d: RoundDeps, a: Kept, pr: PrView, f: Facts) {
  try {
    const id = await d.comment(pr.repo, pr.number, renderReport(a, pr, f), a.report);
    if (id !== a.report) d.state.put({ ...a, report: id });
  } catch (e) {
    d.log("report failed", { pr: pr.url, err: String((e as Error).message).slice(0, 200) });
  }
}
