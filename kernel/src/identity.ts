// K1 whoami: who a bearer is, from the credential alone. A control-plane run JWT or agent key (its /api/agents/me, cached 5
// minutes by the credential's hash), an agent computer's run token (the launcher's /whoami, asked every time so a revoked
// token stops at once), a runner job's token (gateway_job_secret), a module's token (its connection's service key, or its own `<module>_token`), or the
// harness key (the new-agent hello probe: no agent, no grants). What an agent may do comes from the grants table setup
// writes (config/grants/grants.json), never from control-plane metadata, which agents can edit.
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyToken } from "./gateway/token.ts";

export type Grant = { key?: string; roles?: string[]; tools?: Record<string, string[]>; trial?: boolean; jobcaps?: string[]; [k: string]: unknown };
export type Connection = { url: string; auth_secret: string; module: string; returns: "trusted" | "untrusted"; tools: { read: string[]; write: string[]; destructive: string[]; named?: string[] }; tool_timeout_s?: number;
  /** The module may make model calls billed to the caller of a tool call in flight (its manifest says so; off by default). */
  model_as_caller?: boolean };
/** A runner job's read of a connection (config/jobcaps.json): the read endpoint and its read secret, never the service key. */
export type Jobcap = { connection: string; url: string; bearer_secret: string; tools: string[]; tool_timeout_s?: number; private?: boolean };
export type Identity = {
  kind: "run" | "job" | "module";
  agent?: string; key?: string; name?: string; roles: string[];
  task?: string; run?: string; module?: string;
  /** Granted tools by connection: an agent's grants, a job's jobcaps, a module's services.grants. */
  tools: Record<string, string[]>;
  /** The write kinds a job's token names (w): what it may request at POST /v1/writes, for its agent on its task. */
  writes?: string[];
  /** A job's jobcaps by connection: where its reads go. */
  caps?: Record<string, Jobcap[]>;
  /** The credential the kernel acts with at /v1/cp/agent/* (the caller's own); never forwarded to a module. */
  credential: string;
};
export class Unknown extends Error { code = "denied_unknown_caller"; }
export class NoGrants extends Error { code = "denied_no_grants"; }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** The roles an assertion carries: the agent's own, plus kernel.trial for an agent in trial. */
export const rolesOf = (g: Grant) => [...(g.roles ?? []), ...(g.trial === true ? ["kernel.trial"] : [])];

export function createIdentity({ grants, connections, jobcaps, modules = () => ({}), secret, controlUrl, launcherUrl, runTask, now = Date.now }: {
  grants: () => Record<string, Grant>; connections: () => Record<string, Connection>; jobcaps: () => Record<string, Jobcap>;
  /** Modules with kernel roles or a token of their own (config/kernel/modules.json): a module with no connection is known by its token. */
  modules?: () => Record<string, { roles?: string[]; token?: string }>;
  secret: (name: string) => string; controlUrl?: string; launcherUrl?: string;
  /** The task a control-plane run is on (its run record), or undefined. */
  runTask?: (runId: string) => Promise<string | undefined>; now?: () => number;
}) {
  const ids = new Map<string, { at: number; id: string; name: string; run?: string; task?: string }>();
  const agent = (id: string, name: string | undefined, credential: string, extra: { run?: string; task?: string } = {}, box = false): Identity => {
    const g = grants()[id];
    if (!g) throw new NoGrants(`${name || id} has no grants`);
    // A computer reaches its connections only through here: its agent's jobcaps (reads its runner jobs hold) come with it. A
    // private one stays a job token's (observing); a computer's private reads are grants (scripts/computers.mjs privateGrants).
    const tools: Record<string, string[]> = Object.fromEntries(Object.entries(g.tools ?? {}).map(([c, t]) => [c, [...t]]));
    if (box) for (const j of g.jobcaps ?? []) { const c = jobcaps()[j]; if (c && !c.private) tools[c.connection] = [...new Set([...(tools[c.connection] ?? []), ...c.tools])]; }
    return { kind: "run", agent: id, key: String(g.key ?? ""), name: name || String(g.key ?? ""), roles: rolesOf(g), tools, credential, ...extra };
  };

  return async function whoami(token: string): Promise<Identity> {
    if (!token) throw new Unknown("no credential");
    const mod = (m: string): Identity => ({ kind: "module", module: m, roles: modules()[m]?.roles ?? [], tools: {}, credential: "" });
    for (const [, c] of Object.entries(connections())) if (same(token, secret(c.auth_secret))) return mod(c.module);
    for (const [m, d] of Object.entries(modules())) if (d.token && same(token, secret(d.token))) return mod(m);
    if (same(token, secret("gateway_harness_key"))) return { kind: "run", roles: [], tools: {}, credential: "" };
    if (token.startsWith("ahqj_")) {
      const p = verifyToken(secret("gateway_job_secret"), token, now());
      if (!p || p.k !== "agent") throw new Unknown("a job's token is invalid or expired");
      const all = jobcaps();
      const tools: Record<string, string[]> = {}, caps: Record<string, Jobcap[]> = {};
      // A private jobcap only for a job minted as observing (private_reads, web search off): private data never meets the web.
      for (const id of p.j ?? []) { const c = all[id]; if (c && (!c.private || p.o === true)) { (tools[c.connection] ??= []).push(...c.tools); (caps[c.connection] ??= []).push(c); } }
      const g = p.a ? grants()[p.a] : undefined;
      return { kind: "job", ...(p.a ? { agent: p.a } : {}), key: String(g?.key ?? ""), name: String(g?.key ?? "job"), roles: [], tools, caps, writes: p.w ?? [], credential: "", ...(p.i ? { task: p.i } : {}) };
    }
    if (token.startsWith("ahqc_")) {
      if (!launcherUrl) throw new Unknown("the computer launcher isn't configured");
      const res = await fetch(new URL("/whoami", launcherUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => { throw new Unknown(`the computer launcher is unreachable (${e.message})`); });
      if (!res.ok) throw new Unknown(`run token rejected by the computer launcher (${res.status})`);
      const j = (await res.json()) as { agentId?: unknown; runId?: unknown; issueId?: unknown };
      const id = String(j.agentId ?? "");
      if (!id) throw new NoGrants("this computer has no grants");
      return agent(id, undefined, token, { ...(typeof j.runId === "string" && j.runId ? { run: j.runId } : {}), ...(typeof j.issueId === "string" && j.issueId ? { task: j.issueId } : {}) }, true);
    }
    if (!controlUrl) throw new Unknown("the control plane isn't configured");
    const h = sha(token);
    let hit = ids.get(h);
    if (!hit || now() - hit.at > 300_000) {
      const res = await fetch(new URL("/api/agents/me", controlUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => { throw new Unknown(`the control plane is unreachable (${e.message})`); });
      if (!res.ok) throw new Unknown(`agent key rejected by the control plane (${res.status})`);
      const a = (await res.json()) as { id?: unknown; name?: unknown };
      let run: string | undefined;
      if (token.startsWith("eyJ")) { try { const r = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).run_id; if (typeof r === "string" && r) run = r; } catch {} }
      const task = run && runTask ? await runTask(run).catch(() => undefined) : undefined;
      if (ids.size > 1000) for (const [k, v] of ids) if (now() - v.at > 300_000) ids.delete(k);
      hit = { at: now(), id: String(a.id), name: String(a.name ?? ""), ...(run ? { run } : {}), ...(task ? { task } : {}) };
      ids.set(h, hit);
    }
    return agent(hit.id, hit.name, token, { ...(hit.run ? { run: hit.run } : {}), ...(hit.task ? { task: hit.task } : {}) });
  };
}
export type Whoami = ReturnType<typeof createIdentity>;
