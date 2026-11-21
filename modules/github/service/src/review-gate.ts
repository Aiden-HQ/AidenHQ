// Code review's gate on the merge queue (docs/design/code-review.md "Merge gate"): for a repo code review gates (settings
// code_review: a mandatory combo, compiled into GITHUB_REVIEW_GATED), the queue asks the code-review service's verdict for the
// PR head it is about to merge, with this module's own token (code review checks it with the kernel). Anything but pass waits, the service unreachable
// included; a repo not on the list never calls it, so an install without code review merges as before.

/** undefined: the head may merge; wait: why not yet (code review's reasons, each with how it unblocks). */
export type ReviewGate = (repo: string, number: number, head: string) => Promise<undefined | { wait: string }>;

export function createReviewGate(o: { gated: string[]; url: string; key: () => string; fetchFn?: typeof fetch }): ReviewGate {
  const gated = new Set(o.gated.map((r) => r.toLowerCase()));
  const fetchFn = o.fetchFn ?? fetch;
  return async (repo, number, head) => {
    if (!gated.has(repo.toLowerCase())) return undefined;
    try {
      const q = new URLSearchParams({ repo: repo.toLowerCase(), pr: String(number), head });
      const r = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/verdict?${q}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(15_000) });
      const v = (await r.json().catch(() => ({}))) as { verdict?: string; reasons?: { text?: string; unblock?: string }[] };
      if (!r.ok) return { wait: `code review answered ${r.status}` };
      if (v.verdict === "pass") return undefined;
      const reasons = (v.reasons ?? []).map((x) => `${String(x.text ?? "").slice(0, 600)}${x.unblock ? ` (${String(x.unblock).slice(0, 300)})` : ""}`);
      return { wait: `code review: ${reasons.join("; ") || "not passed yet"}` };
    } catch (e) {
      return { wait: `code review is unreachable (${String((e as Error).message).slice(0, 200)})` };
    }
  };
}
