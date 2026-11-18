// The merge queue (one-way phase 2, W1): an approved codehost-github.merge record becomes a queue here, kept in the service's
// data dir, and a loop moves it on with the code host's merge gate (merge-gate.mjs, a copy of src/merge-gate.mjs) until every
// PR merged or the queue stopped. Its outcome is the record's: ok only when every PR the record names is merged.
//
// Every queue is strict (each named check green on the head) and bound to the heads the record carries: in our own repos (the
// agents org, the product's) the record is the review and the gate stops a PR whose head moved; elsewhere GitHub's own review
// must approve it too; and the one GitHub merge call here refuses any commit no running queue bound to that PR. A stacked PR is never replayed here (no `rebuild`): it stops, asking for a new merge. A queue whose
// PRs are all in the agents org merges each PR on its own once green (an independent queue); any other is one at a time, with
// the base branch's CI watched after each merge, and the product repo's ready PRs ride merge trains. The product and the
// official modules repos also need the reviewer-eval gate (evalGate), and nothing lands there until lands_platform_repos.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READ, WRITE, mergePermissions, ownRepo } from "./github-app.ts";
import * as gate from "./merge-gate.mjs";

type Gh = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Outcome = { ok: boolean; text: string };
export type EvalGate = (repo: string, pr: any) => Promise<undefined | { wait: string } | { stop: string }>;
type Pr = { repo: string; number: number; head: string; url: string; status: string; [k: string]: unknown };
type Queue = { state: string; prs: Pr[]; want: { repo: string; number: number }[]; said: string[]; independent?: boolean; errors?: number; outcome?: Outcome; reported?: boolean; [k: string]: unknown };
type Store = { queues: Record<string, Queue>; trains: Record<string, unknown>; reruns: Record<string, Record<string, unknown>> };

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const KEEP_MS = 7 * 24 * 3600_000;

export function createMerges(d: {
  dir: string;
  /** An installation token narrowed to `repo` and these permissions. */
  token(repo: string, perms: Record<string, string>): Promise<string>;
  gh: Gh;
  agentsOrg: string; productRepo?: string; modulesRepo?: string;
  landsPlatformRepos: boolean;
  evalGate: EvalGate;
  /** Delivers a record's outcome to the kernel (POST /v1/writes/:id/outcome). */
  report(id: string, o: Outcome): Promise<void>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => Date;
  everyMs?: number;
}) {
  const log = d.log ?? (() => {});
  const now = d.now ?? (() => new Date());
  const platform = [d.productRepo, d.modulesRepo].filter(Boolean) as string[];
  const inAgentsOrg = (repo: string) => same(repo.split("/")[0], d.agentsOrg) && !platform.some((p) => same(p, repo));
  mkdirSync(d.dir, { recursive: true });
  const file = join(d.dir, "merges.json");
  const s: Store = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { queues: {}, trains: {}, reruns: {} };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };
  const waiters = new Map<string, (o: Outcome) => void>();
  const delivering = new Set<string>();

  // ---- GitHub, with the App's narrowed tokens: the queries and writes merge-gate.mjs names, nothing else, each with the
  // runner's permissions for it (the merge's own, a re-run's Actions write, WRITE for the rest).
  const MERGE = (repo: string) => mergePermissions(repo, platform);
  const RERUN = { actions: "write" };
  const githubSays = (status: number, body: any) => `HTTP ${status}: ${String(body?.message ?? "").slice(0, 300)}`;
  async function rest(repo: string, method: string, path: string, body?: unknown, perms: Record<string, string> = READ) {
    const r = await d.gh(method, path, await d.token(repo, perms), body);
    if (r.status >= 300) throw new Error(`GitHub ${method} ${path.split("?")[0]}: ${githubSays(r.status, r.body)}`);
    return r.body;
  }
  async function graphql(repo: string, query: string, variables: Record<string, unknown>, perms: Record<string, string> = READ) {
    const r = await d.gh("POST", "/graphql", await d.token(repo, perms), { query, variables });
    if (r.status >= 300 || r.body?.errors?.length) throw new Error(`GitHub GraphQL: ${r.body?.errors?.map((e: any) => e.message).join("; ") ?? githubSays(r.status, r.body)}`);
    return r.body?.data;
  }
  async function write(repo: string, path: string, fields: Record<string, unknown>, method: string, perms: Record<string, string> = WRITE) {
    if (!gate.allowedWrite(method, path, d.agentsOrg, platform)) throw new Error(`refused GitHub write ${method} ${path}`);
    return rest(repo, method, `/${path}`, fields, perms);
  }
  /** Landing is allowed here: until lands_platform_repos, only the agents org. */
  function mayLand(repo: string) {
    if (!d.landsPlatformRepos && !inAgentsOrg(repo)) throw new Error(`codehost-github doesn't land in ${repo} yet (lands_platform_repos is off until the switch)`);
  }
  /** A commit a running queue bound to that PR (any PR of the repo, for a train's build): nothing else is ever merged. */
  function bound(repo: string, sha: string, number?: number) {
    const ok = Object.values(s.queues).some((q) => q.state === "running" && q.prs.some((p) => same(p.repo, repo) && (number === undefined || p.number === number) && p.head === sha));
    if (!ok) throw new Error(`\`${String(sha).slice(0, 12)}\` isn't a head a merge record bound for ${repo}${number ? `#${number}` : ""}`);
  }
  const owner = (repo: string) => { const [o, n] = repo.split("/"); return { owner: o, repo: n }; };
  const branchWrites = gate.branchWrites((repo: string, path: string, fields: Record<string, unknown>, method: string) => write(repo, path, fields, method, MERGE(repo)));
  const github = {
    async pr(repo: string, number: number) {
      return gate.withGate(await graphql(repo, gate.PR_QUERY, { ...owner(repo), number, pullRef: `refs/pull/${number}/head` }));
    },
    async commit(repo: string, oid: string) {
      return (await graphql(repo, gate.COMMIT_QUERY, { ...owner(repo), oid }))?.repository?.object;
    },
    async baseStatus(repo: string, base: string) {
      const r = (await graphql(repo, gate.BASE_QUERY, { ...owner(repo), ref: `refs/heads/${base}`, base }))?.repository;
      return { tip: r?.ref?.target?.oid ?? null, open: r?.heads?.nodes?.some((n: any) => n.state === "OPEN" && !n.isCrossRepository) ?? false, merged: (r?.heads?.nodes ?? []).filter((n: any) => n.state === "MERGED"), overflow: Boolean(r?.heads?.pageInfo?.hasNextPage), stacked: (r?.stacked?.totalCount ?? 0) > 0 };
    },
    async merge(repo: string, number: number, { sha, method }: { sha: string; method: string }) {
      mayLand(repo);
      bound(repo, sha, number);
      return (await write(repo, `repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha }, "PUT", MERGE(repo))).sha;
    },
    async updateBranch(repo: string, number: number, head: string) {
      await write(repo, `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT", MERGE(repo));
    },
    async retarget(repo: string, number: number, base: string) {
      await write(repo, `repos/${repo}/pulls/${number}`, { base }, "PATCH");
    },
    deleteBranch: branchWrites.deleteBranch,
    createRef: branchWrites.createRef,
    async mergeInto(repo: string, branch: string, head: string, message: string) {
      mayLand(repo);
      bound(repo, head);
      return branchWrites.mergeInto(repo, branch, head, message);
    },
    async comment(repo: string, number: number, body: string) {
      await write(repo, `repos/${repo}/issues/${number}/comments`, { body }, "POST");
    },
    async close(repo: string, number: number) {
      await write(repo, `repos/${repo}/pulls/${number}`, { state: "closed" }, "PATCH");
    },
    async markReady(id: string, repo: string) {
      await graphql(repo, gate.READY_MUTATION, { id }, WRITE);
    },
    reruns(repo: string, number: number) {
      return s.reruns[`${repo.toLowerCase()}#${number}`] ?? {};
    },
    async rerun(repo: string, number: number, { run, checks, head, whole }: { run: number; checks: { name: string; id: number }[]; head: string; whole?: boolean }) {
      await write(repo, `repos/${repo}/actions/runs/${run}/${whole ? "rerun" : "rerun-failed-jobs"}`, {}, "POST", RERUN);
      const k = `${repo.toLowerCase()}#${number}`;
      s.reruns[k] = { ...s.reruns[k], ...Object.fromEntries(checks.map((c) => [c.name, { head, id: c.id }])) };
      log("checks re-run", { repo, number, run, head });
    },
    async run(repo: string, run: number) {
      const r = await rest(repo, "GET", `/repos/${repo}/actions/runs/${run}`);
      return { status: r.status, updatedAt: r.updated_at };
    },
    async job(repo: string, check: any) {
      const run = check.checkSuite?.workflowRun?.databaseId;
      if (!run) return { steps: [], annotations: [] };
      const jobs: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const got = (await rest(repo, "GET", `/repos/${repo}/actions/runs/${run}/jobs?per_page=100&page=${page}`)).jobs ?? [];
        jobs.push(...got);
        if (got.length < 100) break;
      }
      const job = gate.jobFor(jobs, check);
      if (!job?.id) return { steps: [], annotations: [] };
      const annotations = await rest(repo, "GET", `/repos/${repo}/check-runs/${check.databaseId}/annotations`);
      return { steps: job.steps ?? [], annotations: Array.isArray(annotations) ? annotations : [] };
    },
    async codeReviewInfra(repo: string, number: number, head: string) {
      try {
        let last: string | undefined;
        for (let page = 1; page <= 10; page++) {
          const got: any[] = await rest(repo, "GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
          for (const c of got) if (c.user?.login === "github-actions[bot]" && String(c.body ?? "").startsWith(gate.CODE_REVIEW.marker)) last = c.body;
          if (got.length < 100) break;
        }
        return Boolean(last) && gate.codeReviewInfra(last, head);
      } catch {
        return false; // unknown is a real failure
      }
    },
    evalGate: (repo: string, pr: any) => d.evalGate(repo, pr),
  };
  const opts = () => ({ github, now: now(), timeoutMinutes: 90, cardIsReview: (repo: string) => ownRepo(repo, d.agentsOrg, platform), train: (repo: string) => same(repo, d.productRepo) });

  // ---- Queues and outcomes.
  /** ok only when every PR the record named merged (or was merged already); the text is what the queue said, last word last. */
  function finish(id: string, q: Queue) {
    const done = (w: { repo: string; number: number }) => q.prs.some((p) => same(p.repo, w.repo) && p.number === w.number && ["merged", "skipped"].includes(p.status));
    q.outcome = { ok: q.want.every(done), text: q.said.join("\n\n").slice(-12_000) || `the merge queue ended ${q.state}` };
    if (q.state === "running") q.state = "stopped";
    log("merges finished", { record: id, ok: q.outcome.ok, state: q.state });
    deliver(id, q);
  }
  function deliver(id: string, q: Queue) {
    const w = waiters.get(id);
    if (w) {
      waiters.delete(id);
      q.reported = true;
      return w(q.outcome!);
    }
    delivering.add(id);
    void d.report(id, q.outcome!).then(() => { q.reported = true; save(); }, (e) => log("merge outcome not delivered", { record: id, err: String(e.message ?? e) })).finally(() => delivering.delete(id));
  }

  let busy = false;
  /** One poll of every running queue (card queues together, for trains). */
  async function step() {
    if (busy) return;
    busy = true;
    try {
      const live = Object.entries(s.queues).filter(([, q]) => q.state === "running" && !q.outcome);
      if (!live.length) return;
      const o = opts();
      const store = { get: () => JSON.stringify(s.trains), set: (_k: string, v: string) => { s.trains = JSON.parse(v); } };
      const planned: Map<string, any> = await gate.advanceCards(live.map(([key, queue]) => ({ key, queue })), store, o).catch((e: Error) => (log("merge trains failed", { err: e.message }), new Map()));
      for (const [id, q] of live) {
        let st: any;
        try {
          st = planned.has(id) ? gate.unwrap(planned.get(id)) : await gate.advance(q, o);
          st.queue.errors = 0;
        } catch (e) {
          q.errors = (q.errors ?? 0) + 1;
          log("merge step failed", { record: id, errors: q.errors, err: String((e as Error).message ?? e).slice(0, 300) });
          if (q.errors >= 10) {
            q.said.push(`**Stopped the merges:** GitHub kept failing: ${String((e as Error).message ?? e).split("\n").pop()!.slice(0, 200)}.`);
            q.state = "stopped";
            finish(id, q);
          }
          continue;
        }
        const nq: Queue = st.queue;
        nq.said = [...(nq.said ?? []), ...(st.say ?? [])].slice(-30);
        // Each PR handed back (its head moved by an update, or it was retargeted) needs a new merge request at its new head.
        for (const r of st.retier ?? []) nq.said.push(`${r.url}: its head or base changed, so it wasn't merged here: ask for its merge again at its new head.`);
        s.queues[id] = nq;
        if (st.done || nq.state !== "running") finish(id, nq);
      }
    } finally {
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && !q.reported && !delivering.has(id)) deliver(id, q);
      for (const [id, q] of Object.entries(s.queues)) if (q.outcome && q.reported && Date.now() - Date.parse(String(q.finishedAt ?? q.stoppedAt ?? q.startedAt)) > KEEP_MS) delete s.queues[id];
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
        const independent = prs.every((p) => inAgentsOrg(p.repo));
        s.queues[id] = { state: "running", strict: true, gapMinutes: 0, startedAt: now().toISOString(), prs, want: prs.map(({ repo, number }) => ({ repo, number })), said: [], ...(independent ? { independent: true } : {}) };
        save();
        log("merges queued", { record: id, prs: prs.length, independent });
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
