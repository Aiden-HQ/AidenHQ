// The merge queue: an approved codehost-github.merge record becomes a queue here, kept in the service's data dir, and a loop
// polls each of its PRs with the merge gate (merge-gate.mjs `decide`) until every one merged or was reported not merged. Its
// outcome is the record's: ok only when every PR it names merged at its bound head.
//
// One queue per repository: a poll merges at most one PR per repository, records in the order they were approved, so two merges
// never race on a base. A PR merges only at the head the record bound (the merge call carries that sha, so GitHub refuses any
// other), once the gate says so and, last, the reviewer-eval gate (evalgate.ts) has a verified receipt where it requires one.
// Until lands_platform_repos (the big switch), nothing lands outside the agents org.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READ, mergePermissions, ownRepo } from "./github-app.ts";
import { EVAL_WAIT_MINUTES, PR_QUERY, WAIT_MINUTES, decide, mergeMethod, withGate } from "./merge-gate.mjs";

type Gh = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: any }>;
type Outcome = { ok: boolean; text: string };
export type EvalGate = (repo: string, pr: any) => Promise<undefined | { wait: string } | { stop: string }>;
type Pr = { repo: string; number: number; head: string; url: string; status: string; note?: string; sha?: string; wait?: { key: string; since: string } };
type Queue = { state: string; prs: Pr[]; said: string[]; startedAt: string; finishedAt?: string; outcome?: Outcome; reported?: boolean };

const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
const KEEP_MS = 7 * 24 * 3600_000;
/** How long GitHub may keep failing on one PR before it is reported not merged. */
const ERROR_MINUTES = 30;
const says = (e: unknown) => String((e as Error)?.message ?? e).split("\n").pop()!.slice(0, 300);

export function createMerges(d: {
  dir: string;
  /** An installation token narrowed to `repo` and these permissions. */
  token(repo: string, perms: Record<string, string>): Promise<string>;
  gh: Gh;
  agentsOrg: string; productRepo?: string; modulesRepo?: string;
  evalGate: EvalGate;
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
  const platform = [d.productRepo, d.modulesRepo].filter(Boolean) as string[];
  const inAgentsOrg = (repo: string) => same(repo.split("/")[0], d.agentsOrg) && !platform.some((p) => same(p, repo));
  mkdirSync(d.dir, { recursive: true });
  const file = join(d.dir, "merges.json");
  const s: { queues: Record<string, Queue> } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { queues: {} };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify({ queues: s.queues })); renameSync(`${file}.tmp`, file); };
  const waiters = new Map<string, (o: Outcome) => void>();
  const delivering = new Set<string>();

  async function readPr(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const r = await d.gh("POST", "/graphql", await d.token(repo, READ), { query: PR_QUERY, variables: { owner, repo: name, number, pullRef: `refs/pull/${number}/head` } });
    if (r.status >= 300 || r.body?.errors?.length) throw new Error(`GitHub GraphQL: ${r.body?.errors?.map((e: any) => e.message).join("; ") ?? `HTTP ${r.status}`}`);
    return withGate(r.body?.data);
  }
  async function mergePut(repo: string, number: number, sha: string, method: string): Promise<string> {
    const r = await d.gh("PUT", `/repos/${repo}/pulls/${number}/merge`, await d.token(repo, mergePermissions(repo, platform)), { merge_method: method, sha });
    if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${String(r.body?.message ?? "").slice(0, 300)}`);
    return r.body?.sha;
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
    if (!d.landsPlatformRepos && !inAgentsOrg(p.repo)) return fail(`codehost-github doesn't land in ${p.repo} yet (lands_platform_repos is off until the switch)`);
    try {
      const data = await readPr(p.repo, p.number);
      const v = decide(data, p.head, { ownRepo: ownRepo(p.repo, d.agentsOrg, platform), uiReview: inAgentsOrg(p.repo) });
      if (v.do === "done") {
        Object.assign(p, { status: "skipped", note: v.why });
        delete p.wait;
        return void q.said.push(`${p.url} was ${v.why}.`);
      }
      if (v.do === "fail") return fail(v.why);
      if (v.do === "wait") return wait(v.why, v.why, v.limit ?? WAIT_MINUTES);
      const gate = await d.evalGate(p.repo, data.repository.pullRequest);
      if (gate && "stop" in gate) return fail(gate.stop);
      if (gate) return wait("eval", gate.wait, EVAL_WAIT_MINUTES);
      const method = mergeMethod(data.repository);
      if (!method) return fail(`\`${p.repo}\` allows no merge method I can use`);
      try {
        p.sha = await mergePut(p.repo, p.number, p.head, method);
      } catch (e) {
        // Another merge to the same base a moment ago: GitHub asks to try again, which the next poll does.
        if (/try the merge again|base branch was modified/i.test(says(e))) return wait("retry", "GitHub asked to try the merge again", WAIT_MINUTES);
        return fail(`GitHub refused the merge: ${says(e)}`);
      }
      Object.assign(p, { status: "merged", mergedAt: now().toISOString() });
      delete p.wait;
      merged.add(p.repo.toLowerCase());
      q.said.push(`Merged ${p.url}.`);
    } catch (e) {
      log("merge poll failed", { repo: p.repo, number: p.number, err: says(e) });
      wait("error", `GitHub kept failing: ${says(e)}`, ERROR_MINUTES);
    }
  }

  function finish(id: string, q: Queue) {
    const ok = q.prs.every((p) => p.status === "merged" || p.status === "skipped");
    const n = q.prs.filter((p) => p.status === "merged" || p.status === "skipped").length;
    const headline = ok ? `**Done:** ${n} merged.` : `**Merges finished:** ${n} merged, ${q.prs.length - n} not.`;
    q.outcome = { ok, text: [...q.said, headline].join("\n\n").slice(-12_000) };
    Object.assign(q, { state: ok ? "done" : "stopped", finishedAt: now().toISOString() });
    log("merges finished", { record: id, ok });
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
    void d.report(id, q.outcome!).then(() => { q.reported = true; save(); }, (e) => log("merge outcome not delivered", { record: id, err: says(e) })).finally(() => delivering.delete(id));
  }

  let busy = false;
  /** One poll: every pending PR of every running queue, at most one merge per repository. */
  async function step() {
    if (busy) return;
    busy = true;
    try {
      const merged = new Set<string>();
      for (const [id, q] of Object.entries(s.queues)) {
        if (q.state !== "running" || q.outcome) continue;
        for (const p of q.prs) if (p.status === "pending" && !merged.has(p.repo.toLowerCase())) await poll(q, p, merged);
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
