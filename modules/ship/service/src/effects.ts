// The hand-off's effects ship makes with its own token: the report comment through the code host's comment op (the kernel's
// POST /v1/codehost/comment, grant `codehost.comment` in module.yaml), and code review's ask for a fork (its POST /reviews, which
// admits ship's module token for a one-off review whose summary lands on the adoption's task, and for a gating fresh review of a
// head), and code review's verdict (GET /v1/verdict, the same token).
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Verdict } from "./safe.ts";

export function shipEffects(kernel: Pick<KernelClient, "call">, o: { codeReview: string; key: () => string; fetchFn?: typeof fetch }) {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async comment(repo: string, number: number, body: string, id?: number): Promise<number> {
      const r = await kernel.call("POST", "/v1/codehost/comment", { repo, number, body, ...(id ? { id } : {}) });
      return Number(r.id);
    },
    /** Code review's verdict at the head, with what it stands on (approval evidence). */
    async verdict(repo: string, number: number, head: string): Promise<Verdict> {
      const r = await fetchFn(`${o.codeReview.replace(/\/+$/, "")}/v1/verdict?${new URLSearchParams({ repo, pr: String(number), head })}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`code review answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<Verdict>;
    },
    /** A gating review of the PR's head (a writer's `aiden review`): a model fix the last review doesn't carry to. */
    async askFresh(url: string, head: string): Promise<void> {
      const r = await fetchFn(`${o.codeReview.replace(/\/+$/, "")}/reviews`, { method: "POST", headers: { authorization: `Bearer ${o.key()}`, "content-type": "application/json" }, body: JSON.stringify({ pr_url: url, fresh: true, head }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`code review answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
    async askReview(url: string, task: string): Promise<void> {
      const r = await fetchFn(`${o.codeReview.replace(/\/+$/, "")}/reviews`, { method: "POST", headers: { authorization: `Bearer ${o.key()}`, "content-type": "application/json" }, body: JSON.stringify({ pr_url: url, task }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`code review answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  };
}
