// The hand-off's effects ship makes with its own token: the report comment through the code host's comment op (the kernel's
// POST /v1/codehost/comment, grant `codehost.comment` in module.yaml), and code review's ask for a fork (its POST /reviews, which
// admits ship's module token for a one-off review whose summary lands on the adoption's task).
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";

export function shipEffects(kernel: Pick<KernelClient, "call">, o: { codeReview: string; key: () => string; fetchFn?: typeof fetch }) {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async comment(repo: string, number: number, body: string, id?: number): Promise<number> {
      const r = await kernel.call("POST", "/v1/codehost/comment", { repo, number, body, ...(id ? { id } : {}) });
      return Number(r.id);
    },
    async askReview(url: string, task: string): Promise<void> {
      const r = await fetchFn(`${o.codeReview.replace(/\/+$/, "")}/reviews`, { method: "POST", headers: { authorization: `Bearer ${o.key()}`, "content-type": "application/json" }, body: JSON.stringify({ pr_url: url, task }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`code review answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  };
}
