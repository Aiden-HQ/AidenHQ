// owner-channel: the one way a message reaches the owner. Agents call notify (MCP, behind the kernel's proxy); the kernel,
// the board and the runner queue theirs at the kernel, which this service takes and routes the same way. Channels
// (channel-telegram, slack) are transports the kernel sends one message to at a time. No channel token, no
// control-plane key: everything goes through the kernel with this service's own token.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pino from "pino";
import { dropQueuedNeeds, flushDigest } from "./attention.js";
import { kernelClient } from "./kernel.js";
import { buildServer } from "./mcp.js";
import { KINDS, notify, retry, sendDigest, type Deps, type Kind } from "./notify.js";
import { openStore } from "./store.js";
import { ownerViaOf, taskForNotify } from "./threads.js";
import { startWatch } from "./watch.js";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "owner-channel" }, redact: ["authorization", "*.authorization"] });
const jwks = kernelJwks();
const env = (name: string): string => {
  const file = process.env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (process.env[name] ?? "")).trim();
};
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const token = env("MCP_BEARER_TOKEN");
if (!token) throw new Error("MCP_BEARER_TOKEN(_FILE) is required");
const kernel = kernelClient(process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", token);
const store = openStore(process.env.NOTIFY_DB ?? "/data/notify.sqlite");

const d: Deps = {
  store,
  transports: list(process.env.NOTIFY_TRANSPORTS),
  send: kernel.send,
  brake: kernel.brake,
  postReply: kernel.postReply,
  wait: kernel.wait,
  fileTask: kernel.fileTask,
  noticeTask: kernel.noticeTask,
  muteFyi: process.env.NOTIFY_FYI === "mute",
  attention: {
    mode: process.env.NOTIFY_ATTENTION === "enforce" ? "enforce" : "observe",
    blocked: list(process.env.NOTIFY_BLOCKED),
    dailyCap: Number(process.env.NOTIFY_DAILY_CAP ?? 40),
    digestHours: list(process.env.NOTIFY_DIGEST_HOURS).map(Number).filter((x) => x >= 0 && x < 24),
    timezone: process.env.OWNER_TIMEZONE || "UTC",
    warn: (o, msg) => log.warn(o, msg),
  },
  // The task's live agent heads the message, and the owner's reply goes where they last wrote on it (read through the kernel).
  resolveTask: async (identifier) => {
    const issue = await kernel.read(`/api/issues/${encodeURIComponent(identifier)}`);
    const [agents, work] = await Promise.all([kernel.read(`/api/companies/${issue.companyId}/agents`), kernel.work(String(issue.id))]);
    const found = taskForNotify({ id: String(issue.id), assigneeAgentId: issue.assigneeAgentId ?? null }, work.jobs, agents);
    if (!found) return undefined;
    const commentsOf = async (id: string) => {
      const c = await kernel.read(`/api/issues/${encodeURIComponent(id)}/comments`).catch(() => []);
      return [...((Array.isArray(c) ? c : (c?.comments ?? [])) as { body: string; authorType?: string; createdAt: string }[])].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    };
    const parentId = issue.parentId ? String(issue.parentId) : undefined;
    const parentIssue = parentId ? await kernel.read(`/api/issues/${encodeURIComponent(parentId)}`).catch(() => null) : null;
    const parent = parentIssue ? { issue: parentIssue, comments: await commentsOf(parentId!) } : undefined;
    return { ...found, ownerVia: ownerViaOf(issue, await commentsOf(String(issue.id)), parent) };
  },
};

function authorized(req: IncomingMessage): boolean {
  const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const http = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return void res.writeHead(400).end(); }
  if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname !== "/mcp") return void res.writeHead(404).end();
  if (!authorized(req)) return void res.writeHead(401).end();
  if (req.method !== "POST") return void res.writeHead(405).end();
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    // Every tools/call needs the kernel's assertion of who is calling; a refusal is a tool result the agent can read.
    const msgs = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: unknown }[];
    let caller: Awaited<ReturnType<typeof verifyCaller>> | undefined;
    if (msgs.some((m) => m?.method === "tools/call")) {
      try {
        caller = await verifyCaller(req, jwks, process.env.AIDENHQ_MODULE ?? "owner-channel");
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ reason }, "tool call refused");
        const refusal = (m: { id?: unknown }) => ({ jsonrpc: "2.0", id: m?.id ?? null, result: { isError: true, content: [{ type: "text", text: `Refused: ${reason}` }] } });
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(body) ? msgs.map(refusal) : refusal(msgs[0]!)));
      }
    }
    const server = buildServer(d, caller && { id: caller.agent, name: caller.name, key: caller.key, roles: caller.roles, assertion: String(req.headers["x-aidenhq-caller"]) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log.error({ err: (err as Error).message }, "request failed");
    if (!res.headersSent) res.writeHead(500).end();
  }
});
http.listen(Number(process.env.PORT ?? 8089), "0.0.0.0", () => log.info("owner-channel listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));

// The kernel's, the board's and the runner's messages, routed like an agent's (no caller: no brake, no attention, no mirror);
// a job's reply the kernel relays goes to the channel the owner wrote from, headed by its agent and task.
// Each routed message is acknowledged (one no channel took is in notify()'s own retry store by then); one this router never
// acknowledges (it crashed, its answer was lost, notify() failed inside) the kernel hands over again.
const take = async () => {
  const done: number[] = [];
  try {
    for (const m of await kernel.take()) {
      // A connection line the old kernel queued for the digest (`batch`): acknowledged, never routed; the digest pulls what is broken now.
      if (m.batch === true) {
        if (Number.isInteger(m.id)) done.push(m.id);
        continue;
      }
      const r = await notify(d, { kind: (KINDS.includes(m.kind) ? m.kind : "alert") as Kind, text: String(m.text ?? ""), ...(m.task ? { task: String(m.task) } : {}), ...(m.dedupe_key ? { dedupe_key: String(m.dedupe_key) } : {}), ...(m.reply ? { relay: { via: m.reply.via === "slack" ? ("slack" as const) : ("telegram" as const), agentName: String(m.reply.agent), issueId: String(m.reply.issue) } } : {}), ...(m.head ? { head: { agentName: String(m.head.agent), issueId: String(m.head.issue) } } : {}), ...(m.asker ? { asker: { id: String(m.asker.id), key: String(m.asker.key), roles: Array.isArray(m.asker.roles) ? m.asker.roles.map(String) : [] } } : {}) });
      if (!r.sent) log.warn({ kind: m.kind, reason: r.reason }, "an owner message reached nobody");
      // notify() threw inside (its bare "error"): not routed, so the kernel hands it over again.
      if (Number.isInteger(m.id) && !(r.reason === "error" && !r.note)) done.push(m.id);
    }
  } catch (err) {
    log.warn({ err: String(err) }, "taking the kernel's owner messages failed");
  } finally {
    await kernel.ack(done).catch((err) => log.warn({ err: String(err) }, "acknowledging the kernel's owner messages failed"));
  }
};
setInterval(() => void take(), 10_000).unref();
void take();
setInterval(() => void retry(d).catch((err) => log.warn({ err: String(err) }, "retry failed")), 30_000).unref();
// The digest of routine crew messages: one message per slot.
dropQueuedNeeds(store);
let flushing = false; // one pass at a time: a slow multi-part send must not overlap the next tick and resend
setInterval(() => {
  if (flushing) return;
  flushing = true;
  void flushDigest(store, d.attention!, (text) => sendDigest(d, text), Date.now(), () => kernel.connectionNeeds())
    .catch(() => undefined)
    .finally(() => { flushing = false; });
}, 5 * 60_000).unref();
startWatch({ work: kernel.activity, api: (p) => kernel.read(p), store, notify: async (text, kind) => (await notify(d, { kind, text })).sent }, log);
