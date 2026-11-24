// The watch loop's pass for the PRs that aren't the fleet's own (loop.ts calls it for each one it reads): the hand-off's intake and,
// once adopted, its round (handoff.ts, rounds.ts). This file turns the loop's GitHub reads into their PrView and facts, and supplies
// the GitHub effects they need (a trigger author's role, assignees, update-branch) through github's /internal/ship/* routes. Where
// the PR waits only on an approval, it reads the PR's own change and code review's verdict and judges the App's approval (safe.ts).
import { discovered } from "./actions.ts";
import { namedChecks } from "./aidenhq-sdk/checks.ts";
import { handBack, intake, type HandoffDeps, type Kept, type PrView, type TriggerEvent } from "./handoff.ts";
import { retryReport, round, type Decision, type RoundDeps } from "./rounds.ts";
import { canApprove, judge, type ChangedFile, type Judged, type Verdict } from "./safe.ts";
import type { ShipSettings } from "./settings.ts";
import type { State } from "./state.ts";

type Json = any;
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type AdoptedOptions = {
  gh: Gh; state: State;
  settings(repo: string): ShipSettings | null; paused(): boolean;
  /** The kernel as ship (its module token): throws on a refusal. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any> };
  /** github's round decision for an adopted PR (merges.ts decision): decide's answer, the required checks red on the head, DIRTY,
   * whether the branch merges through a merge queue, the required checks red on the PR's latest merge_group run, and whether an
   * approval of the head is all it waits on. */
  decision(repo: string, number: number, head: string): Promise<Decision & { failing?: string[]; dirty?: boolean; queue?: boolean; groupFailing?: string[]; approval?: boolean }>;
  /** The report comment, code review's asks and its verdict (effects.ts shipEffects). */
  effects: { comment: RoundDeps["comment"]; askReview: HandoffDeps["askReview"]; askFresh: RoundDeps["askFresh"]; verdict(repo: string, number: number, head: string): Promise<Verdict> };
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
export function viewOf(repo: string, defaultBranch: string, pr: Json): PrView {
  return {
    repo, number: pr.number, url: pr.url, head: pr.headRefOid, base: pr.baseRefName, defaultBranch,
    author: String(pr.author?.login ?? ""), authorBot: pr.author?.__typename !== "User",
    fork: pr.isCrossRepository === true, canModify: pr.maintainerCanModify === true, draft: pr.isDraft === true, state: "open",
    labels: (pr.labels?.nodes ?? []).map((l: Json) => String(l.name)), assignees: (pr.assignees?.nodes ?? []).map((a: Json) => String(a.login)),
    events: (pr.timelineItems?.nodes ?? []).map(eventOf).filter((e: TriggerEvent | undefined): e is TriggerEvent => !!e).sort((a: TriggerEvent, b: TriggerEvent) => a.at.localeCompare(b.at)),
  };
}

export function adoptedPass(o: AdoptedOptions) {
  /**
   * Whether the PR is first in the repo's merge order (item 19): the earliest hand-off among the repo's open adoptions that ship
   * still works (not the fleet's, not held). Under `rebase: conflict` only that one is brought up to date; the rest wait their turn.
   */
  const front = (repo: string, number: number, open: Set<number>) => {
    const order = (o.state.all() as Kept[])
      .filter((a) => a.repo.toLowerCase() === repo.toLowerCase() && open.has(a.number) && a.trigger.kind !== "fleet" && !a.hold)
      .sort((x, y) => String(x.trigger.at ?? "").localeCompare(String(y.trigger.at ?? "")) || x.number - y.number);
    return order[0]?.number === number;
  };
  const must = async (method: string, path: string, body?: unknown) => {
    const r = await o.gh(method, path, body);
    if (r.status >= 300) throw new Error(`GitHub ${method} ${path}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`);
    return r.body;
  };
  const roles = new Map<string, string | null>(); // `<repo>:<login>` -> role, for one pass
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
  };
  const rounds: RoundDeps = {
    state: o.state, settings: o.settings, paused: o.paused, kernel: o.kernel, comment: o.effects.comment, askFresh: o.effects.askFresh, log: o.log, gh: o.gh,
    updateBranch: async (repo, n, head) => void (await must("PUT", `/repos/${repo}/pulls/${n}/update-branch`, { expected_head_sha: head })),
    assign: async (repo, n, logins) => void (await must("POST", `/repos/${repo}/issues/${n}/assignees`, { assignees: logins })),
  };
  /** The PR's own change from its merge base with `base` (GitHub's compare files). */
  const changed = async (repo: string, base: string, head: string) => ((await must("GET", `/repos/${repo}/compare/${base}...${head}`))?.files ?? []) as ChangedFile[];
  /** judge() at the head: code review's verdict, the PR's change, and the change at the head the verdict stands on when it isn't this one. */
  const approvalOf = async (s: ShipSettings, view: PrView, base: string): Promise<Judged> => {
    const verdict = await o.effects.verdict(view.repo, view.number, view.head);
    const files = await changed(view.repo, base, view.head);
    // The reviewed head may be gone (a force-push): its change can't be read, so nothing carries and a fresh review is asked for.
    const reviewedChange = async (h: string) => { const r = await o.gh("GET", `/repos/${view.repo}/compare/${base}...${h}`); if (r.status === 404 || r.status === 422) return undefined; if (r.status >= 300) throw new Error(`GitHub GET compare: ${r.status}`); return (r.body?.files ?? []) as ChangedFile[]; };
    const reviewedFiles = verdict.verdict === "pass" && verdict.kind !== "completed" && verdict.reviewed ? await reviewedChange(verdict.reviewed) : undefined;
    // The generated paths: the repo's setting, else discovery on the target branch (as the repair's plan reads them).
    const generated = s.generated?.globs ?? (await discovered(o.gh, view.repo, view.base)).globs;
    return judge(s, { files, generated, verdict, ...(reviewedFiles ? { reviewedFiles } : {}) });
  };
  return {
    /** A new pass: roles are read again. */
    begin() { roles.clear(); },
    /** One open PR that isn't the fleet's own: intake, then a round once adopted (and handed back when its task was cancelled). */
    async open(repo: string, main: { name: string; oid?: string; rollup: Json }, pr: Json, open: Set<number> = new Set([pr.number])) {
      const view = viewOf(repo, main.name, pr);
      let a = await intake(handoff, view) as Kept | undefined;
      if (!a || a.trigger.kind === "fleet") return;
      // A ship task cancelled outside a wake ends the adoption (a hold): never a close of the PR or a touch of its ref.
      if (a.task && !a.hold) {
        const w = await o.kernel.call("GET", `/v1/work?task=${encodeURIComponent(a.task)}`).catch(() => undefined);
        if (w?.status === "cancelled") { handBack(o.state, repo, pr.number, "its task was cancelled"); return; }
      }
      a = o.state.get(repo, pr.number) as Kept;
      if (a.hold || o.paused()) { await retryReport(rounds, a, view); return; }
      const v = await o.decision(repo, pr.number, view.head);
      // Waiting only on an approval: the evidence is judged, and decide's `approve` is taken where the repo's `approve` allows it.
      const s = o.settings(repo);
      const approval = v.approval && s && s.approve !== "off" && main.oid ? await approvalOf(s, view, main.oid) : undefined;
      if (s && canApprove(s, approval)) Object.assign(v, { do: "approve", why: "ready, and no approval on its head yet" });
      // Red on the base too: the same required check names (on the head or the merge_group run) red on the default branch's head.
      const onBase = new Set(namedChecks(main.rollup).filter((c) => !c.ok && !c.pending).map((c) => c.name));
      const red = [...new Set([...(v.failing ?? []), ...(v.groupFailing ?? [])])];
      await round(rounds, view, { do: v.do, ...(v.why ? { why: v.why } : {}) }, { dirty: !!v.dirty, front: front(repo, pr.number, open), queue: !!v.queue, failing: v.failing ?? [], groupFailing: v.groupFailing ?? [], onBase: red.filter((n) => onBase.has(n)), ...(approval ? { approval } : {}) });
    },
    /** The adoptions of `repo` (not the fleet's) whose PR left the open list: a merged one closes its hand-off's task once. */
    async gone(repo: string, defaultBranch: string, open: Set<number>) {
      for (const a of o.state.all() as Kept[]) {
        if (a.repo.toLowerCase() !== repo.toLowerCase() || open.has(a.number) || a.trigger.kind === "fleet" || a.counters?.lastRound === "closed" || (a.counters?.lastRound?.endsWith(":done") && !a.reportStale)) continue;
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
        await round(rounds, view, { do: "done" });
      }
    },
  };
}
