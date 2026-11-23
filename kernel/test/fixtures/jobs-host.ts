// A kernel's job half in its own process, as main.ts runs it (createJobs, adopt at start, detach and exit on SIGUSR2; SIGTERM and SIGINT also kill its jobs), over JOBS_DIR's kernel.db and sandbox.json (kernel/test/jobs.test.ts). Serves POST /run {box, kind} (an admitted job
// started in that box, as boxes.ts starts one) and the job routes (GET/DELETE /v1/jobs/:id, POST /v1/jobs/:id/input) for the
// module acme-dispatch. Prints its port.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJobs } from "../../src/jobs.ts";
import { admitAndRun } from "./admitted.ts";

const dir = process.env.JOBS_DIR;
const MODULE = "acme-dispatch";
const cfg = JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8"));
const db = new DatabaseSync(join(dir, "kernel.db"));
const jobs = createJobs({ db, cfg, cp: { task: async () => undefined }, mayDispatch: () => true, boxWrap: 'exec "$@"', log: (msg, f = {}) => console.error(msg, JSON.stringify(f)) });
jobs.adopt();
// SIGUSR2 is the restart: the jobs keep running for the next kernel. SIGTERM and SIGINT end the test: no job outlives its host.
const endJobs = () => { for (const { pid } of db.prepare("SELECT pid FROM jobs WHERE state = 'running' AND pid > 0").all()) try { process.kill(-pid, "SIGKILL"); } catch {} };
process.on("SIGUSR2", () => { jobs.detach(); process.exit(0); });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { jobs.detach(); endJobs(); process.exit(0); });
const server = http.createServer(async (req, res) => {
  const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  try {
    const u = new URL(req.url, "http://x");
    const [, id, input] = /^\/v1\/jobs\/(j-[0-9a-f]{16})(\/input)?$/.exec(u.pathname) ?? [];
    let b = "";
    for await (const c of req) b += c;
    if (req.method === "POST" && u.pathname === "/run") { const r = JSON.parse(b); return send(200, admitAndRun(db, jobs, cfg, r.box, r.kind)); }
    if (req.method === "GET" && id && !input) return send(200, await jobs.get(MODULE, id, { ...(u.searchParams.has("after") ? { after: Number(u.searchParams.get("after")) } : {}), waitMs: Number(u.searchParams.get("wait") ?? 0) }));
    if (req.method === "DELETE" && id && !input) return send(200, jobs.stop(MODULE, id));
    if (req.method === "POST" && id && input) { const j = JSON.parse(b); return send(200, jobs.input(MODULE, id, j.text, j.from)); }
    send(404, { error: { message: "no such route" } });
  } catch (e) {
    send(e.status ?? 500, { error: { message: e.message, code: e.code } });
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
