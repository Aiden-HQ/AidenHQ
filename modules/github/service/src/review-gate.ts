// Code review's gate on the merge queue (docs/design/code-review.md "Merge gate"): for a repo code review gates (settings
// code_review: a mandatory combo, compiled into GITHUB_REVIEW_GATED), the queue asks the code-review service's verdict for the
// PR head it is about to merge, with this module's own token (code review checks it with the kernel). Anything but pass waits,
// code review unreachable (or answering 5xx) included, for as long as it lasts: no merge goes without its verdict. A repo not on
// the list never calls it, so an install without code review merges as before.

import { createHash } from "node:crypto";

/** undefined: the repo isn't gated (the head may merge); pass: code review passed this head; wait: why not yet (code review's
 * reasons (and, apart, how they unblock), or that it can't be reached; `findings`: the reasons when the only thing left is open
 * important findings, none still running or queued: the author's to fix). */
export type ReviewGate = (repo: string, number: number, head: string, live?: { base?: string; association?: string }) => Promise<undefined | { pass: true; /** the head's risk tier needs no review: it passed without one */ unreviewed?: true } | { wait: string; /** how each reason unblocks, for an agent or the merge card: ship never prints it */ unblock?: string; findings?: string; findingsKey?: string }>;

export function createReviewGate(o: { gated: string[]; url: string; key: () => string; fetchFn?: typeof fetch }): ReviewGate {
  const gated = new Set(o.gated.map((r) => r.toLowerCase()));
  const fetchFn = o.fetchFn ?? fetch;
  // The same words for every failure, so a wait reported each pass reads (and keys) the same until code review answers.
  const unreachable = () => ({ wait: "code review can't be reached: the merge waits until it answers" });
  return async (repo, number, head, live = {}) => {
    if (!gated.has(repo.toLowerCase())) return undefined;
    let r: Response;
    try {
      // The caller's live read of the PR (base branch, author association), where it has one: code review answers pending when its
      // risk tier came from other ones.
      const q = new URLSearchParams({ repo: repo.toLowerCase(), pr: String(number), head, ...(live.base ? { base: live.base } : {}), ...(live.association ? { association: live.association } : {}) });
      r = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/verdict?${q}`, { headers: { authorization: `Bearer ${o.key()}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return unreachable();
    }
    if (r.status >= 500) return unreachable();
    const v = (await r.json().catch(() => ({}))) as { verdict?: string; requires_review?: boolean; reasons?: { code?: string; text?: string; unblock?: string }[] };
    if (!r.ok) return { wait: `code review answered ${r.status}` };
    // A head whose risk tier needs no review passes too, but says so: no mandatory review covered it (productMergeEligible).
    if (v.verdict === "pass") return v.requires_review === false ? { pass: true, unreviewed: true } : { pass: true };
    const reasons = (v.reasons ?? []).map((x) => String(x.text ?? "").slice(0, 600));
    const unblock = (v.reasons ?? []).flatMap((x) => (x.unblock ? [String(x.unblock).slice(0, 300)] : [])).join("; ");
    const wait = `code review: ${reasons.join("; ") || "not passed yet"}`;
    const said = { wait, ...(unblock ? { unblock } : {}) };
    return reasons.length && (v.reasons ?? []).every((x) => x.code === "findings") ? { ...said, findings: wait, findingsKey: createHash("sha1").update(JSON.stringify(v.reasons)).digest("hex").slice(0, 12) } : said;
  };
}
