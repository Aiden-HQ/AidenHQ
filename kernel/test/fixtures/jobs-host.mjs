// A kernel's job half in its own process, as main.ts runs it (createJobs, adopt at start, detach and exit on SIGTERM, SIGINT or
// SIGUSR2), serving the backplane's job routes (POST /v1/jobs, GET/DELETE /v1/jobs/:id, POST /v1/jobs/:id/input) for the
// module JOBS_MODULE (the dispatcher). Prints its port.
// - JOBS_DIR: kernel.db and sandbox.json there (kernel/test/jobs.test.mjs); the control plane assigns every task to agent-1, an
//   engine agent with a computer.
// - Otherwise (services/runner's flows): the sandbox from config/runner.yaml as main.ts reads it (sandboxConfig), the control
//   plane at its URL (env) with the board key, kernel.db at JOBS_DB.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../../src/jobs.ts";
import { sandboxConfig } from "../../src/sandbox-config.ts";

const dir = process.env.JOBS_DIR;
const MODULE = process.env.JOBS_MODULE ?? "acme-dispatch";
let cfg, cp;
if (dir) {
  cfg = JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));
  cp = { agent: async (id) => ({ id, metadata: { runnerEngine: true, box: true } }), task: async (id) => ({ id, identifier: "PEN-1", assigneeAgentId: "agent-1", status: "todo" }) };
} else {
  cfg = sandboxConfig();
  const key = readFileSync(join(process.env.AIDENHQ_SECRETS_DIR, "paperclip_board_key"), "utf8").trim();
  const get = async (p) => { const r = await fetch(`${process.env.PAPERCLIP_URL}${p}`, { headers: { authorization: `Bearer ${key}` } }); return r.ok ? r.json() : undefined; };
  cp = { agent: (id) => get(`/api/agents/${encodeURIComponent(id)}`), task: (id) => get(`/api/issues/${encodeURIComponent(id)}`) };
}
const db = new DatabaseSync(dir ? join(dir, "kernel.db") : process.env.JOBS_DB);
// Which module dispatches which agent is compile's (kernel/test/jobs.test.mjs covers it); here every agent is MODULE's.
const jobs = createJobs({ db, cfg, cp, mayDispatch: () => true, boxWrap: 'exec "$@"', log: (msg, f = {}) => console.error(msg, JSON.stringify(f)) });
jobs.adopt();
for (const sig of ["SIGTERM", "SIGINT", "SIGUSR2"]) process.on(sig, () => { jobs.detach(); process.exit(0); });
const server = http.createServer(async (req, res) => {
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    const u = new URL(req.url, "http://x");
    const [, id, input] = /^\/v1\/jobs\/(j-[0-9a-f]{16})(\/input)?$/.exec(u.pathname) ?? [];
    let b = "";
    for await (const c of req) b += c;
    if (req.method === "POST" && u.pathname === "/v1/jobs") return send(200, await jobs.start(MODULE, JSON.parse(b)));
    if (req.method === "GET" && id && !input) return send(200, await jobs.get(MODULE, id, { ...(u.searchParams.has("after") ? { after: Number(u.searchParams.get("after")) } : {}), waitMs: Number(u.searchParams.get("wait") ?? 0) }));
    if (req.method === "DELETE" && id && !input) return send(200, jobs.stop(MODULE, id));
    if (req.method === "POST" && id && input) { const j = JSON.parse(b); return send(200, jobs.input(MODULE, id, j.text, j.from)); }
    send(404, { error: { message: "no such route" } });
  } catch (e) {
    send(e.status ?? 500, { error: { message: e.message, code: e.code } });
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
