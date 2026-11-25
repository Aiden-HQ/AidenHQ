// The one engine's pass for every PR the loop reads but a Dependabot PR that is failing or the Engineer's (loop.ts calls it for each): the hand-off's intake and, once
// adopted, its round (handoff.ts, rounds.ts). A task's PR (the code host opened it for that task) is adopted at first sight and
// follows its task: closed with its branch when the task is cancelled, superseded by a newer PR of the same task, or done with no
// merge of it in flight. This file turns the loop's GitHub reads into their PrView and facts (github's decision from the list
// node, the CI recoveries' answer), and supplies the GitHub effects they need (a trigger author's role, assignees, update-branch,
// a close) through github's /internal/ship/* routes. Where the PR waits only on an approval, it reads the PR's own change and code
// review's verdict and judges the App's approval (safe.ts).
import { discovered } from "./actions.ts";
import { withFooter } from "./aidenhq-sdk/attribution.ts";
import { namedChecks } from "./aidenhq-sdk/checks.ts";
import type { Recovery } from "./ci-recover.ts";
import { handBack, intake, recordTask, type HandoffDeps, type Kept, type PrView, type TriggerEvent } from "./handoff.ts";
import { retryReport, round, tell, type Decision, type RoundDeps } from "./rounds.ts";
import { canApprove, judge, sameChange, riskOf, type ChangedFile, type Judged, type Risk, type Verdict } from "./safe.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";

type Json = any;
const HALF_HOUR = 30 * 60_000;
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type AdoptedOptions = {
  gh: Gh; state: State;
  settings(repo: string): ShipSettings | null; paused(): boolean;
  /** The kernel as ship (its module token): throws on a refusal. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any> };
  /** github's round decision for an adopted PR (merges.ts decision): decide's answer, the required checks red on the head, DIRTY,
   * whether the branch merges through a merge queue, the required checks red on the PR's latest merge_group run, and whether an
   * approval of the head is all it waits on. */
  decision(repo: string, number: number, head: string, view: { pr: Json; main: { name: string; oid?: string; rollup?: Json }; stackedOn?: number }): Promise<Decision & { failing?: string[]; dirty?: boolean; queue?: boolean; groupFailing?: string[]; approval?: boolean; findingsKey?: string }>;
  /** The report comment, code review's asks and its verdict (effects.ts shipEffects). */
  effects: { comment: RoundDeps["comment"]; askReview: HandoffDeps["askReview"]; askFresh: RoundDeps["askFresh"]; verdict(repo: string, number: number, head: string, live?: { base?: string; association?: string }): Promise<Verdict> };
  log(msg: string, f?: Record<string, unknown>): void;
};

/** A GraphQL timeline node as a trigger event (a label or a comment), or undefined. */
function eventOf(n: Json): TriggerEvent | undefined {
  const who = n.actor ?? n.author;
  const base = { id: String(n.id), actor: String(who?.login ?? ""), bot: who?.__typename !== "User", at: String(n.createdAt) };
  if (n.__typename === "LabeledEvent") return { ...base, kind: "labeled", label: String(n.label?.name ?? "") };
  if (n.__typename === "UnlabeledEvent") return { ...base, kind: "unlabeled", label: String(n.label?.name ?? "") };
  if (n.__typename === "IssueComment") return { ...base, kind: "comment", body: String(n.body ?? "").slice(0, 200) };
  return undefined;
}

/** The loop's GraphQL node for an open PR as the hand-off reads it. */
export function viewOf(repo: string, defaultBranch: string, pr: Json, extra: { baseOid?: string; headSeen?: string } = {}): PrView {
  return {
    ...(extra.baseOid && pr.baseRefName === defaultBranch ? { baseOid: extra.baseOid } : {}), ...(extra.headSeen ? { headSeen: extra.headSeen } : {}),
    repo, number: pr.number, url: pr.url, head: pr.headRefOid, base: pr.baseRefName, defaultBranch,
    author: String(pr.author?.login ?? ""), authorBot: pr.author?.__typename !== "User",
    fork: pr.isCrossRepository === true, canModify: pr.maintainerCanModify === true, ...(pr.headRepository?.nameWithOwner ? { headRepo: String(pr.headRepository.nameWithOwner) } : {}), draft: pr.isDraft === true, state: "open",
    labels: (pr.labels?.nodes ?? []).map((l: Json) => String(l.name)), assignees: (pr.assignees?.nodes ?? []).map((a: Json) => String(a.login)),
    events: (pr.timelineItems?.nodes ?? []).map(eventOf).filter((e: TriggerEvent | undefined): e is TriggerEvent => !!e).sort((a: TriggerEvent, b: TriggerEvent) => a.at.localeCompare(b.at)),
  };
}

/** An adoption whose PR left the open list and whose end is recorded (closed, or merged with its report current): gone() is done with it. */
export const ended = (a: Pick<Kept, "counters" | "reportStale">) => a.counters?.lastRound === "closed" || (!!a.counters?.lastRound?.endsWith(":done") && !a.reportStale);

export function adoptedPass(o: AdoptedOptions) {
  /** A PR stopped by its own hand: a draft, the stop label, or a person assigned (not by ship). No hold is set for it. */
  const isStopped = (repo: string, view: PrView, a: Kept | undefined) =>
    view.draft || view.labels.includes(o.settings(repo)?.stop_label ?? "ship:stop") || view.assignees.some((x) => !(a?.assigned ?? []).includes(x));
  /** Per repo, the PRs this scan runs a round on toward the default branch and nobody stopped (see(), kept current by open()): the only ones front() ranks. */
  const eligible = new Map<string, Set<number>>();
  /**
   * Whether the PR is first in the repo's merge order (item 19): the earliest hand-off among the repo's open adoptions that ship
   * still works (eligible, not held). Under `rebase: conflict` only that one is brought up to date; the rest wait their turn.
   */
  const front = (repo: string, number: number, open: Set<number>) => {
    const live = eligible.get(repo.toLowerCase());
    const order = (o.state.all() as Kept[])
      .filter((a) => a.repo.toLowerCase() === repo.toLowerCase() && open.has(a.number) && !a.hold && !a.kept && !a.stack && !!live?.has(a.number))
      .sort((x, y) => String(x.trigger.at ?? "").localeCompare(String(y.trigger.at ?? "")) || x.number - y.number);
    return order[0]?.number === number;
  };
  const must = async (method: string, path: string, body?: unknown) => {
    const r = await o.gh(method, path, body);
    if (r.status >= 300) throw new Error(`GitHub ${method} ${path}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`);
    return r.body;
  };
  const roles = new Map<string, string | null>(); // `<repo>:<login>` -> role, for one pass
  const seen = new Map<string, { head: string; at: string }>(); // `<repo>#<n>` -> its head, and when this process first saw it
  const handoff: HandoffDeps = {
    state: o.state, settings: o.settings, paused: o.paused, kernel: o.kernel, askReview: o.effects.askReview, log: o.log,
    async permission(repo, login) {
      const k = `${repo.toLowerCase()}:${login.toLowerCase()}`;
      if (!roles.has(k)) {
        const r = await o.gh("GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
        roles.set(k, r.status < 300 ? String(r.body?.role_name ?? r.body?.permission ?? "") || null : null);
      }
      return roles.get(k)!;
    },
    unassign: async (repo, n, logins) => void (await must("DELETE", `/repos/${repo}/issues/${n}/assignees`, { assignees: logins })),
    // The kernel records the commit each write made (/v1/objects); the write must be on this adoption's tasks, of this generation,
    // and start from `from`: a push the Engineer made on top of the author's new commit is not one ship made from the hand-off.
    async madeFrom(a, pr, from) {
      if (!pr.headRepo) return undefined;
      const tasks = [a.task, a.holder].filter((t): t is string => Boolean(t));
      if (!tasks.length) return undefined;
      const records = (await Promise.all(tasks.map((t) => o.kernel.call("GET", `/v1/work?task=${encodeURIComponent(t)}`)))).flatMap((w: Json) => (w?.records ?? []) as Json[])
        // The kernel files `aidenhq ship push` (codehost.push) as its host's kind: github.push, as /v1/work lists it.
        .filter((r: Json) => ["github.push", "github.repair"].includes(r.kind) && r.args?.generation === a.generation && (r.args?.expected ?? r.args?.head) === from);
      if (records.some((r: Json) => r.state === "claimed")) return "writing";
      const made = await o.kernel.call("GET", `/v1/objects?ref=${encodeURIComponent(`github:${pr.headRepo.toLowerCase()}@${pr.head}`)}`);
      return made?.ours && records.some((r: Json) => r.state === "done" && String(r.id) === String(made.record)) ? "ours" : undefined;
    },
    // Strict: every path counts (generated ones too), and a head that can't be compared (the author rewrote it away) is a change.
    async sameChange(pr, from) {
      // The base as a commit (the proxy compares commits only): the default branch's tip this pass read.
      if (!pr.baseOid) return false;
      const read = async (h: string) => {
        const r = await o.gh("GET", `/repos/${pr.repo}/compare/${pr.baseOid}...${h}`);
        if (r.status === 404 || r.status === 422) return undefined;
        if (r.status >= 300) throw new Error(`GitHub GET compare: ${r.status}`);
        return (r.body?.files ?? []) as ChangedFile[];
      };
      const [was, now] = await Promise.all([read(from), read(pr.head)]);
      if (!was || !now || !sameChange(was, now)) return false;
      // A compare's patches carry no file mode: each changed path's mode is read from both heads' trees (a tree GitHub cut short, or
      // one it can't read, is a change).
      const modes = async (h: string) => {
        const r = await o.gh("GET", `/repos/${pr.repo}/git/trees/${h}?recursive=1`);
        // A transient failure is retried next pass (the loop's error path), never read as a change.
        if (r.status >= 500 || r.status === 429 || r.status === 403) throw new Error(`GitHub GET tree: ${r.status}`);
        if (r.status >= 300 || r.body?.truncated !== false) return undefined;
        return new Map(((r.body?.tree ?? []) as { path: string; mode: string }[]).map((e) => [e.path, e.mode]));
      };
      const [a, b] = await Promise.all([modes(from), modes(pr.head)]);
      return !!a && !!b && now.every((f) => [f.filename, f.previous_filename].every((p) => p === undefined || a.get(p) === b.get(p)));
    },
  };
  const rounds: RoundDeps = {
    state: o.state, settings: o.settings, paused: o.paused, kernel: o.kernel, comment: o.effects.comment, askFresh: o.effects.askFresh, log: o.log, gh: o.gh,
    updateBranch: async (repo, n, head) => void (await must("PUT", `/repos/${repo}/pulls/${n}/update-branch`, { expected_head_sha: head })),
    assign: async (repo, n, logins) => void (await must("POST", `/repos/${repo}/issues/${n}/assignees`, { assignees: logins })),
  };
  /** The PR's own change from its merge base with `base` (GitHub's compare files). */
  const changed = async (repo: string, base: string, head: string) => ((await must("GET", `/repos/${repo}/compare/${base}...${head}`))?.files ?? []) as ChangedFile[];
  /** judge() at the head: code review's verdict, the PR's change, and the change at the head the verdict stands on when it isn't this one. */
  const approvalOf = async (s: ShipSettings, view: PrView, base: string, verdict: Verdict): Promise<Judged> => {
    // The PR's own change is read only where a pass stands on an earlier head (carries): a completed or absent one needs none.
    const files = verdict.verdict === "pass" && verdict.kind !== "completed" && verdict.kind !== "none" ? await changed(view.repo, base, view.head) : [];
    // The reviewed head may be gone (a force-push): its change can't be read, so nothing carries and a fresh review is asked for.
    const reviewedChange = async (h: string) => { const r = await o.gh("GET", `/repos/${view.repo}/compare/${base}...${h}`); if (r.status === 404 || r.status === 422) return undefined; if (r.status >= 300) throw new Error(`GitHub GET compare: ${r.status}`); return (r.body?.files ?? []) as ChangedFile[]; };
    const reviewedFiles = verdict.verdict === "pass" && verdict.kind !== "completed" && verdict.reviewed ? await reviewedChange(verdict.reviewed) : undefined;
    // The generated paths: the repo's setting, else discovery on the target branch (as the repair's plan reads them).
    const generated = s.generated?.globs ?? (await discovered(o.gh, view.repo, view.base)).globs;
    return judge(s, { files, generated, verdict, ...(reviewedFiles ? { reviewedFiles } : {}) });
  };
  /**
   * A task's PR follows its task (`task`: its identifier, as pr-tasks.json names it). Cancelled: the PR and its branch are left
   * open for a successor and noted once (a successor publishing to the branch takes it over), and nothing else runs. Superseded by a
   * newer PR of the same task into the same base, or done with this head half an hour old, each with no merge of it in flight:
   * closed, and its branch deleted only while still at this head with no other open PR on it. True when the round is skipped.
   */
  const lifecycle = async (a: Kept, view: PrView, pr: Json, work: Json, task: string, newer: string | undefined, stopped: boolean): Promise<boolean> => {
    if (work.status === "cancelled") {
      if (a.kept === task) return true;
      const text = `Left open by the code host: ${task}, the task this PR was for, is cancelled. The PR and its branch \`${pr.headRefName}\` are left as they are for a successor task to finish, and this PR is not closed or deleted while it waits. A successor takes it over by checking \`${pr.headRefName}\` out and publishing to it (\`aidenhq publish\` with that branch): that records the successor as the PR's task and the PR is worked for it again.`;
      const c = await o.gh("POST", `/repos/${view.repo}/issues/${view.number}/comments`, { body: withFooter(text, "Ship") }).catch(() => undefined);
      if (!c || c.status >= 300) { o.log("cancelled task's PR left open: note not posted, retried next pass", { pr: view.url, task }); return true; }
      o.state.put({ ...a, kept: task } as Kept);
      o.log("cancelled task's PR left open", { pr: view.url, task });
      return true;
    }
    // A task that resumed takes its PR back into the merge order.
    if (a.kept) { const { kept: _, ...rest } = a; a = rest as Kept; o.state.put(a); }
    // A merge or an enqueue of it in flight, or the PR in GitHub's merge queue: nothing is retired under it.
    const ours = (r: Json) => (r.args?.prs ?? [r.args ?? {}]).some((p: Json) => String(p.repo).toLowerCase() === view.repo.toLowerCase() && p.number === view.number);
    const merging = pr.isInMergeQueue === true || (work.records ?? []).some((r: Json) => ["github.merge", "github.enqueue"].includes(r.kind) && ["review", "owner", "approved", "claimed"].includes(r.state) && ours(r));
    if (a.seen?.head !== view.head) { a = { ...a, seen: { head: view.head, at: new Date().toISOString() } }; o.state.put(a); }
    // Only a known task status retires a PR (a read without one says nothing about cancellation).
    const why = merging || stopped || !work.status ? undefined
      : newer ? `Closing: superseded by ${newer}, the newer PR ${task} published for the same task.`
      : work.status === "done" && Date.now() - Date.parse(a.seen!.at) >= HALF_HOUR ? `Closing: its task ${task} is done; its change landed elsewhere or isn't needed.` : undefined;
    if (!why) return false;
    // The close names the task it was decided for: github re-reads the PR's ownership under the branch lock and skips a PR a
    // successor took over meanwhile.
    const c = await o.gh("PATCH", `/repos/${view.repo}/pulls/${view.number}`, { state: "closed", expectTask: task });
    if (c.status >= 300) { o.log("task's PR not closed: retried next pass", { pr: view.url, task, status: c.status }); return true; }
    o.state.put({ ...a, hold: { kind: "stopped", reason: why, at: new Date().toISOString() } });
    await o.gh("POST", `/repos/${view.repo}/issues/${view.number}/comments`, { body: withFooter(why, "Ship") });
    // The branch goes only while it is still at this PR's head and no open PR uses it (a read that fails keeps it).
    const [owner] = view.repo.split("/");
    const ref = await o.gh("GET", `/repos/${view.repo}/git/ref/heads/${pr.headRefName}`).catch(() => undefined);
    const uses = await o.gh("GET", `/repos/${view.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.headRefName}`)}`).catch(() => undefined);
    const keep = !ref || ref.status >= 300 || String(ref.body?.object?.sha ?? "") !== view.head || !uses || uses.status >= 300 || (uses.body ?? []).length > 0;
    const d = keep ? undefined : await o.gh("DELETE", `/repos/${view.repo}/git/refs/heads/${pr.headRefName}`, { expectTask: task });
    o.log("task's PR closed", { pr: view.url, task, branchDeleted: !!d && d.status < 300 });
    return true;
  };
  /**
   * The PR this one stood on has left the open list: merged, this PR goes onto the default branch (github's `retarget`, once per
   * head; GitHub does it itself only when the merged branch is deleted). True when it was asked this pass.
   */
  const retargeted = async (a: Kept, view: PrView, to: string): Promise<boolean> => {
    if (a.retarget?.head === view.head) {
      // Filed at this head: a record that ended without it (a refusal, a veto) holds the PR with its reason.
      const r = await o.kernel.call("GET", `/v1/writes/${a.retarget.record}`).catch(() => undefined);
      if (!r || !["failed", "rejected", "stale"].includes(String(r.state))) return false;
      // round()'s own hold: bound to this head, its owner told (a task's asker, a member's report and assignment).
      await round(rounds, view, { do: "stall", why: `the retarget onto \`${to}\` ended ${r.state}: ${String(r.outcome?.text ?? r.reason ?? "").slice(0, 200)}` });
      return true;
    }
    const under = await o.gh("GET", `/repos/${view.repo}/pulls/${a.stack!.number}`);
    // Only a parent merged into the default branch moves its child there; one merged elsewhere leaves the child waiting.
    if (under.status >= 300 || !under.body?.merged_at || under.body?.base?.ref !== to) return false;
    const holder = a.task || a.holder ? undefined : await recordTask(o.kernel, view, a);
    if (holder) a = { ...a, holder };
    const r = await o.kernel.call("POST", "/v1/writes", { kind: "github.retarget", task: a.task ?? a.holder, args: { repo: view.repo, number: view.number, head: view.head, generation: a.generation, base: view.base, to } });
    o.state.put({ ...a, retarget: { head: view.head, record: String(r.id) }, did: [...(a.did ?? []), `retargeted onto \`${to}\`: #${a.stack!.number} merged`] } as Kept);
    o.log("stacked PR retargeted", { pr: view.url, from: view.base, to });
    return true;
  };
  return {
    /** A new pass: roles are read again. */
    begin() { roles.clear(); },
    /**
     * A repo's scan, before any of its PRs runs: `prs` are the ones the scan will run a round on. Those into the default branch
     * that nobody stopped are the merge order's candidates (front()), the one definition of who can hold the front.
     */
    see(repo: string, defaultBranch: string, prs: Json[]) {
      eligible.set(repo.toLowerCase(), new Set(prs.filter((pr) => pr.baseRefName === defaultBranch && !isStopped(repo, viewOf(repo, defaultBranch, pr), o.state.get(repo, pr.number) as Kept | undefined)).map((pr) => Number(pr.number))));
    },
    /**
     * One open PR: intake, then a round once adopted. `ctx.opener`: the task the code host opened it for (its identifier);
     * `ctx.newer`: a newer open PR of that same task; `ctx.recover`: its CI recoveries (ci-recover.ts), run once its task's
     * lifecycle has kept it (a PR about to be closed or left for a successor spends no CI).
     */
    async open(repo: string, main: { name: string; oid?: string; rollup: Json }, pr: Json, open: Set<number> = new Set([pr.number]), ctx: { opener?: string; newer?: string; stackedOn?: { number: number; base: string }; recover?: () => Promise<Recovery>; bump?: boolean } = {}) {
      // When this process first saw the PR's head: a fork's hand-off counts only for a head already there when it was made.
      const k = `${repo.toLowerCase()}#${pr.number}`;
      if (seen.get(k)?.head !== pr.headRefOid) seen.set(k, { head: String(pr.headRefOid), at: new Date().toISOString() });
      const view = viewOf(repo, main.name, pr, { baseOid: main.oid, headSeen: seen.get(k)!.at });
      // The task as the kernel keeps it, read once a pass: its id names the adoption's task, its state the PR's lifecycle.
      const work = ctx.opener ? await o.kernel.call("GET", `/v1/work?task=${encodeURIComponent(ctx.opener)}`).catch((e: Error) => (o.log("task read failed", { pr: view.url, err: String(e.message).slice(0, 200) }), undefined)) : undefined;
      const taskId = ctx.opener && work ? String(work.jobs?.find((j: Json) => typeof j.task === "string" && j.task)?.task ?? ctx.opener) : undefined;
      // A task's PR whose task couldn't be read waits a pass: never taken in as a member's meanwhile (the loop reads it again).
      if (ctx.opener && !work) throw new Error(`its task ${ctx.opener} couldn't be read`);
      let a = await intake(handoff, view, taskId, ctx.bump) as Kept | undefined;
      // A stopped PR gets no CI re-run either: recovery runs only for one nobody stopped.
      const recover = (x: Kept | undefined) => isStopped(repo, view, x) ? Promise.resolve(undefined) : ctx.recover?.();
      if (!a) { await recover(a); return; }
      if (a.owner?.kind === "task") {
        // Closed by ship (a stop): nothing more until a successor publishes to it.
        if (a.hold?.kind === "stopped") return;
        // A stopped PR is never closed for its task (lifecycle keeps its bookkeeping all the same).
        if (work && await lifecycle(a, view, pr, work, ctx.opener!, ctx.newer, isStopped(repo, view, a))) return;
        // A done task starts nothing new (its leftover PR waits for its close); a merge of it its task filed itself is left to run.
        if (work?.status === "done") return;
        const own = new Set([a.merge?.record, (a as Kept & { queue?: { record: string } }).queue?.record].filter(Boolean).map(String));
        if ((work?.records ?? []).some((r: Json) => !own.has(String(r.id)) && ["github.merge", "github.enqueue"].includes(r.kind) && ["review", "owner", "approved", "claimed"].includes(r.state) && (r.args?.prs ?? [r.args ?? {}]).some((p: Json) => String(p.repo).toLowerCase() === repo.toLowerCase() && p.number === view.number))) return;
      } else if (a.task && !a.hold) {
        // A ship task cancelled outside a wake ends the adoption (a hold): never a close of the PR or a touch of its ref.
        const w = await o.kernel.call("GET", `/v1/work?task=${encodeURIComponent(a.task)}`).catch(() => undefined);
        if (w?.status === "cancelled") { handBack(o.state, repo, pr.number, "its task was cancelled"); return; }
      }
      const recovery = await recover(a);
      a = o.state.get(repo, pr.number) as Kept;
      // A parent recorded before stays the parent while the branch now only feeds another base (a backport): once it merged into
      // the default branch, the child follows it there.
      if (ctx.stackedOn && a.stack && a.stack.number !== ctx.stackedOn.number && ctx.stackedOn.base !== main.name) ctx = { ...ctx, stackedOn: undefined };
      // A stack: it waits on the PR whose branch is its base (decide says so); once that PR merged, it is retargeted onto the
      // default branch, brought up to date with it, and then takes the normal path (checks, review, merge). Down a chain too.
      // The relation is kept whatever holds the PR, so a parent that merged meanwhile is still known.
      if (ctx.stackedOn && (a.stack?.number !== ctx.stackedOn.number || a.stack.branch !== view.base)) { a = { ...a, stack: { number: ctx.stackedOn.number, branch: view.base } }; o.state.put(a); }
      // A stalled hold is round()'s to clear on a new head; any other hold, or a pause, only retries a report that failed.
      const resumes = a.hold?.kind === "stalled" && !!a.counters && a.counters.head !== view.head;
      if ((a.hold && !resumes) || o.paused()) { await retryReport(rounds, a, view); return; }
      // The PR's own stops hold a retarget too: a draft, the stop label, or a person assigned.
      const stopped = isStopped(repo, view, a);
      // Intake may have changed the adoption since see() (a hand-off clears `assigned`): its stop is read again here.
      if (stopped) eligible.get(repo.toLowerCase())?.delete(pr.number);
      if (!stopped && !ctx.stackedOn && a.stack && a.stack.branch === view.base && view.base !== main.name && await retargeted(a, view, main.name)) return;
      // A stack that reached the default branch (ship's retarget, or GitHub's own once the parent's branch was deleted): its base
      // is merged in first, a new head code review reviews whole; nothing moves on the old head. A conflict goes to the repair.
      if (!stopped && a.stack && view.base === main.name) {
        if (a.stack.landed === undefined) {
          try { await rounds.updateBranch(repo, view.number, view.head); }
          catch (e) {
            const why = String((e as Error).message);
            // A conflict: the normal path's repair makes the new head (a conflicting PR can't merge on the old one anyway).
            // A conflict goes to the repair; nothing new to bring in means it already has the base: either way the normal path runs.
            if (/: 422\b/.test(why) && /conflict|no new commits|up to date/i.test(why)) { const { stack: _, ...rest } = a; a = rest as Kept; o.state.put(a); }
            else { await round(rounds, view, { do: "stall", why: `GitHub refused to bring \`${main.name}\` into it after its retarget: ${why.slice(0, 200)}` }); return; }
          }
          if (a.stack) { o.state.put({ ...a, stack: { ...a.stack, landed: view.head } }); return; }
        } else if (a.stack.landed === view.head) return;
        else { const { stack: _, ...rest } = a; a = rest as Kept; o.state.put(a); }
      }
      const v = await o.decision(repo, pr.number, view.head, { pr, main, ...(ctx.stackedOn ? { stackedOn: ctx.stackedOn.number } : {}) });
      // Red checks whose jobs never started are being re-run (ci-recover.ts): no fix is asked for a failure CI never ran.
      if (v.do === "fix_ci" && recovery?.envRed) Object.assign(v, { do: "wait", why: "re-running required checks whose jobs never started" });
      // A check run still pending well after its job finished and was re-run: no push fixes it, so its owner is told once per head.
      if (recovery?.wedgedDue && v.do === "wait" && /still running on its head/.test(v.why ?? "") && a.wedgedTold !== view.head) {
        const how = recovery.wedgedDue === "accepted" ? "after its Actions job completed and the job had been re-run" : "after its Actions job completed, and the request to re-run the job was refused";
        await tell(rounds, a, view, `${view.url}'s check run is still \`in_progress\` at \`${view.head}\` ${how}, and the merge gate is held by it: this head cannot merge. A push does not fix it. Leave the head alone and report the wedged check run to the owner, or wait for a re-run to repost it; \`gh pr checks ${view.url}\` names it.`, `wedged.${view.head.slice(0, 12)}`);
        o.log("wedged check run reported", { pr: view.url, head: view.head });
        a = { ...a, wedgedTold: view.head };
        o.state.put(a);
      }
      // The head's risk tier, read for every PR (the merge is per tier): code review's verdict with the live base and author. A head
      // not classified yet waits at approve, enqueue and merge alike; never guessed.
      const s = o.settings(repo);
      // A verdict that can't be read (code review down) is a head not classified: this PR waits, the others' rounds go on.
      const verdict = s ? await o.effects.verdict(repo, pr.number, view.head, { base: view.base, association: String(pr.authorAssociation ?? "") }).catch((e: Error) => { o.log("code review's verdict unreadable", { pr: view.url, err: String(e.message).slice(0, 200) }); return { verdict: "wait", reasons: [], tier: { state: "pending" } } as Verdict; }) : undefined;
      const risk: Risk | undefined = s && verdict ? riskOf(s, verdict) : undefined;
      if (risk?.state === "pending" && ["approve", "enqueue", "merge"].includes(v.do)) Object.assign(v, { do: "wait", why: risk.why });
      // Waiting only on an approval: the evidence is judged, and decide's `approve` is taken where the tier's `approve` allows it.
      const approval = v.approval && s && verdict && risk && risk.approve !== "off" && main.oid ? await approvalOf(s, view, main.oid, verdict) : undefined;
      if (canApprove(approval)) Object.assign(v, { do: "approve", why: "ready, and no approval on its head yet" });
      // Red on the base too: the same required check names (on the head or the merge_group run) red on the default branch's head.
      const onBase = new Set(namedChecks(main.rollup).filter((c) => !c.ok && !c.pending).map((c) => c.name));
      const red = [...new Set([...(v.failing ?? []), ...(v.groupFailing ?? [])])];
      // Red while behind a green base: round() has GitHub update the branch once at this head before asking for a fix.
      const behindGreen = v.do === "fix_ci" && main.rollup?.state === "SUCCESS" && main.oid && a.counters?.updated !== view.head
        ? Number((await o.gh("GET", `/repos/${repo}/compare/${main.oid}...${view.head}`)).body?.behind_by) > 0 : false;
      await round(rounds, view, { do: v.do, ...(v.why ? { why: v.why } : {}) }, { dirty: !!v.dirty, front: front(repo, pr.number, open), queue: !!v.queue, failing: v.failing ?? [], groupFailing: v.groupFailing ?? [], onBase: red.filter((n) => onBase.has(n)), ...(approval ? { approval } : {}), ...(risk ? { risk } : {}), ...(v.findingsKey ? { findingsKey: v.findingsKey } : {}), ...(behindGreen ? { behindGreen } : {}) });
    },
    /** The adoptions of `repo` whose PR left the open list: a merged one ends its adoption once (a hand-off's task closes, a task's PR tells it). */
    async gone(repo: string, defaultBranch: string, open: Set<number>) {
      for (const a of o.state.all() as Kept[]) {
        if (a.repo.toLowerCase() !== repo.toLowerCase() || open.has(a.number) || ended(a)) continue;
        const r = await o.gh("GET", `/repos/${repo}/pulls/${a.number}`);
        if (r.status >= 300) continue;
        // A held adoption is still finished when someone merges its PR (round closes the hand-off's task). A closed one is handed
        // back (when it isn't held already) and never read again: `lastRound` "closed" ends it, whatever its hold.
        if (!r.body?.merged_at) {
          if (r.body?.state !== "closed") continue;
          if (!a.hold) handBack(o.state, repo, a.number, "its PR was closed");
          const b = o.state.get(repo, a.number) as Kept;
          o.state.put({ ...b, counters: { ...(b.counters ?? { head: "", wakes: 0, rounds: 0, ci: 0, review: 0, red: {} }), lastRound: "closed" } } as Kept);
          continue;
        }
        const view: PrView = { repo, number: a.number, url: String(r.body.html_url), head: String(r.body.head?.sha), base: String(r.body.base?.ref), defaultBranch, author: String(r.body.user?.login ?? ""), authorBot: r.body.user?.type !== "User", fork: false, canModify: false, draft: false, state: "merged", labels: [], assignees: [], events: [] };
        // One PR's notice that didn't land never holds the others: it is retried next pass.
        await round(rounds, view, { do: "done" }).catch((e) => o.log("landed round failed", { pr: view.url, err: String((e as Error).message).slice(0, 200) }));
      }
    },
  };
}
