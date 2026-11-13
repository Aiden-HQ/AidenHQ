// Run identity and grants for every shared tool: whoami(token) → {agent, grants}.
// The token is the agent's run key (X-Agent-Key; Codex sends PAPERCLIP_API_KEY). Paperclip's /api/agents/me says which
// agent it is; what that agent may do comes from the grants table setup writes on the host (config/grants/grants.json),
// never from Paperclip metadata, which agents can edit.
//
// Canonical copy: services/shared/agent-auth.ts. Each consumer holds a byte-identical copy at src/agent-auth.ts:
// edit this one, then run `node scripts/sync-shared.mjs` (scripts/test/shared.test.mjs fails on drift).
import { createHash } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage } from "node:http";

export interface Caller { id: string; key: string; name: string; roles: string[]; tools: Record<string, string[]> }
/**
 * One agent's grants-table entry. `models`, `caps` and `graded` (scripts/modules.mjs grantEntry) are for the model gateway
 * and the grader: the model ids it may call, its spend caps in USD, and whether tasks delegated to it are graded by default.
 */
export interface Grant {
  key: string;
  roles?: string[];
  tools?: Record<string, string[]>;
  models?: string[];
  caps?: { run_usd: number; task_usd: number; day_usd: number };
  graded?: boolean;
  /** The agent's config revision (setup stamps it); the model gateway puts it on each run's ledger rows. */
  rev?: string;
}

/** Who a model call is for: derived from the credential and the route, never from what the caller says. */
export type CallKind = "agent" | "advisor" | "grader" | "reviewer" | "fanout" | "source";
export interface RunIdentity {
  agentId: string | null;
  /** runKey(credential): a run cap's key. A computer's run token is per box session (launcher acquire/resume), so there it is the session. */
  runKey: string;
  issueId: string | null;
  rev: string | null;
  kind: CallKind;
}
/** The run key of a per-run credential (Paperclip run JWT, runner job token, computer run token): its sha256, hex. */
export const runKey = (credential: string) => createHash("sha256").update(credential).digest("hex");
/** A refusal, with its reason code (services/shared/reason-codes.ts GRANT_CODES): the caller is unknown unless said otherwise. */
type GrantCode = "denied_not_granted" | "denied_role" | "denied_no_grants" | "denied_unknown_caller";
class AuthError extends Error {
  code: GrantCode;
  constructor(message: string, code: GrantCode = "denied_unknown_caller") {
    super(message);
    this.code = code;
  }
}

/** The grants table, {agents: {<Paperclip agent id>: {key, roles, tools}}}, re-read whenever the file changes. */
export function grantsTable(file: string | undefined): () => Record<string, Grant> {
  let cached: { mtimeMs: number; size: number; agents: Record<string, Grant> } | undefined;
  return () => {
    if (!file) throw new AuthError("grants are not set up on this service (AIDENHQ_GRANTS_FILE)");
    let st: Stats;
    try {
      st = statSync(file);
    } catch {
      throw new AuthError("grants are not set up yet (scripts/paperclip-setup.mjs writes them)");
    }
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      let agents: unknown;
      try {
        agents = JSON.parse(readFileSync(file, "utf8")).agents;
      } catch {
        throw new AuthError("the grants table can't be read");
      }
      if (!agents || typeof agents !== "object") throw new AuthError("the grants table has no agents");
      cached = { mtimeMs: st.mtimeMs, size: st.size, agents: agents as Record<string, Grant> };
    }
    return cached.agents;
  };
}

/** A run token the computer launcher issued for one run inside an agent computer (step 5); revoked when the run ends. */
export const RUN_TOKEN_PREFIX = "ahqc_";

/**
 * whoami(token): the agent behind a Paperclip run key or agent key (cached 5 minutes), or behind a computer's run token
 * (asked of the launcher every time, so a revoked token stops at once), and its grants (always current).
 */
function makeWhoami(paperclipUrl: string | undefined, table: () => Record<string, Grant>, launcherUrl?: string) {
  const ids = new Map<string, { at: number; id: string; name: string }>();
  return async function whoami(token: string): Promise<Caller> {
    if (!token) throw new AuthError("no agent key (X-Agent-Key)");
    if (token.startsWith(RUN_TOKEN_PREFIX)) {
      if (!launcherUrl) throw new AuthError("this service doesn't know where the computer launcher is (AIDENHQ_LAUNCHER_URL)");
      const res = await fetch(new URL("/whoami", launcherUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
        throw new AuthError(`the computer launcher is unreachable (${e.message})`);
      });
      if (!res.ok) throw new AuthError(`run token rejected by the computer launcher (${res.status})`);
      const id = String(((await res.json()) as { agentId?: unknown }).agentId ?? "");
      const g = id ? table()[id] : undefined;
      if (!g) throw new AuthError(`${id || "this computer"} has no grants`, "denied_no_grants");
      return { id, key: g.key, name: g.key, roles: g.roles ?? [], tools: g.tools ?? {} };
    }
    if (!paperclipUrl) throw new AuthError("this service doesn't know where Paperclip is (PAPERCLIP_URL)");
    const h = createHash("sha256").update(token).digest("hex");
    let hit = ids.get(h);
    if (!hit || Date.now() - hit.at > 300_000) {
      const res = await fetch(new URL("/api/agents/me", paperclipUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
        throw new AuthError(`Paperclip is unreachable (${e.message})`);
      });
      if (!res.ok) throw new AuthError(`agent key rejected by Paperclip (${res.status})`);
      const a = (await res.json()) as { id?: unknown; name?: unknown };
      if (ids.size > 1000) for (const [k, v] of ids) if (Date.now() - v.at > 300_000) ids.delete(k);
      hit = { at: Date.now(), id: String(a.id), name: String(a.name ?? "") };
      ids.set(h, hit);
    }
    const g = table()[hit.id];
    if (!g) throw new AuthError(`${hit.name || hit.id} has no grants`, "denied_no_grants");
    return { id: hit.id, key: g.key, name: hit.name, roles: g.roles ?? [], tools: g.tools ?? {} };
  };
}

// The handshake and tool listing carry no identity (Codex's startup and Paperclip's hello probe have no key).
const ANON = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);

export interface AuthorizeOptions {
  connection?: string; // this connection's name, as agents' grants spell it
  paperclipUrl?: string;
  grantsFile?: string;
  launcherUrl?: string; // the computer launcher, for run tokens from agent computers
  log?: { warn(obj: object, msg: string): void };
}
export type Verdict = { ok: true; caller?: Caller } | { ok: false; status: number; body: unknown };

/**
 * authorize(req, body) for an MCP request whose bearer token already checked out: every tools/call needs a known agent
 * whose grants list that tool on this connection. Fails closed; a refusal is a tool result the agent can read.
 * Configured from AIDENHQ_CONNECTION, PAPERCLIP_URL, AIDENHQ_GRANTS_FILE and AIDENHQ_LAUNCHER_URL unless given. A missing key is refused like any
 * other: host callers (the runner) use their own endpoints and tokens, which agents never hold (/mcp/read, /mcp/publish).
 */
export function makeAuthorize(opts: AuthorizeOptions = {}) {
  const env = process.env;
  const o = { connection: env.AIDENHQ_CONNECTION, paperclipUrl: env.PAPERCLIP_URL, grantsFile: env.AIDENHQ_GRANTS_FILE, launcherUrl: env.AIDENHQ_LAUNCHER_URL, ...opts };
  const whoami = makeWhoami(o.paperclipUrl, grantsTable(o.grantsFile), o.launcherUrl);
  return async function authorize(req: IncomingMessage, body: unknown): Promise<Verdict> {
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown; params?: { name?: unknown } }[];
    if (msgs.length && msgs.every((m) => m && typeof m === "object" && ANON.has(String(m.method)))) return { ok: true };
    const tools = msgs.filter((m) => m?.method === "tools/call").map((m) => String(m.params?.name));
    const key = String(req.headers["x-agent-key"] ?? "");
    let reason: string;
    let code: GrantCode = "denied_not_granted";
    try {
      if (!o.connection) throw new AuthError("this service doesn't know its connection name (AIDENHQ_CONNECTION)");
      const caller = await whoami(key);
      const granted = caller.tools[o.connection] ?? [];
      const denied = tools.filter((t) => !granted.includes(t));
      if (!denied.length) return { ok: true, caller };
      reason = `${caller.key} isn't granted ${denied.join(", ")} on ${o.connection}`;
    } catch (err) {
      reason = (err as Error).message;
      code = err instanceof AuthError ? err.code : "denied_unknown_caller";
    }
    o.log?.warn({ connection: o.connection, tools, reason, code }, "tool call refused");
    const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason} (${code}).` }] } });
    return { ok: false, status: 200, body: Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!) };
  };
}
