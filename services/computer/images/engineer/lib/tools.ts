// The one MCP client a job's computer has (code mode: docs/superpowers/specs/2026-11-25-session-code-mode-design.md). A
// session's generated tool files (<state>/aidenhq-tools/) and the in-box `aidenhq` CLI call connections through it, as the job:
// POST $AIDENHQ_GATEWAY_URL/c/<connection>/mcp with X-Agent-Key: $AIDENHQ_RUN_TOKEN, which the launcher checks and passes on to
// the kernel's tool proxy. The proxy decides every call (grants, fencing, tiers, write records); nothing is decided here.
// The kernel lists a job's tools at launch with the same client (`mcp`), straight to its own proxy with the job token as bearer.
//
// A call is sent once and never replayed: a timeout, an oversized result or a needs-owner answer can all mean a write happened.
// Copied into the engineer image as /opt/aidenhq/lib/tools.ts (scripts/sync-shared.ts); Node runs it with type stripping, so it
// uses erasable TypeScript only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What a tool call resolves to: its text blocks as the proxy sent them (fenced for an untrusted connection), its images saved as files. */
export interface ToolResult { text: string; images: string[]; structured?: unknown }

/** The proxy's refusals: the tool isn't this job's to call. */
const REFUSALS = ["tool-unlisted", "no-grant", "method-refused"];

/** A call that didn't succeed: refused by the proxy, an error from the tool, or a transport failure. `record`: the write's record, when one was filed. */
export class ToolError extends Error {
  connection: string;
  tool: string;
  code: string;
  /** What went wrong, in the proxy's or the tool's own words (the message prefixed with the tool and code). */
  detail: string;
  record?: string;
  constructor(connection: string, tool: string, code: string, detail: string, record?: string) {
    super(`${connection}.${tool}: ${code}: ${detail}`);
    this.name = "ToolError";
    this.connection = connection;
    this.tool = tool;
    this.code = code;
    this.detail = detail;
    if (record) this.record = record;
  }
}

/** A write that has not happened yet: its record waits on the AI reviewer (tier 1) or the owner (tier 2); the outcome lands on the task. */
export class ToolPending extends Error {
  connection: string;
  tool: string;
  record: string;
  tier: number;
  state: string;
  constructor(connection: string, tool: string, record: string, tier: number, state: string) {
    super(`${connection}.${tool}: write ${record} is waiting on ${tier === 1 ? "the AI reviewer" : "the owner"} (${state}); it has not happened, and its outcome lands on your task`);
    this.name = "ToolPending";
    this.connection = connection;
    this.tool = tool;
    this.record = record;
    this.tier = tier;
    this.state = state;
  }
}

type Message = { id?: unknown; result?: any; error?: { code?: number; message?: string } };
/** One JSON-RPC answer: the message with this request's id, and the record id the proxy marks a pending write with. */
export interface Answer { message: Message; pending?: string }

const PROTOCOL = "2025-06-18";

/** The JSON-RPC messages of an answer: one JSON object, or SSE events, each one's data lines joined (a message may span several). */
function messages(text: string, sse: boolean): Message[] {
  const raw = sse ? text.split(/\r\n\r\n|\n\n|\r\r/).map((ev) => ev.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(l.startsWith("data: ") ? 6 : 5)).join("\n")).filter((d) => d.trim()) : [text];
  return raw.flatMap((m) => { try { const v = JSON.parse(m); return v && typeof v === "object" && !Array.isArray(v) ? [v as Message] : []; } catch { return []; } });
}

/**
 * An MCP client over HTTP: `url(connection)` is each connection's endpoint, `headers` the caller's credential. Each connection
 * gets one session per process (initialize once, its mcp-session-id kept), then requests on it. A transport failure throws
 * ToolError (401: the job ended; a status; a timeout), named by `tool` (the tool called, or the method).
 */
export function mcp({ url, headers }: { url: (connection: string) => string; headers: Record<string, string> }) {
  type Session = { id?: string; protocol: string };
  const sessions = new Map<string, Promise<Session>>();
  let ids = 0;
  const failed = (connection: string, tool: string, e: unknown) => {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") return new ToolError(connection, tool, "timeout", "no answer in time; the call is never sent again (a write may have happened)");
    return new ToolError(connection, tool, "transport", `the gateway didn't answer (${err.message})`);
  };
  async function post(connection: string, tool: string, body: Record<string, unknown>, session: Session | undefined, signal: AbortSignal) {
    let res: Response, text: string;
    try {
      // A redirect is refused, never followed: the credential header stays with the gateway.
      res = await fetch(url(connection), {
        method: "POST", signal, redirect: "error",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": session?.protocol ?? PROTOCOL, ...(session?.id ? { "mcp-session-id": session.id } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      });
      // The deadline holds while the body is read too: a stalled answer is a timeout, never an empty one.
      text = await res.text();
    } catch (e) {
      throw failed(connection, tool, e);
    }
    if (res.status === 401) throw new ToolError(connection, tool, "job-ended", "the job's token was refused: the job has ended");
    // A session the connection no longer knows (404 on its id) goes: the next call starts a new one. This call is not sent again.
    if (res.status === 404 && session?.id) sessions.delete(connection);
    if (!res.ok && res.status !== 202) throw new ToolError(connection, tool, "transport", `the gateway answered ${res.status}: ${text.slice(0, 500)}`);
    return { res, text };
  }
  function session(connection: string, signal: AbortSignal) {
    let s = sessions.get(connection);
    if (!s) {
      s = (async () => {
        const init = ++ids;
        const { res, text } = await post(connection, "initialize", { id: init, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "aidenhq-tools", version: "1" } } }, undefined, signal);
        // The version the connection chose is the session's: every later request carries it.
        const chosen = messages(text, String(res.headers.get("content-type") ?? "").includes("text/event-stream")).find((m) => m.id === init)?.result?.protocolVersion;
        const s: Session = { protocol: typeof chosen === "string" && chosen ? chosen : PROTOCOL, ...(res.headers.get("mcp-session-id") ? { id: res.headers.get("mcp-session-id")! } : {}) };
        await post(connection, "initialize", { method: "notifications/initialized" }, s, signal);
        return s;
      })();
      sessions.set(connection, s);
      s.catch(() => sessions.delete(connection));
    }
    return s;
  }
  /** One request on the connection's session: its answer, or ToolError when none came. */
  async function request(connection: string, method: string, params: Record<string, unknown>, { signal, tool = method }: { signal: AbortSignal; tool?: string }): Promise<Answer> {
    const sid = await session(connection, signal);
    const id = ++ids;
    const { res, text } = await post(connection, tool, { id, method, params }, sid, signal);
    const message = messages(text, String(res.headers.get("content-type") ?? "").includes("text/event-stream")).find((m) => m.id === id);
    if (!message) throw new ToolError(connection, tool, "transport", "the connection sent no answer");
    const pending = res.headers.get("x-aidenhq-pending") ?? undefined;
    return { message, ...(pending ? { pending } : {}) };
  }
  return { request };
}

const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set: tools are called from inside a job's computer`); })();
let box: ReturnType<typeof mcp> | undefined;
/** The job's own client: the gateway and run token from the box's environment. */
const client = () => (box ??= mcp({ url: (c) => new URL(`/c/${encodeURIComponent(c)}/mcp`, env("AIDENHQ_GATEWAY_URL")).href, headers: { "x-agent-key": env("AIDENHQ_RUN_TOKEN") } }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a Tier 0 write still running is waited for before its record id is handed back. */
const WRITE_WAIT_MS = 10 * 60_000;

/** A write record as its job reads it (GET /v1/writes/<id>): its outcome fenced by the kernel as the live answer would be. */
async function record(connection: string, tool: string, id: string) {
  const res = await fetch(new URL(`/v1/writes/${encodeURIComponent(id)}`, env("AIDENHQ_GATEWAY_URL")), { redirect: "error", headers: { authorization: `Bearer ${env("AIDENHQ_RUN_TOKEN")}` }, signal: AbortSignal.timeout(60_000) })
    .catch((e: Error) => { throw new ToolError(connection, tool, "transport", `the gateway didn't answer reading write ${id} (${e.message})`, id); });
  if (!res.ok) throw new ToolError(connection, tool, "transport", `reading write ${id} answered ${res.status}`, id);
  return (await res.json()) as { tier: number; state: string; outcome?: { ok: boolean; text: string } | null; reason?: string };
}

/** A write the proxy marked pending: waiting on a decision throws ToolPending; a Tier 0 write still running is waited for. */
async function settle(connection: string, tool: string, id: string): Promise<ToolResult> {
  for (const until = Date.now() + WRITE_WAIT_MS; ;) {
    const r = await record(connection, tool, id);
    if (r.tier > 0 && (r.state === "review" || r.state === "owner" || r.state === "approved")) throw new ToolPending(connection, tool, id, r.tier, r.state);
    if (r.state === "done") return { text: r.outcome?.text ?? "", images: [] };
    if (r.state !== "approved" && r.state !== "claimed") throw new ToolError(connection, tool, r.state, r.outcome?.text ?? r.reason ?? `the write ended ${r.state}`, id);
    if (Date.now() > until) throw new ToolError(connection, tool, "timeout", `write ${id} is still running after ${WRITE_WAIT_MS / 60_000} minutes. It is never sent again: don't repeat the call; its record id is ${id}`, id);
    await sleep(1000);
  }
}

/** Image blocks saved as files under the temp folder: their paths. */
function saveImages(content: { type?: string; data?: unknown; mimeType?: unknown }[]) {
  const images = content.filter((c) => c?.type === "image" && typeof c.data === "string");
  if (!images.length) return [];
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-tool-"));
  return images.map((c, i) => {
    const file = join(dir, `image-${i + 1}.${String(c.mimeType ?? "image/png").split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png"}`);
    writeFileSync(file, Buffer.from(c.data as string, "base64"));
    return file;
  });
}

/**
 * One tool of a connection, called once as this job. Resolves to its text and images; throws ToolError (a refusal, the tool's
 * own error, a transport failure) or ToolPending (a write waiting on a decision). `timeoutS`: the connection's tool timeout + 30.
 */
export async function call(connection: string, tool: string, args: unknown = {}, { timeoutS = 330 }: { timeoutS?: number } = {}): Promise<ToolResult> {
  const { message: m, pending } = await client().request(connection, "tools/call", { name: tool, arguments: args ?? {} }, { signal: AbortSignal.timeout(timeoutS * 1000), tool });
  if (pending) return settle(connection, tool, pending);
  if (m.error) {
    const msg = String(m.error.message ?? "");
    if (REFUSALS.includes(msg)) throw new ToolError(connection, tool, msg, "the kernel's proxy refused this call: it decides each call by this job's grants, so this tool isn't yours to call now");
    throw new ToolError(connection, tool, "tool-error", msg);
  }
  const content = Array.isArray(m.result?.content) ? m.result.content : [];
  const text = content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: unknown }) => String(c.text ?? "")).join("\n");
  if (m.result?.isError) throw new ToolError(connection, tool, "tool-error", text || "the tool reported an error");
  return { text, images: saveImages(content), ...(m.result?.structuredContent !== undefined ? { structured: m.result.structuredContent } : {}) };
}
