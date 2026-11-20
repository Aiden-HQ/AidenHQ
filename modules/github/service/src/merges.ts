// The merge queue: an approved github.merge record becomes a queue here, kept in the service's data dir, and a loop
// polls each of its PRs with the merge gate (merge-gate.ts `decide`) until every one merged or was reported not merged. Its
// outcome is the record's: ok only when every PR it names merged at its bound head.
//
// One queue per repository: a poll merges at most one PR per repository, records in the order they were approved, so two merges
// never race on a base. A PR merges only at the head the record bound (the merge call carries that sha, so GitHub refuses any
// other), once the gate says so and, last, the reviewer-eval gate (evalgate.ts) has a verified receipt where it requires one.
// A UI head in the agents org that waits on its design review gets the UI Reviewer's task for it (design-review.ts), once per
// head, beside its checks; with no verdict in time it is asked once more, then the PR isn't merged.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namedChecks } from "./aidenhq-sdk/checks.ts";
import { waitReason, type Flow } from "./flow.ts";
import { mergeable, withTrailer } from "./git-auth.ts";
import { DESIGN_REVIEW, EVAL_WAIT_MINUTES, PR_QUERY, WAIT_MINUTES, awaitsDesignReview, decide, mergeMethod, withGate } from "./merge-gate.ts";

/** GitHub as the owner, background (git-auth.ts Gh with background set). */
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Outcome = { ok: boolean; text: string };
export type EvalGate = (repo: string, pr: any) => Promise<undefined | { wait: string } | { stop: string }>;
type Pr = { repo: string; number: number; head: string; url: string; status: string; note?: string; sha?: string; wait?: { key: string; since: string }; reviewAsked?: string; reviewAskedAgain?: string; checked?: string; unanswered?: boolean; fw?: { reason: string; since: string } };
type Queue = { state: string; prs: Pr[]; said: string[]; startedAt: string; finishedAt?: string; outcome?: Outcome; reported?: boolean };

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const KEEP_MS = 7 * 24 * 3600_000;
/** How long GitHub may keep failing on one PR before it is reported not merged. */
const ERROR_MINUTES = 30;
const says = (e: unknown) => String((e as Error)?.message ?? e).split("\n").pop()!.slice(0, 300);
/** The fixed start of a merge outcome's first line: the PRs this queue merged (finish). */
export const MERGED_LINE = "merged-prs: ";

export function createMerges(d: {
  dir: string;
  gh: Gh;
  /** Whether GitHub is connected: while it isn't, every pending PR waits (work.waiting reason github) and nothing is called. */
  connected?: () => boolean;
  fleetOrg: string; productRepo?: string;
  /** maintainer_repos ("owner/name"): merged here as in the agents org, read when each PR is polled. */
  maintained?: string[];
  evalGate: EvalGate;
  /** Flow facts (flow.ts): CI done on a head, merges, and each wait with its reason. */
  flow?: Flow;
  /** Files the design reviewer's task for a PR head the queue waits on for its verdict (design-review.ts). */
  designReview?: (ask: { repo: string; number: number; head: string; again?: boolean }) => Promise<unknown>;
  /** Delivers a record's outcome to the kernel (POST /v1/writes/:id/outcome). */
  report(id: string, o: Outcome): Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => Date;
  everyMs?: number;
}) {
  const log = d.log ?? (() => {});
  const now = d.now ?? (() => new Date());
  const platform = [d.productRepo].filter(Boolean) as string[];
  const inFleetOrg = (repo: string) => same(repo.split("/")[0], d.fleetOrg) && !platform.some((p) => same(p, repo));
  mkdirSync(d.dir, { recursive: true });
  const file = join(d.dir, "merges.json");
  const s: { queues: Record<string, Queue> } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { queues: {} };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify({ queues: s.queues })); renameSync(`${file}.tmp`, file); };
  const waiters = new Map<string, (o: Outcome) => void>();
  const delivering = new Set<string>();

  async function readPr(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const r = await d.gh("POST", "/graphql", { query: PR_QUERY, variables: { owner, repo: name, number, pullRef: `refs/pull/${number}/head` } });
    if (r.status >= 300 || r.body?.errors?.length) throw new Error(`GitHub GraphQL: ${r.body?.errors?.map((e: any) => e.message).join("; ") ?? `HTTP ${r.status}`}`);
    return withGate(r.body?.data);
  }
  async function mergePut(repo: string, number: number, sha: string, method: string, body: string): Promise<string> {
    // A squash or merge commit is the owner's, signed by the queue that made it (the rebase method keeps the PR's own commits).
    const message = method === "rebase" ? {} : { commit_message: withTrailer(body.trim(), "merge queue") };
    const r = await d.gh("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha, ...message });
    if (r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}: ${String(r.body?.message ?? "").slice(0, 300)}`), { status: r.status });
    return r.body?.sha;
  }

  /** One poll of one PR, then its wait as facts: a wait and its end (a new reason, a merge, a failure) are work.waiting and work.resumed. */
  async function pollAndTime(q: Queue, p: Pr, merged: Set<string>) {
    await poll(q, p, merged);
    timeWait(p, p.status === "pending" && p.wait ? waitReason(p.wait.key) : undefined);
  }
  function timeWait(p: Pr, reason: string | undefined) {
    if (p.fw?.reason === reason) return;
    const at = now().toISOString();
    if (p.fw) d.flow?.resumed(p.repo, p.number, p.fw.reason, p.fw.since, at);
    p.fw = reason ? { reason, since: at } : undefined;
    if (p.fw) d.flow?.waiting(p.repo, p.number, p.fw.reason, p.fw.since);
  }
  /** One poll of one PR; `merged` holds the repositories that merged a PR this poll. */
  async function poll(q: Queue, p: Pr, merged: Set<string>) {
    const t = now().getTime();
    const fail = (why: string) => {
      Object.assign(p, { status: "failed", note: why });
      delete p.wait;
      q.said.push(`**Not merged:** ${p.url}: ${why}.`);
    };
    const wait = (key: string, why: string, limit: number) => {
      if (p.wait?.key !== key) p.wait = { key, since: now().toISOString() };
      if (t - Date.parse(p.wait.since) > limit * 60_000) fail(`stuck for ${limit} minutes: ${why}`);
    };
    const askReview = async (again: boolean) => {
      if (again) p.reviewAskedAgain = p.head;
      else p.reviewAsked = p.head;
      await d.designReview?.({ repo: p.repo, number: p.number, head: p.head, ...(again ? { again } : {}) }).catch((e: Error) => log("design review task failed", { pr: p.url, err: says(e) }));
    };
    // Outside the fleet org, the product repo and maintainer_repos the code host is PR-only: it merges nothing there (a repo taken
    // off the list after its record was approved included).
    if (!mergeable(p.repo, d.fleetOrg, platform, d.maintained ?? [])) return fail(`\`${p.repo}\` is outside the fleet org, the product repo and maintainer_repos, where the code host only opens PRs: merge it there`);
    try {
      const data = await readPr(p.repo, p.number);
      const uiReview = inFleetOrg(p.repo);
      const v = decide(data, p.head, { uiReview });
      const pull = data.repository.pullRequest;
      // CI on this head is over once every named check has finished: seen here, at the first poll that finds it so.
      const named = namedChecks(pull?.commits?.nodes?.[0]?.commit?.statusCheckRollup);
      if (p.checked !== p.head && pull?.headRefOid === p.head && named.length && named.every((c) => !c.pending)) {
        p.checked = p.head;
        d.flow?.checksCompleted(p.repo, p.number, p.head, named.filter((c) => !c.ok).map((c) => c.name).slice(0, 20));
      }
      // The design reviewer is asked as soon as a UI head waits without a verdict: its review runs beside the checks.
      if (v.do === "wait" && uiReview && p.reviewAsked !== p.head && awaitsDesignReview(data.repository.pullRequest)) await askReview(false);
      if (v.do === "done") {
        // Merged after a merge call that got no answer: that call merged it.
        const ours = p.unanswered && pull?.mergeCommit?.oid;
        if (ours) Object.assign(p, { status: "merged", sha: pull.mergeCommit.oid, mergedAt: pull.mergedAt ?? now().toISOString() });
        else Object.assign(p, { status: "skipped", note: v.why });
        if (pull?.mergeCommit?.oid) d.flow?.merged(p.repo, p.number, p.head, pull.mergeCommit.oid, pull.mergedAt ?? undefined, String(pull.title ?? ""), String(pull.body ?? ""));
        delete p.wait;
        if (ours) merged.add(p.repo.toLowerCase());
        return void q.said.push(ours ? `Merged ${p.url}.` : `${p.url} was ${v.why}.`);
      }
      if (v.do === "fail") return fail(v.why);
      if (v.do === "wait") {
        // No verdict within its time: the reviewer is asked once more for the same head and the wait starts over.
        if (v.review && p.wait?.key === v.why && t - Date.parse(p.wait.since) > DESIGN_REVIEW.minutes * 60_000 && p.reviewAskedAgain !== p.head) {
          p.wait = { key: v.why, since: now().toISOString() };
          return askReview(true);
        }
        return wait(v.why, v.why, v.limit ?? WAIT_MINUTES);
      }
      const gate = await d.evalGate(p.repo, data.repository.pullRequest);
      if (gate && "stop" in gate) return fail(gate.stop);
      if (gate) return wait("eval", gate.wait, EVAL_WAIT_MINUTES);
      const method = mergeMethod(data.repository);
      if (!method) return fail(`\`${p.repo}\` allows no merge method I can use`);
      try {
        p.sha = await mergePut(p.repo, p.number, p.head, method, String(pull?.body ?? ""));
      } catch (e) {
        // Another merge to the same base a moment ago: GitHub asks to try again, which the next poll does.
        if (/try the merge again|base branch was modified/i.test(says(e))) return wait("retry", "GitHub asked to try the merge again", WAIT_MINUTES);
        // Only a 4xx is GitHub's answer. A timeout or a 5xx may have merged: the next poll reads the PR and sees which.
        const status = (e as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500) return fail(`GitHub refused the merge: ${says(e)}`);
        log("merge call unanswered", { pr: p.url, err: says(e) });
        p.unanswered = true;
        return wait("put", `GitHub didn't answer the merge call: ${says(e)}`, ERROR_MINUTES);
      }
      const mergedAt = now().toISOString();
      Object.assign(p, { status: "merged", mergedAt });
      d.flow?.merged(p.repo, p.number, p.head, String(p.sha ?? ""), mergedAt, String(pull?.title ?? ""), String(pull?.body ?? ""));
      delete p.wait;
      merged.add(p.repo.toLowerCase());
      q.said.push(`Merged ${p.url}.`);
    } catch (e) {
      log("merge poll failed", { repo: p.repo, number: p.number, err: says(e) });
      wait("error", `GitHub kept failing: ${says(e)}`, ERROR_MINUTES);
    }
  }

  /**
   * ok only when every PR the record named merged (or was merged already). The text's first line is MERGED_LINE and the PRs this
   * queue merged itself, as JSON ({ repo, number, head, sha }, an empty list when none): what readers of the record (the grading
   * module) take as merged, never the record's args. Then what the queue said, last word last.
   */
  function finish(id: string, q: Queue) {
    const ok = q.prs.every((p) => p.status === "merged" || p.status === "skipped");
    const n = q.prs.filter((p) => p.status === "merged" || p.status === "skipped").length;
    const headline = ok ? `**Done:** ${n} merged.` : `**Merges finished:** ${n} merged, ${q.prs.length - n} not.`;
    const merged = q.prs.filter((p) => p.status === "merged" && typeof p.sha === "string").map((p) => ({ repo: p.repo, number: p.number, head: p.head, sha: p.sha }));
    q.outcome = { ok, text: `${MERGED_LINE}${JSON.stringify(merged)}\n\n${[...q.said, headline].join("\n\n").slice(-12_000)}` };
    Object.assign(q, { state: ok ? "done" : "stopped", finishedAt: now().toISOString() });
    log("merges finished", { record: id, ok });
    deliver(id, q);
  }
  /**
   * The outcome to the kernel, durably: the executor's waiter (if this process ran execute) is told, and the outcome is also
   * posted here, marked reported only once the kernel took it (a repeat answers 409, which counts). Until then every poll
   * delivers it again, across restarts.
   */
  function deliver(id: string, q: Queue) {
    const w = waiters.get(id);
    if (w) {
      waiters.delete(id);
      w(q.outcome!);
    }
    delivering.add(id);
    void d.report(id, q.outcome!).then(() => { q.reported = true; save(); }, (e) => log("merge outcome not delivered", { record: id, err: says(e) })).finally(() => delivering.delete(id));
  }

  let busy = false;
  /** One poll: every pending PR of every running queue, at most one merge per repository. */
  async function step() {
    if (busy) return;
    busy = true;
    try {
      // Signed out: every pending PR waits for the reconnect (reason github; its other wait starts over), and GitHub isn't called.
      if (d.connected && !d.connected()) {
        for (const q of Object.values(s.queues)) if (q.state === "running" && !q.outcome) for (const p of q.prs) if (p.status === "pending") { delete p.wait; timeWait(p, "github"); }
        return;
      }
      const merged = new Set<string>();
      for (const [id, q] of Object.entries(s.queues)) {
        if (q.state !== "running" || q.outcome) continue;
        for (const p of q.prs) if (p.status === "pending" && !merged.has(p.repo.toLowerCase())) await pollAndTime(q, p, merged);
        if (!q.prs.some((p) => p.status === "pending")) finish(id, q);
      }
    } finally {
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported && !delivering.has(id)) deliver(id, q);
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && q.reported && Date.now() - Date.parse(String(q.finishedAt ?? q.startedAt)) > KEEP_MS) delete s.queues[id];
      save();
      busy = false;
    }
  }

  // A queue finished whose outcome never reached the kernel (a restart): delivered again.
  for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported) deliver(id, q);

  return {
    /** The approved record's queue (once per id): resolves with its outcome when the queue ends. */
    enqueue(id: string, args: { prs: { repo: string; number: number; head: string }[] }): Promise<Outcome> {
      const had = s.queues[id];
      if (had?.outcome) return Promise.resolve(had.outcome);
      if (!had) {
        const prs = args.prs.map((p) => ({ repo: p.repo, number: p.number, head: p.head, url: `https://github.com/${p.repo}/pull/${p.number}`, status: "pending" }));
        s.queues[id] = { state: "running", startedAt: now().toISOString(), prs, said: [] };
        save();
        log("merges queued", { record: id, prs: prs.length });
      }
      return new Promise((ok) => waiters.set(id, ok));
    },
    /** The record's state for the kernel (executor@1 status), or undefined when it isn't a queue here. */
    status(id: string): { state: string; text?: string } | undefined {
      const q = s.queues[id];
      if (!q) return undefined;
      return q.outcome ? { state: q.outcome.ok ? "done" : "failed", text: q.outcome.text } : { state: "running" };
    },
    step,
    /** The loop: one poll now and every `everyMs` (30 s). */
    start() {
      const t = setInterval(() => void step(), d.everyMs ?? 30_000);
      t.unref?.();
      void step();
      return () => clearInterval(t);
    },
  };
}
export type Merges = ReturnType<typeof createMerges>;
