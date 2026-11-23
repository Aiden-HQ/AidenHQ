// The warehouse module's task search service (docs/design/task-search.md): it keeps src_tasks.task_search, one row per
// Paperclip task, and answers the board's searches (module.yaml providers.board: POST /search, through the kernel's
// /v1/board-api/warehouse/search). Its inputs come through the kernel with the module's own token: the control plane as the
// owner (role kernel.cp-read), a task's work (kernel.work-read) and the fact log (kernel.flow-read). Model calls go through
// the gateway as a source writer. It starts without the warehouse (or pgvector) and waits: /healthz says so, and a search
// answers 503 until the rows can be held.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { SourceStore } from "./source-store.ts";
import { STATUSES, SEARCH_MODEL, SEARCH_THRESHOLD, createSearch, gatewayModels, type Issue } from "./search.ts";

const env = (k: string, d = "") => process.env[k] || d;
const file = (k: string) => { try { return readFileSync(env(k), "utf8").trim(); } catch { return ""; } };
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));
const kernelUrl = env("AIDENHQ_KERNEL_URL", "http://10.231.0.1:3130");

/** A kernel read with the module's token (read fresh: the kernel writes it after start). `ok404`: a 404 is null. */
async function kernel(path: string, ok404 = false): Promise<any> {
  const r = await fetch(`${kernelUrl}${path}`, { headers: { authorization: `Bearer ${file("WAREHOUSE_TOKEN_FILE")}` }, signal: AbortSignal.timeout(15_000) });
  if (ok404 && r.status === 404) return null;
  if (!r.ok) throw new Error(`kernel GET ${path.split("?")[0]} → ${r.status}`);
  return r.json();
}
const cpRead = (path: string, ok404 = false) => kernel(`/v1/cp/read${path}`, ok404);

let store: SourceStore | undefined, password = "";
/** The warehouse as src_tasks; a rotated password makes a new pool. */
const sql = () => {
  const pw = file("WAREHOUSE_PASSWORD_FILE");
  if (!pw) return undefined;
  if (pw !== password) {
    void store?.pool.end().catch(() => undefined);
    password = pw;
    store = SourceStore.fromEnv("tasks");
    store?.pool.on("error", () => undefined); // an idle client's error surfaces on the next query
  }
  return store?.pool;
};

let agents = { at: 0, names: new Map<string, string>() };
const agentNames = async () => {
  if (Date.now() - agents.at > 600_000) {
    const a = ((await kernel("/v1/agents")).agents ?? {}) as Record<string, { name?: unknown; key?: unknown }>;
    agents = { at: Date.now(), names: new Map(Object.entries(a).map(([id, g]) => [id, String(g.name ?? g.key ?? "")])) };
  }
  return agents.names;
};
const projects = new Map<string, { at: number; names: Map<string, string> }>();

const db = new DatabaseSync(env("SEARCH_DB", "/data/search.db"));
db.exec("PRAGMA journal_mode = WAL");
const search = createSearch({
  db, sql, log,
  migrate: async (ddl) => { sql(); await store!.migrate(ddl); },
  models: gatewayModels({ url: env("GATEWAY_URL", "http://10.231.0.1:8201"), token: () => file("GATEWAY_KEY_FILE"), model: SEARCH_MODEL, threshold: SEARCH_THRESHOLD, summaries: () => env("SEARCH_SUMMARIES") === "on" }),
  facts: (since) => kernel(`/v1/facts${since === undefined ? "" : `?since=${since}`}`),
  cp: {
    company: async () => {
      for (const id of (await agentNames()).keys()) { const a = await cpRead(`/api/agents/${encodeURIComponent(id)}`, true); if (a?.companyId) return String(a.companyId); }
      throw new Error("no granted agent names the company");
    },
    issue: (id) => cpRead(`/api/issues/${encodeURIComponent(id)}`, true),
    // The newest comments (Paperclip's page: newest first), oldest first for the document, deleted ones left out.
    comments: async (id) => ((await cpRead(`/api/issues/${encodeURIComponent(id)}/comments?order=desc&limit=100`)) as { body?: string; deletedAt?: string | null; createdAt?: string }[])
      .filter((c) => !c?.deletedAt).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))).map((c) => String(c?.body ?? "")),
    list: (company, offset, limit) => cpRead(`/api/companies/${encodeURIComponent(company)}/issues?${new URLSearchParams({ status: STATUSES, limit: String(limit), offset: String(offset), excludeRoutineExecutions: "false", sortField: "id", sortDir: "asc" })}`) as Promise<Issue[]>,
    recent: (company) => cpRead(`/api/companies/${encodeURIComponent(company)}/issues?${new URLSearchParams({ status: STATUSES, limit: "50", excludeRoutineExecutions: "false", sortField: "updated", sortDir: "desc" })}`) as Promise<Issue[]>,
  },
  local: async (task) => {
    const w = (await kernel(`/v1/work?task=${encodeURIComponent(task)}`)) as { prs?: { repo: string; number: number; title: string }[]; paths?: string[]; final?: string };
    return { prs: w.prs ?? [], paths: w.paths ?? [], final: w.final ?? "" };
  },
  agentName: async (id) => (await agentNames()).get(id) || null,
  projectName: async (company, id) => {
    let c = projects.get(company);
    if (!c || Date.now() - c.at > 600_000) projects.set(company, (c = { at: Date.now(), names: new Map(((await cpRead(`/api/companies/${encodeURIComponent(company)}/projects`)) as { id: string; name: string }[]).map((p) => [p.id, p.name])) }));
    return c.names.get(id) ?? null;
  },
});

// The worker every 5 s; reconcile a minute after start, then a complete pass every six hours (an incomplete one again ten
// minutes on).
setInterval(() => void search.tick().catch((e: Error) => log("search tick failed", { err: String(e?.message ?? e).slice(0, 200) })), 5_000);
const reconcile = () => void search.reconcileDue().catch((e: Error) => log("search reconcile failed", { err: String(e?.message ?? e).slice(0, 200) }));
setTimeout(reconcile, 60_000);
setInterval(reconcile, 10 * 60_000);

async function body(req: IncomingMessage, max = 10_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { if ((n += c.length) > max) throw Object.assign(new Error("too large"), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("the body must be JSON"), { status: 400 }); }
}
const authorized = (req: IncomingMessage) => {
  const want = Buffer.from(file("SEARCH_API_TOKEN_FILE")), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
};

/**
 * POST /search {q, closed_before?, after?, limit?, keyword?} (the board, through the kernel) -> {ids, done, next, semantic}:
 * the ranked hits' ids, those closed before `closed_before` as cards paged newest first (`after`: the last page's `next`);
 * `semantic: false`: keyword hits only. A failure is a 503.
 */
createServer(async (req, res) => {
  const send = (status: number, b: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
  try {
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true, warehouse: Boolean(sql()), pending: search.pending() });
    if (req.method !== "POST" || req.url !== "/search") return send(404, { error: "not found" });
    if (!authorized(req)) return send(401, { error: "unauthorized" });
    const b = await body(req);
    if (typeof b.q !== "string" || !b.q.trim() || b.q.length > 500) return send(400, { error: "send {q}: 1 to 500 characters" });
    const before = b.closed_before === undefined ? undefined : String(b.closed_before);
    if (before !== undefined && !Number.isFinite(Date.parse(before))) return send(400, { error: "closed_before is an ISO instant" });
    const after = typeof b.after === "string" && /^[^|]{1,40}\|[\w-]{1,100}$/.test(b.after) ? (b.after.split("|") as [string, string]) : undefined;
    if (b.after !== undefined && !after) return send(400, { error: "after is a page's `next`" });
    const r = await search.search(b.q.trim(), { ...(before ? { closedBefore: new Date(before).toISOString() } : {}), ...(after ? { after } : {}), ...(Number.isInteger(b.limit) ? { limit: b.limit } : {}), ...(b.keyword === true ? { keyword: true } : {}) });
    return send(200, { ids: r.hits.map((h) => h.id), done: r.done, next: r.next ? r.next.join("|") : null, semantic: r.semantic });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 503;
    return send(status, { error: `task search is unavailable: ${String((e as Error).message).slice(0, 200)}` });
  }
}).listen(Number(env("PORT", "8099")), () => log("task search listening", { port: Number(env("PORT", "8099")) }));
