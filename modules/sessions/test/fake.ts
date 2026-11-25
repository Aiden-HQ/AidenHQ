// A fake kernel for the sessions tests: the event log, the wake inbox, the code host's PR read and the control plane's task read.
import { KernelError } from "../service/src/aidenhq-sdk/kernel-client.ts";

type Ev = { seq: number; id: string; kind: string; resource: string; url?: string; data: Record<string, unknown> };
export function fakeKernel() {
  const k = {
    log: [] as Ev[], wakes: [] as { task: string; text: string; id: string }[], seen: new Set<string>(), prs: new Map<string, { state: string; mergedAt?: string; sha?: string }>(),
    closedTasks: new Set<string>(), unwatched: new Set<string>(), gap: false,
    async call(method: string, path: string, body?: any) {
      if (path.startsWith("/v1/events/log")) {
        const after = new URL(path, "http://k").searchParams.get("after");
        const end = Math.max(0, ...k.log.map((e) => e.seq));
        return after === null ? { events: [], next: end, gap: false } : { events: k.log.filter((e) => e.seq > Number(after)), next: end, gap: k.gap };
      }
      if (path === "/v1/wakes") {
        k.wakes.push(body);
        if (k.closedTasks.has(body.task)) return { posted: false, closed: true };
        if (k.seen.has(body.id)) return { posted: true, duplicate: true };
        k.seen.add(body.id);
        return { posted: true };
      }
      if (path === "/v1/codehost/read") {
        if (k.unwatched.has(body.repo)) throw new KernelError(403, "kernel POST /v1/codehost/read → 403: no read grant");
        const pr = k.prs.get(`${body.repo}#${body.number}`);
        return { repository: { feedWatched: true, pullRequest: pr ? { state: pr.state, mergedAt: pr.mergedAt ?? null, url: `https://github.com/${body.repo}/pull/${body.number}`, mergeCommit: pr.sha ? { oid: pr.sha } : null } : null } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async read(path: string) { return { status: k.closedTasks.has(decodeURIComponent(path.split("/").pop()!)) ? "done" : "in_progress" }; },
  };
  return k;
}
export const merged = (seq: number, repo: string, number: number, sha = "abc1234"): Ev => ({ seq, id: `${repo}#${number}:closed:2026-11-25T10:00:00Z`, kind: "pull_request.closed", resource: repo, url: `https://github.com/${repo}/pull/${number}`, data: { number, merged: true, merge_sha: sha, closed_at: new Date(Date.now() + 60_000).toISOString() } });
