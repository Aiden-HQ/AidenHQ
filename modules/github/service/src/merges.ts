// The merge queue: an approved github.merge record becomes a queue here, kept in the service's data dir, and a loop
// polls each of its PRs with the merge gate (merge-gate.ts `decide`) until every one merged or was reported not merged. Its
// outcome is the record's: ok only when every PR it names merged at its bound head.
//
// One queue per repository: a poll merges at most one PR per repository, records in the order they were approved, so two merges
// never race on a base. A PR merges only at the head the record bound (the merge call carries that sha, so GitHub refuses any
// other), once the gate says so and, last, on a repo code review gates, code review's verdict for that head is pass
// (review-gate.ts). A review wait has no time limit: it resumes when the verdict passes, and ends only when the PR moves or
// closes. So does every other wait (running checks, a red base, mergeability, GitHub's errors): waiting is never failing, and a PR fails only on a
// terminal state (closed, head moved, red checks on the head, changes requested).
// A UI head in the agents org that waits on its design review gets the UI Reviewer's task for it (design-review.ts), once per
// head, beside its checks; with no verdict in time it is asked once more, then the design review is advisory for that head.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { namedChecks } from "./aidenhq-sdk/checks.ts";
import { waitReason, type Flow } from "./flow.ts";
import { randomUUID } from "node:crypto";
import { mergeable, trailer } from "./git-auth.ts";
import { DESIGN_REVIEW, PR_QUERY, awaitsDesignReview, decide, mergeMethod, withGate } from "./merge-gate.ts";
import type { ReviewGate } from "./review-gate.ts";

/** GitHub as the owner, background (git-auth.ts Gh with background set). */
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
/** `objects`: what the queue made, for the kernel's records (each merge commit; a merged PR stays whoever's it was). */
type Outcome = { ok: boolean; text: string; objects?: string[] };
type Pr = { repo: string; number: number; head: string; url: string; status: string; note?: string; sha?: string; wait?: { key: string; since: string }; reviewAsked?: string; reviewAskedAgain?: string; reviewExpired?: string; checked?: string; /** A 4xx refusal of a retry while an earlier unanswered call may still have merged: how many polls have looked since, for the same bound head. */ refusal?: { head: string; n: number }; /** Every merge call this poll may be looking at: each call's token (what an unanswered PUT may have made), the method it was made with, and when. Kept until the PR is settled: a retry replaces the pending call but must not forget an earlier one that landed. */ mergeCalls?: { token: string; method: string; at: string }[]; /** Code review's verdict was bypassed (unreachable too long): recorded once the merge is confirmed. */ bypass?: string; fw?: { reason: string; since: string } };
type Queue = { id: string; state: string; prs: Pr[]; said: string[]; startedAt: string; finishedAt?: string; outcome?: Outcome; reported?: boolean; /** The task the record that queued this merge is for (kernel record.task): what an already-merged PR must link to be evidence. */ task?: string; /** The same task's identifier as people read it (record.identifier, WOR-9889): the rows pr-tasks.json keeps are keyed by it, so the two are compared both ways. */ taskIdentifier?: string };

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const KEEP_MS = 7 * 24 * 3600_000;
const says = (e: unknown) => String((e as Error)?.message ?? e).split("\n").pop()!.slice(0, 300);
/** The fixed start of a merge outcome's first line: the PRs merged at their bound head, this queue's or already (finish). */
export const MERGED_LINE = "merged-prs: ";
/** What the kernel keeps of an outcome (kernel/src/records.ts OUTCOME_MAX): the first line and the summary after it must fit. */
export const OUTCOME_MAX = 6_000;

export function createMerges(d: {
  dir: string;
  gh: Gh;
  /** Whether GitHub is connected: while it isn't, every pending PR waits (work.waiting reason github) and nothing is called. */
  connected?: () => boolean;
  fleetOrg: string; productRepo?: string;
  /** maintainer_repos ("owner/name"): merged here as in the agents org, read when each PR is polled. */
  maintained?: string[];
  /** Code review's verdict for a PR head (undefined: may merge; wait: why not yet). */
  reviewGate: ReviewGate;
  /** Flow facts (flow.ts): CI done on a head, merges, and each wait with its reason. */
  flow?: Flow;
  /** Files the design reviewer's task for a PR head the queue waits on for its verdict (design-review.ts). */
  designReview?: (ask: { repo: string; number: number; head: string; again?: boolean }) => Promise<unknown>;
  /** The task that opened a PR (pr-tasks.json, pr-watch.ts notePrTask): an already-merged PR is evidence for grading only when it links to the task its merge is for. */
  taskOf?: (repo: string, n: number) => string | null;
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
  const waiters = new Map<string, { promise: Promise<Outcome>; resolve: (o: Outcome) => void }>();
  const delivering = new Set<string>();

  async function readPr(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const r = await d.gh("POST", "/graphql", { query: PR_QUERY, variables: { owner, repo: name, number, pullRef: `refs/pull/${number}/head` } });
    if (r.status >= 300 || r.body?.errors?.length) throw new Error(`GitHub GraphQL: ${r.body?.errors?.map((e: any) => e.message).join("; ") ?? `HTTP ${r.status}`}`);
    return withGate(r.body?.data);
  }
  async function mergePut(repo: string, number: number, sha: string, method: string, body: string, token: string): Promise<string> {
    // A squash or merge commit is the owner's, signed by the queue that made it (the rebase method keeps the PR's own commits).
    // The trailer goes on whatever the body says (withTrailer would keep a body's own AidenHQ trailer and drop ours), and it
    // carries this call's nonce (mergedBy).
    const message = method === "rebase" ? {} : { commit_message: [body.trim(), trailer(`merge queue ${token}`)].filter(Boolean).join("\n\n") };
    const r = await d.gh("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha, ...message });
    if (r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}: ${String(r.body?.message ?? "").slice(0, 300)}`), { status: r.status });
    return r.body?.sha;
  }
  /**
   * What this poll proves about who merged the PR: its sha only when the merge commit is the one this queue's own merge call made.
   * A rebase merge makes no commit of its own (the PR's commits land as they are), so nothing tells this queue's merge from anyone
   * else's and it is never counted as ours. A squash or merge commit carries the trailer this call put in its `commit_message`,
   * naming this record's id: an owner's or auto-merge, or a commit that merely carries an AidenHQ trailer from the PR's own
   * commits, does not. The nonce, not the whole message, is what is checked, because GitHub normalises a squash message
   * (co-author lines, whitespace, a `(#N)` suffix) and an exact match would drop a merge the queue really made. It is a random
   * id made for this one call and kept only here, never in the PR's title or body, so a PR author cannot plant it in their text
   * and have another writer's merge credited: `calls` (PUTs that went unanswered) are the only source of it.
   *
   * Every unanswered attempt is kept, not just the last: when a PUT merges but its answer is lost, a later poll may still read the PR
   * open (GitHub's read lags) and send another PUT, which replaces the pending call. If the first PUT's merge is what lands, its nonce
   * is the one in the merge commit, so any attempt's token counts (each was made by this record, at this bound head).
   */
  function mergedBy(mergeCommit: { oid?: string; message?: string } | null | undefined, sha: string, calls: { token: string; method: string }[] | undefined): string | undefined {
    if (!calls?.length) return undefined;
    const message = String(mergeCommit?.message ?? "");
    // The method each PUT was made with, not the repo's config read now: a repo whose allowed methods changed since would otherwise
    // judge (or skip) a merge that one of these calls made. A rebase merge makes no commit of its own, so it is never claimed.
    return calls.some((call) => call.method !== "rebase" && Boolean(call.token) && message.includes(call.token)) ? sha : undefined;
  }

  /**
   * The token this record's merge commit carries in its trailer (`merge queue <token>`, mergePut's commit_message): a random id
   * made for this one call, so it is unguessable from the record, the PR's title or its body, and short enough to survive
   * GitHub's normalisation of a squash message.
   */
  const mergeToken = () => `queue-${randomUUID()}`;

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
  /** A merge that went without code review's verdict (code review unreachable too long), recorded once it is confirmed. */
  const bypassed = (p: Pr) => {
    if (!p.bypass) return;
    log("merged without code review's verdict", { pr: p.url, why: p.bypass.slice(0, 300) });
    d.flow?.reviewBypassed(p.repo, p.number, p.head, p.bypass);
  };
  async function poll(q: Queue, p: Pr, merged: Set<string>) {
    const t = now().getTime();
    const fail = (why: string) => {
      Object.assign(p, { status: "failed", note: why });
      delete p.wait;
      delete p.mergeCalls;
      q.said.push(`**Not merged:** ${p.url}: ${why}.`);
    };
    const wait = (key: string) => {
      if (p.wait?.key !== key) p.wait = { key, since: now().toISOString() };
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
      let v = decide(data, p.head, { uiReview, designAdvisory: p.reviewExpired === p.head });
      const pull = data.repository.pullRequest;
      // The PR's state is read: a merge call that got no answer did not merge it unless this poll finds it merged. Every unanswered
      // call is kept across a wait (checks, review, mergeability) while the PR is still open at the bound head: a PUT that merged it
      // may only be seen as merged a few polls later, and its nonce is what proves that merge this queue's. The attempts are dropped
      // when the PR is settled (a fail clears them, a done read uses them) or GitHub answers a retry, so an owner's merge is never
      // credited.
      // CI on this head is over once every named check has finished: seen here, at the first poll that finds it so.
      const named = namedChecks(pull?.commits?.nodes?.[0]?.commit?.statusCheckRollup);
      if (p.checked !== p.head && pull?.headRefOid === p.head && named.length && named.every((c) => !c.pending)) {
        p.checked = p.head;
        d.flow?.checksCompleted(p.repo, p.number, p.head, named.filter((c) => !c.ok).map((c) => c.name).slice(0, 20));
      }
      // The design reviewer is asked as soon as a UI head waits without a verdict: its review runs beside the checks.
      if (v.do === "wait" && uiReview && p.reviewAsked !== p.head && awaitsDesignReview(data.repository.pullRequest)) await askReview(false);
      if (v.do === "done") {
        // Merged at the bound head. It is this queue's merge only when an unanswered merge call of ours is still pending and the
        // merge commit is exactly that call's (mergedBy): an owner's or GitHub auto-merge is never ours. Either way the merge
        // commit at the bound head is evidence; finish() emits it for grading when the PR links to the task the record is for.
        const sha = String(pull?.mergeCommit?.oid ?? "");
        const ours = sha ? mergedBy(pull?.mergeCommit, sha, p.mergeCalls) : undefined;
        if (sha && !ours && p.mergeCalls?.length) log("merge call unanswered, but the merge commit isn't this queue's: another writer merged it", { pr: p.url });
        if (ours) Object.assign(p, { status: "merged", sha: ours, mergedAt: pull.mergedAt ?? now().toISOString() });
        else Object.assign(p, { status: "skipped", note: v.why, ...(sha ? { sha } : {}) });
        delete p.mergeCalls;
        delete p.refusal;
        delete p.wait;
        if (sha) d.flow?.merged(p.repo, p.number, p.head, sha, pull.mergedAt ?? undefined, String(pull.title ?? ""), String(pull.body ?? ""));
        if (ours) { bypassed(p); merged.add(p.repo.toLowerCase()); }
        return void q.said.push(ours ? `Merged ${p.url}.` : `${p.url} was ${v.why}.`);
      }
      if (v.do === "wait") {
        // No verdict within its time: the reviewer is asked once more for the same head and the wait starts over.
        // Still none after that: a slow UI Reviewer is not a verdict, so its review is advisory for this head (a failure still fails).
        if (v.review && p.wait?.key === v.why && t - Date.parse(p.wait.since) > DESIGN_REVIEW.minutes * 60_000) {
          if (p.reviewAskedAgain !== p.head) {
            p.wait = { key: v.why, since: now().toISOString() };
            return askReview(true);
          }
          p.reviewExpired = p.head;
          log("design review advisory: no verdict in time", { pr: p.url });
          v = decide(data, p.head, { uiReview, designAdvisory: true });
        }
      }
      if (v.do === "fail") return fail(v.why);
      if (v.do === "wait") return wait(v.why);
      if (v.do !== "merge") return;
      const review = await d.reviewGate(p.repo, p.number, p.head);
      if (review && "bypass" in review) p.bypass = review.bypass;
      else delete p.bypass;
      if (review && "wait" in review) {
        if (p.note !== review.wait) log("merge waits for code review", { pr: p.url, why: review.wait.slice(0, 500) });
        p.note = review.wait;
        return wait("review");
      }
      const method = mergeMethod(data.repository);
      if (!method) return fail(`\`${p.repo}\` allows no merge method I can use`);
      // The token this record's merge commit will carry (mergePut's commit_message), kept before the call: a PUT that times out
      // may have merged, and the next poll tells this record's commit from anyone else's by it (mergedBy). It joins the attempts
      // (earlier unanswered calls too), so a merge the first attempt made before a retry went out is still this queue's.
      const body = String(pull?.body ?? "");
      const token = mergeToken();
      const attempt = { token, method, at: now().toISOString() };
      p.mergeCalls = [...(p.mergeCalls ?? []), attempt];
      // Persisted before the call: a restart mid-PUT must still hold the nonce that proves whether that PUT merged the PR.
      save();
      try {
        p.sha = await mergePut(p.repo, p.number, p.head, method, body, token);
      } catch (e) {
        // Another merge to the same base a moment ago: GitHub asks to try again, which the next poll does. This answer rules out
        // this attempt's commit only; an earlier PUT that went unanswered may still have landed, so its token is kept.
        if (/try the merge again|base branch was modified/i.test(says(e))) {
          p.mergeCalls = (p.mergeCalls ?? []).filter((c) => c !== attempt);
          return wait("retry");
        }
        // Only a 4xx is GitHub's answer. A timeout or a 5xx may have merged: the next poll reads the PR and sees which.
        const status = (e as { status?: number }).status ?? 0;
        if (status >= 400 && status < 500) {
          // A 4xx answers this attempt: GitHub did not merge with it. An earlier PUT that went unanswered may still have merged,
          // though, and this poll's read can lag. Drop only this attempt, read once more, and credit a commit carrying any earlier
          // call's nonce. When that read still lags, keep those nonces and look again next poll instead of failing the PR and
          // losing a merge that landed; a second refusal with still nothing to show is the end.
          const earlier = (p.mergeCalls ?? []).filter((c) => c !== attempt);
          if (earlier.length) p.mergeCalls = earlier;
          else delete p.mergeCalls;
          if (earlier.length) {
            const again = await readPr(p.repo, p.number).catch(() => undefined);
            const pr = again?.repository?.pullRequest;
            const mergedSha = String(pr?.mergeCommit?.oid ?? "");
            const ours = mergedSha && pr?.headRefOid === p.head ? mergedBy(pr.mergeCommit, mergedSha, earlier) : undefined;
            if (ours) {
              Object.assign(p, { status: "merged", sha: ours, mergedAt: pr?.mergedAt ?? now().toISOString() });
              delete p.mergeCalls;
              delete p.refusal;
              delete p.wait;
              bypassed(p);
              d.flow?.merged(p.repo, p.number, p.head, ours, pr?.mergedAt ?? undefined, String(pr?.title ?? ""), String(pr?.body ?? ""));
              merged.add(p.repo.toLowerCase());
              return void q.said.push(`Merged ${p.url}.`);
            }
            const n = p.refusal?.head === p.head ? p.refusal.n + 1 : 1;
            if (n < 2) {
              p.refusal = { head: p.head, n };
              return wait("retry");
            }
          }
          return fail(`GitHub refused the merge: ${says(e)}`);
        }
        log("merge call unanswered", { pr: p.url, err: says(e) });
        return wait("put");
      }
      const mergedAt = now().toISOString();
      Object.assign(p, { status: "merged", mergedAt });
      delete p.mergeCalls;
      delete p.refusal;
      bypassed(p);
      d.flow?.merged(p.repo, p.number, p.head, String(p.sha ?? ""), mergedAt, String(pull?.title ?? ""), String(pull?.body ?? ""));
      delete p.wait;
      merged.add(p.repo.toLowerCase());
      q.said.push(`Merged ${p.url}.`);
    } catch (e) {
      log("merge poll failed", { repo: p.repo, number: p.number, err: says(e) });
      wait("error");
    }
  }

  /**
   * ok only when every PR the record named merged (or was merged already). The text's first line is MERGED_LINE and the PRs that
   * merged at their bound head, as JSON ({ repo, number, head, sha }, an empty list when none): this queue's own merges and the
   * ones already merged when it polled them (a merge commit at the bound head, its sha), what readers of the record (the grading
   * module) take as merged, never the record's args. An already-merged PR is evidence only when it links to the task this merge is
   * for (pr-tasks.json): a matching head and merge commit prove what GitHub merged, not that it delivered this task. `objects`
   * names only the merge commits this queue made. Then what the queue said, last word last.
   */
  function finish(id: string, q: Queue) {
    const settled = (p: Pr) => p.status === "merged" || p.status === "skipped";
    const ok = q.prs.every(settled);
    const n = q.prs.filter(settled).length;
    const headline = ok ? `**Done:** ${n} merged.` : `**Merges finished:** ${n} merged, ${q.prs.length - n} not.`;
    // pr-tasks.json names the task's identifier (pr-watch.ts notePrTask: the job's workspace), the record its id: a match on
    // either is this task, and neither is another task's PR.
    const linked = (p: Pr) => {
      const row = d.taskOf?.(p.repo, p.number);
      return Boolean(row) && Boolean((q.task && row === q.task) || (q.taskIdentifier && row === q.taskIdentifier));
    };
    const evidence = (p: Pr) => settled(p) && typeof p.sha === "string" && (p.status === "merged" || linked(p));
    // The queue's own merges first, then the ones already merged at their bound head, each in the record's order.
    const merged = q.prs.filter(evidence).sort((a, b) => Number(b.status === "merged") - Number(a.status === "merged"))
      .map((p) => ({ repo: p.repo, number: p.number, head: p.head, sha: p.sha! }));
    const objects = q.prs.filter((p) => p.status === "merged" && typeof p.sha === "string").map((p) => `github:${p.repo.toLowerCase()}@${p.sha}`);
    // The first line is machine-readable and whole (the grading module reads it): the kernel keeps the outcome to OUTCOME_MAX
    // characters, cutting only the end, so the human summary after the first line is what is capped here — sized to the room the
    // kernel leaves it, never by a constant of its own that could push the line's end past the cut.
    const line = `${MERGED_LINE}${JSON.stringify(merged)}`;
    const room = OUTCOME_MAX - line.length - 2;
    // No room (a line longer than the cap on its own): keep the whole evidence line and no summary. slice(-0) is slice(0), which
    // would keep every word and push the cut back into the evidence.
    const human = room > 0 ? [...q.said, headline].join("\n\n").slice(-room) : "";
    q.outcome = { ok, text: `${line}\n\n${human}`, ...(objects.length ? { objects } : {}) };
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
      w.resolve(q.outcome!);
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
      try { save(); } finally { busy = false; }
    }
  }

  // A queue finished whose outcome never reached the kernel (a restart): delivered again.
  for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported) deliver(id, q);

  return {
    /** The approved record's queue (once per id): resolves with its outcome when the queue ends. */
    enqueue(id: string, args: { prs: { repo: string; number: number; head: string }[] }, task?: string, identifier?: string): Promise<Outcome> {
      const had = s.queues[id];
      if (had?.outcome) return Promise.resolve(had.outcome);
      if (!had) {
        const prs = args.prs.map((p) => ({ repo: p.repo, number: p.number, head: p.head, url: `https://github.com/${p.repo}/pull/${p.number}`, status: "pending" }));
        s.queues[id] = { id, state: "running", startedAt: now().toISOString(), prs, said: [], ...(task ? { task } : {}), ...(identifier ? { taskIdentifier: identifier } : {}) };
        save();
        log("merges queued", { record: id, prs: prs.length });
      }
      // The record's task (a kernel restart carries it again): the linkage an already-merged PR must show to be evidence.
      else if ((task && had.task !== task) || (identifier && had.taskIdentifier !== identifier)) {
        if (task) had.task = task;
        if (identifier) had.taskIdentifier = identifier;
        save();
      }
      // A repeat enqueue on a running queue shares the first caller's promise.
      let w = waiters.get(id);
      if (!w) {
        let resolve!: (o: Outcome) => void;
        w = { promise: new Promise<Outcome>((ok) => (resolve = ok)), resolve };
        waiters.set(id, w);
      }
      return w.promise;
    },
    /** The record's state for the kernel (executor@1 status), or undefined when it isn't a queue here. */
    status(id: string): { state: string; text?: string; objects?: string[] } | undefined {
      const q = s.queues[id];
      if (!q) return undefined;
      return q.outcome ? { state: q.outcome.ok ? "done" : "failed", text: q.outcome.text, ...(q.outcome.objects ? { objects: q.outcome.objects } : {}) } : { state: "running" };
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
