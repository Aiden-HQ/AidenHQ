// A repo review's report to Primer: a kernel write record of Primer's own kind `primer.publish` (POST /v1/writes, this module's
// token), which that kind admits from code review (its `filed_by`). Primer's executor publishes it once the AI reviewer approves
// (Tier 1): a new document private to the owner. Its outcome names the document.
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import type { Publisher, ReportOut } from "./seams.ts";
import { ROLE } from "./adapters.ts";

export const PUBLISH_KIND = "primer.publish";

type Rec = { id: string; state: string; outcome?: { ok: boolean; text: string } | null };

/**
 * A publish record's state: done with the document it made, refused, or pending. Primer's executor answers in words, not JSON:
 * "New version v<n> on Primer (document <id>, version <id>): <url>" (the report is the new private document's first version).
 */
function settled(r: Rec): ReportOut {
  if (r.state === "done" && r.outcome?.ok) {
    const text = r.outcome.text;
    const doc = /\(document ([A-Za-z0-9-]{8,64})[,)]/.exec(text)?.[1];
    const url = /https?:\/\/[^\s"')]+/.exec(text)?.[0];
    const version = /^New version v(\d+)/.exec(text)?.[1];
    if (!doc) return { state: "refused", write: r.id, why: `Primer's answer named no document: ${text.slice(0, 200)}` };
    return { state: "done", write: r.id, documentId: doc, ...(url ? { url } : {}), ...(version ? { version: Number(version) } : {}) };
  }
  if (r.state === "done" || ["failed", "rejected", "stale", "cancelled", "unknown"].includes(r.state)) return { state: "refused", write: r.id, why: `write ${r.id} ${r.state}${r.outcome?.text ? `: ${r.outcome.text.slice(0, 200)}` : ""}` };
  return { state: "pending", write: r.id };
}

export function primerPublisher(kernel: KernelClient): Publisher {
  /** A write above Tier 0 belongs to a task: a quiet one per repo (the kernel files the same source once), kept for every report of the repo. */
  const taskOf = async (repo: string) => String(((await kernel.call("POST", "/v1/tasks", { title: `Code review: report for ${repo}`, description: `${repo}\n\nCode review's repo review reports to Primer are approved here.`, role: ROLE, source: `code-review:report:${repo}`, quiet: true })) as { id: string }).id);
  return {
    async file(r) {
      const args = { title: r.title, content: r.content, format: "markdown", versionNote: r.versionNote, private: true, repo_key: r.repo };
      const rec = (await kernel.call("POST", "/v1/writes", { kind: PUBLISH_KIND, args, task: await taskOf(r.repo) })) as Rec;
      return settled(rec);
    },
    async outcome(write) {
      const rec = (await kernel.call("GET", `/v1/writes/${write}`)) as Rec;
      return settled(rec);
    },
  };
}
