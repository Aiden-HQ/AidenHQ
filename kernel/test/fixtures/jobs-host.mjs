// A kernel's job half in its own process, as main.ts runs it (createJobs, adopt at start, detach and exit on SIGTERM, SIGINT or
// SIGUSR2), over a kernel.db in JOBS_DIR, unconfined (the test's engines are scripts). Prints its port. Routes: POST /jobs (a
// JobRequest, module `engineering`), GET /jobs/:id[?after=&wait=], DELETE /jobs/:id. The fake control plane assigns every task to
// agent-1, an engine agent.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../../src/jobs.ts";

const dir = process.env.JOBS_DIR;
const cfg = JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));
const db = new DatabaseSync(join(dir, "kernel.db"));
const jobs = createJobs({
  db, cfg, boxWrap: 'exec "$@"', jobcaps: () => [], log: (msg, f = {}) => console.error(msg, JSON.stringify(f)),
  cp: { agent: async (id) => ({ id, metadata: { runnerEngine: true } }), task: async (id) => ({ id, assigneeAgentId: "agent-1", status: "todo" }) },
});
jobs.adopt();
for (const sig of ["SIGTERM", "SIGINT", "SIGUSR2"]) process.on(sig, () => { jobs.detach(); process.exit(0); });
const server = http.createServer(async (req, res) => {
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    const u = new URL(req.url, "http://x");
    const id = /^\/jobs\/(j-[0-9a-f]{16})$/.exec(u.pathname)?.[1];
    if (req.method === "POST" && u.pathname === "/jobs") {
      let b = "";
      for await (const c of req) b += c;
      return send(200, await jobs.start("engineering", JSON.parse(b)));
    }
    if (req.method === "GET" && id) return send(200, await jobs.get("engineering", id, { ...(u.searchParams.has("after") ? { after: Number(u.searchParams.get("after")) } : {}), waitMs: Number(u.searchParams.get("wait") ?? 0) }));
    if (req.method === "DELETE" && id) return send(200, jobs.stop("engineering", id));
    send(404, {});
  } catch (e) {
    send(e.status ?? 500, { error: e.message });
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
