// An App Auditor (the app_auditor_url setting) through its MCP server, as code: a vibe audit of each app repo when it is
// new to us and weekly after (the auditor diffs against its prior audit by itself), its findings into src_security
// (tool app-auditor, target app:<name>). Off unless the URL and the Cloudflare Access service token files are set.
//
// The token can read every team's audit reports, so it stays in this service: no agent ever holds it, and only
// start_vibe_audit, get_job_status and get_findings are called. At most one new job per pass (the auditor's MCP cap is
// 2 jobs, shared with people's /audit runs). Full audits (/audit, with a questionnaire) stay the owner's call.
// Tool shapes are from the auditor's source (mcp_server/server.py, jobs.py); not yet probed live.
import { capText, type Row, type SourceStore } from "@aidenhq/sdk/source-store";
import { findingId, FINDING, Skip } from "./scan.js";

export interface AuditorConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}
export type CallAuditor = (tool: string, args: Record<string, unknown>) => Promise<any>;

/** One stateless JSON-RPC tools/call (the server is FastMCP stateless_http + json_response). */
export function auditorClient(cfg: AuditorConfig): CallAuditor {
  let id = 0;
  return async (tool, args) => {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
        "cf-access-client-id": cfg.clientId, "cf-access-client-secret": cfg.clientSecret,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`App Auditor ${tool}: HTTP ${res.status} ${text.slice(0, 200)}`);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Error(`App Auditor ${tool}: not JSON (${text.slice(0, 120)}): is the Access token right?`);
    }
    if (msg.error) throw new Error(`App Auditor ${tool}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    const r = msg.result ?? {};
    const body = r.structuredContent?.result ?? r.structuredContent ?? (() => { try { return JSON.parse(r.content?.[0]?.text ?? ""); } catch { return { text: r.content?.[0]?.text }; } })();
    if (r.isError) throw new Skip(`App Auditor ${tool}: ${String(r.content?.[0]?.text ?? JSON.stringify(body)).slice(0, 300)}`);
    return body;
  };
}

const SEV: Record<string, string> = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
const WEEK = 7 * 86_400_000;

/** App Auditor findings of one completed job as src_security rows. version is empty so a finding keeps its key across runs. */
export function auditorRows(app: string, findings: any[]): Row[] {
  const target = `app:${app}`;
  return findings.filter((f) => f?.id).map((f) => {
    const pkg = String(f.component || "(app)");
    const vuln = `app-auditor:${f.id}`;
    const text = [f.description, f.impact && `Impact: ${f.impact}`, f.remediation && `Remediation: ${f.remediation}`].filter(Boolean).join("\n\n");
    return {
      target, package: pkg, version: "", vuln_id: vuln, finding_id: findingId(target, pkg, "", vuln), target_kind: "app", tool: "app-auditor",
      locations: f.location ? [String(f.location)] : [], severity: SEV[f.severity] ?? "unknown", title: capText(f.title ?? null, 300).text,
      description: capText(text || null, 2000).text, present: true, resolved_at: null,
    };
  });
}

/**
 * One App Auditor step per app: collect a finished job, else start one when the app was never audited or its last audit
 * is a week old (at most one start per pass). State per repo in scope `auditor:<owner/repo>`: {job} running, {done} or
 * {failed} (ms). Apps sharing a repo are audited once, under the first app's name.
 */
export async function auditorPass(store: SourceStore, call: CallAuditor, apps: { name: string; repo: string }[], now = Date.now()): Promise<number> {
  let written = 0;
  let started = false;
  const byRepo = new Map<string, { name: string; repo: string }>();
  for (const a of apps) if (!byRepo.has(a.repo)) byRepo.set(a.repo, a);
  for (const app of byRepo.values()) {
    const scope = `auditor:${app.repo}`;
    const st = JSON.parse((await store.scope(scope)).cursor ?? "{}") as { job?: string; done?: number; failed?: number };
    try {
      written += await store.run("app-auditor", `app:${app.name}`, async () => {
        if (st.job) {
          const s = await call("get_job_status", { job_id: st.job });
          if (s.status === "completed") {
            const f = await call("get_findings", { job_id: st.job, min_severity: "P3" });
            let n = 0;
            // Upserts only: a delta audit may not list what it didn't re-check, so nothing is resolved from here.
            for (const r of auditorRows(app.name, f.findings ?? [])) if ((await store.upsert(FINDING, r, { baseline: false })) !== "same") n++;
            await store.saveScope(scope, JSON.stringify({ done: now }), true);
            return n;
          }
          if (["failed", "cancelled"].includes(s.status)) {
            await store.saveScope(scope, JSON.stringify({ failed: now }), true);
            throw new Skip(`App Auditor job ${st.job} for ${app.repo} ${s.status}: ${String(s.error ?? "").slice(0, 300)}`);
          }
          return 0; // queued, intake or running
        }
        const last = Math.max(st.done ?? 0, st.failed ?? 0);
        if (started || now - last < WEEK) return 0;
        started = true;
        const j = await call("start_vibe_audit", { git_url: `https://github.com/${app.repo}`, mode: "auto" });
        if (!j?.job_id) throw new Skip(`App Auditor start for ${app.repo} returned no job_id`);
        await store.saveScope(scope, JSON.stringify({ job: String(j.job_id) }), true);
        return 0;
      });
    } catch (err) {
      if (!(err instanceof Skip)) throw err;
    }
  }
  return written;
}
