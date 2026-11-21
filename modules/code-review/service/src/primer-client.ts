// A repo review's report to Primer: a kernel write record of Primer's own kind `primer.publish` (POST /v1/writes, this module's
// token), which that kind admits from code review (its `filed_by`). Primer's executor publishes it once the AI reviewer approves
// (Tier 1): a new document private to the owner, or a version of the repo's document (`documentId`). Its outcome names the document.
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Publisher, ReportOut } from "./seams.ts";

export const PUBLISH_KIND = "primer.publish";

type Rec = { id: string; state: string; outcome?: { ok: boolean; text: string } | null };

/** A publish record's state: done with the document it made (id, url, version), refused, or pending. */
function settled(r: Rec): ReportOut {
  if (r.state === "done" && r.outcome?.ok) {
    // Primer's executor answers in words (publish.ts): "Published on Primer: <url> (document <id>)" or "New version vN on Primer
    // (document <id>, version ...): <url>", with a note after either.
    const text = r.outcome.text;
    const doc = /\(document ([A-Za-z0-9-]+)/.exec(text)?.[1];
    const url = /https?:\/\/[^\s)]+/.exec(text)?.[0];
    const n = Number(/\bversion v(\d+)\b/i.exec(text)?.[1]);
    if (!doc) return { state: "refused", write: r.id, why: `Primer's answer named no document: ${text.slice(0, 200)}` };
    return { state: "done", write: r.id, documentId: doc, ...(url ? { url } : {}), ...(Number.isInteger(n) && n > 0 ? { version: n } : {}) };
  }
  if (r.state === "done" || ["failed", "rejected", "stale", "cancelled", "unknown"].includes(r.state)) return { state: "refused", write: r.id, why: `write ${r.id} ${r.state}${r.outcome?.text ? `: ${r.outcome.text.slice(0, 200)}` : ""}` };
  return { state: "pending", write: r.id };
}

export function primerPublisher(kernel: KernelClient): Publisher {
  return {
    async file(r) {
      const args = { title: r.title, content: r.content, format: "markdown", ...(r.documentId ? { documentId: r.documentId } : {}), versionNote: r.versionNote, private: true, repo_key: r.repo };
      return settled((await kernel.call("POST", "/v1/writes", { kind: PUBLISH_KIND, args })) as Rec);
    },
    async outcome(write) {
      return settled((await kernel.call("GET", `/v1/writes/${write}`)) as Rec);
    },
  };
}
