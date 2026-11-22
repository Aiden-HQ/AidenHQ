// K1 whoami: who a bearer is, from the credential alone. A kernel job's token (`ahqj_`, gateway_job_secret, kind job: its row's
// frozen authority) or a module's token (its connection's service key, or its own `<module>_token`, which alone carries the
// module's roles when it has one). Nothing else is a caller; the fast chat lane's tool calls are its module token speaking for
// one of its agents (laneCaller).
// What an agent may do comes from the kernel's records and the grants table setup writes (config/grants/grants.json), never
// from control-plane metadata, which agents can edit.
import { timingSafeEqual } from "node:crypto";
import { verifyToken } from "./gateway/token.ts";

export type Grant = { key?: string; roles?: string[]; tools?: Record<string, string[]>; trial?: boolean; jobcaps?: string[]; [k: string]: unknown };
export type Connection = { url: string; auth_secret: string; module: string; returns: "trusted" | "untrusted"; tools: { read: string[]; write: string[]; destructive: string[]; named?: string[]; unreviewed?: string[] }; tool_timeout_s?: number;
  /** The module may make model calls billed to the caller of a tool call in flight (its manifest says so; off by default). */
  model_as_caller?: boolean;
  /** The module's health probes (module.yaml `health_probes`): name -> one read tool with fixed arguments (health.ts). */
  health_probes?: Record<string, { tool: string; args?: Record<string, unknown> }> };
/** A read a job may hold on a connection (config/jobcaps.json): its tools. */
export type Jobcap = { connection: string; tools: string[] };
export type Identity = {
  kind: "run" | "module";
  agent?: string; key?: string; name?: string; roles: string[];
  task?: string; run?: string; module?: string;
  /** A module: whoever presented its own token (`<module>_token`), not a connection's key (a module's connections each hold their own). */
  own?: boolean;
  /** A kernel job's own id (a refused write is recorded on it). */
  job?: string;
  /** Granted tools by connection: a kernel job's frozen tools and jobcaps; a module's none. */
  tools: Record<string, string[]>;
  /** The write kinds a kernel job's authority names: what it may request at POST /v1/writes, for its agent on its task. */
  writes?: string[];
  /** A kernel job's workspace: its task's identifier, from its row (admission). Its writes name this one, whatever their args say. */
  workspace?: string;
  /** A kernel job's model, frozen at admission: its writes carry it, so their reviewer is never of its family. */
  model?: string;
  /** The control-plane credential the kernel acts with at /v1/cp/agent/* for this caller; never forwarded to a module. */
  credential: string;
  /**
   * A module known by a connection's service key while it has a token of its own: that connection's service host. It holds
   * none of the module's roles, and reports the outcome only of a write its own service executes.
   */
  connection?: string;
};
export class Unknown extends Error { code = "denied_unknown_caller"; }
export class NoGrants extends Error { code = "denied_no_grants"; }

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return Boolean(a && b) && x.length === y.length && timingSafeEqual(x, y);
};
/** The roles an assertion carries: the agent's own, plus kernel.trial for an agent in trial. */
export const rolesOf = (g: Grant) => [...(g.roles ?? []), ...(g.trial === true ? ["kernel.trial"] : [])];
/** An agent's roles as it holds them: its own, and a team member's team record's too (the record alone carries them for filing). */
export function heldRoles(agents: Record<string, Grant | undefined> | undefined, id: string): string[] {
  const g = agents?.[id];
  const record = typeof g?.member_of === "string" ? Object.values(agents ?? {}).find((x) => x?.key === g.member_of && x?.team) : undefined;
  return [...new Set([...(g?.roles ?? []), ...(record?.roles ?? [])])];
}

/**
 * The fast chat lane (a module holding kernel.lane) calling a tool for one of its agents, named by id: that agent's lane tools
 * (`chat_tools`, within its grants), roles and chat task from the grants table, never the request's say-so. An agent without a chat task has no lane. It carries
 * no job, so nothing only a job may do (memory, settings, waits, model calls billed to a run) is open to it.
 */
export function laneCaller(mod: Identity, agent: string, agents: Record<string, Grant>): Identity {
  if (mod.kind !== "module" || !mod.roles.includes("kernel.lane")) throw new Unknown("only the fast chat lane (role kernel.lane) calls as one of its agents");
  const g = Object.hasOwn(agents, agent) ? agents[agent] : undefined;
  if (!g?.key || typeof g.chat_task !== "string" || !g.chat_task) throw new NoGrants(`agent ${agent.slice(0, 60)} has no fast chat lane`);
  const tools: Record<string, string[]> = {};
  for (const ct of Array.isArray(g.chat_tools) ? g.chat_tools : []) {
    const [c = "", t = ""] = String(ct).split(".");
    if (g.tools?.[c]?.includes(t)) tools[c] = [...(tools[c] ?? []), t];
  }
  return { kind: "run", agent, key: g.key, name: g.key, roles: rolesOf(g), tools, task: g.chat_task, credential: "" };
}

/** A kernel-admitted job as its row says (admission.ts): who, on what, and the authority frozen when it was admitted. */
export type AdmittedJob = { agent: string; task: string; state: string; identifier: string; authority: { tools: Record<string, string[]>; jobcaps: string[]; writes: string[]; roles: string[]; model?: string } };

export function createIdentity({ grants, connections, jobcaps, modules = () => ({}), secret, job = () => undefined, now = Date.now }: {
  grants: () => Record<string, Grant>; connections: () => Record<string, Connection>; jobcaps: () => Record<string, Jobcap>;
  /** A kernel-admitted job by id (its row): a job token's authority is read here, never from the grants table again. */
  job?: (id: string) => AdmittedJob | undefined;
  /** Modules with kernel roles or a token of their own (config/kernel/modules.json): a module with no connection is known by its token. */
  modules?: () => Record<string, { roles?: string[]; token?: string }>;
  secret: (name: string) => string; now?: () => number;
}) {
  return async function whoami(token: string): Promise<Identity> {
    if (!token) throw new Unknown("no credential");
    const mod = (m: string, own = false): Identity => ({ kind: "module", module: m, roles: modules()[m]?.roles ?? [], tools: {}, credential: "", ...(own ? { own } : {}) });
    // A module with a token of its own holds its roles, and speaks as itself, by that token alone: its connections' service key (a
    // server that reads untrusted text, github-mcp beside the github module's code host, slack-mcp beside the Slack channel) is the
    // module with no role.
    for (const [, c] of Object.entries(connections())) if (same(token, secret(c.auth_secret))) return modules()[c.module]?.token ? { ...mod(c.module), roles: [], connection: new URL(c.url).hostname } : mod(c.module);
    for (const [m, d] of Object.entries(modules())) if (d.token && same(token, secret(d.token))) return mod(m, true);
    if (token.startsWith("ahqj_")) {
      const p = verifyToken(secret("gateway_job_secret"), token, now());
      if (p?.k === "job") {
        // A kernel job: exactly what was frozen at its admission, on its own task, while it lives.
        const j = job(String(p.id));
        if (!j || j.agent !== p.a || j.task !== p.i || !["admitted", "running"].includes(j.state)) throw new Unknown("this job has ended");
        const tools: Record<string, string[]> = Object.fromEntries(Object.entries(j.authority.tools).map(([c, t]) => [c, [...t]]));
        // Every jobcap it was granted adds its reads.
        for (const id of j.authority.jobcaps) { const c = jobcaps()[id]; if (c) tools[c.connection] = [...new Set([...(tools[c.connection] ?? []), ...c.tools])]; }
        const g = grants()[j.agent];
        return { kind: "run", agent: j.agent, key: String(g?.key ?? ""), name: String(g?.key ?? ""), roles: [...j.authority.roles], tools, writes: [...j.authority.writes], task: j.task, job: String(p.id), workspace: j.identifier, ...(j.authority.model ? { model: j.authority.model } : {}), credential: "" };
      }
      throw new Unknown("a job's token is invalid or expired");
    }
    throw new Unknown("not a credential the kernel knows");
  };
}
export type Whoami = ReturnType<typeof createIdentity>;
