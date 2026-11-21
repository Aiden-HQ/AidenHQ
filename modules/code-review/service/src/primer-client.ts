// A repo review's report to Primer: primer-mcp's internal route for code review's submissions (POST /internal/report), called
// with this module's own token, which primer-mcp checks with the kernel (whoami), as github-mcp's /internal/review does. Primer
// files its own `publish` write (Tier 1) and makes the document private to the owner; a `documentId` adds a version to the
// repo's document instead of making a new one.
import type { Publisher, ReportIn, ReportOut } from "./seams.ts";

export function primerPublisher(base: string, token: () => string, fetcher: typeof fetch = fetch): Publisher {
  return async (r: ReportIn): Promise<ReportOut> => {
    const res = await fetcher(`${base.replace(/\/+$/, "")}/internal/report`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: r.repo, title: r.title, content: r.content, ...(r.documentId ? { documentId: r.documentId } : {}), versionNote: r.versionNote }), signal: AbortSignal.timeout(120_000) });
    const j = (await res.json().catch(() => ({}))) as { documentId?: unknown; version?: unknown; url?: unknown; detail?: unknown; error?: unknown };
    if (!res.ok) throw new Error(`Primer: ${res.status} ${String(j.detail ?? j.error ?? "").slice(0, 300)}`);
    if (typeof j.documentId !== "string" || typeof j.url !== "string" || !Number.isInteger(j.version)) throw new Error("Primer's answer named no document");
    return { documentId: j.documentId, version: j.version as number, url: j.url };
  };
}
