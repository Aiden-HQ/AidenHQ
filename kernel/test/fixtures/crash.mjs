// The crash-test harness (kernel/test/crash.test.mjs): processes to kill and restart, a fake control plane and computer
// launcher, a gate that kills a process at a named point of an HTTP exchange, and the counts every crash case asserts (one job
// row per wake, one completion comment per job, no box left behind). Kill points fire from outside the process under test:
// a fake holding its answer, the gate between two processes, or a file the engine waits on. The kernel's code has no hooks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(what, ok, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) { const v = await ok(); if (v) return v; }
  assert.fail(`timed out waiting for ${what}`);
}
const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const body = async (req) => { let b = ""; for await (const c of req) b += c; return b; };
const json = (res, status, v) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

/**
 * A node process that prints its port on its first stdout line (fixtures/jobs-host.mjs, the dispatch module's service). kill()
 * is SIGKILL by default: nothing runs after it, as in a crash. restart() starts it again with the same env, on a new port.
 */
export async function child(t, file, env = {}) {
  let p, err = "", exited;
  const c = {
    url: "",
    log: () => err,
    async start() {
      p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", file], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      p.stderr.on("data", (d) => (err += d));
      exited = new Promise((r) => p.once("exit", r));
      const port = await new Promise((res, rej) => { p.stdout.once("data", (d) => res(Number(String(d).trim()))); p.once("exit", (code) => rej(new Error(`${file} exited ${code}: ${err}`))); });
      c.url = `http://127.0.0.1:${port}`;
      return c;
    },
    async kill(signal = "SIGKILL") { if (p.exitCode === null && p.signalCode === null) p.kill(signal); await exited; },
    async restart() { await c.kill(); return c.start(); },
    call: async (method, path, b, token) => {
      const r = await fetch(`${c.url}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(b ? { body: JSON.stringify(b) } : {}) });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    },
  };
  t.after(() => c.kill());
  return c.start();
}

/**
 * A gate between two processes (a dispatcher and the kernel): it forwards every request to `target()` (re-read on each request,
 * so a restarted kernel's new port is followed) and runs a rule's `then` once, when a request matches it, either before it is
 * forwarded (`at: "request"`: the receiver never sees it) or once its answer came back and before it is relayed (`at: "answer"`:
 * the receiver acted, the sender never learns it). `then` is the kill; the held exchange is dropped.
 */
export async function gate(t, target) {
  const rules = [];
  const g = await serve(async (req, res) => {
    const b = await body(req);
    const hit = (at) => { const i = rules.findIndex((r) => r.at === at && r.method === req.method && r.path.test(req.url)); return i < 0 ? undefined : rules.splice(i, 1)[0]; };
    const before = hit("request");
    if (before) return void (await before.then(), res.destroy());
    const r = await fetch(`${target()}${req.url}`, { method: req.method, headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, ...(b ? { body: b } : {}) }).catch(() => undefined);
    const after = hit("answer");
    if (after || !r) return void (after && (await after.then()), res.destroy());
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  });
  t.after(() => g.s.close());
  return { url: g.url, kill: (rule) => void rules.push(rule), pending: () => rules.length };
}

/**
 * A fake control plane: tasks and their comments. A comment POST stores the comment and answers 201; `onComment(fn)` runs fn
 * once, after the store and before the answer (`fn` kills the poster: Paperclip made the comment, its caller never heard).
 * `events()` are the plugin events it raised, in order (issue.created, issue.comment.created), for a test to send, or resend.
 */
export async function fakeControl(t) {
  const tasks = new Map(), comments = [], events = [];
  let hook;
  let n = 0;
  const pc = await serve(async (req, res) => {
    const b = await body(req);
    const u = new URL(req.url, "http://x");
    let m;
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(u.pathname))) {
      if (req.method === "GET") return json(res, 200, comments.filter((c) => c.issueId === m[1]));
      const c = { id: `c-${++n}`, issueId: m[1], body: String(JSON.parse(b || "{}").body ?? ""), authorization: req.headers.authorization ?? "", createdAt: new Date().toISOString() };
      comments.push(c);
      events.push({ type: "issue.comment.created", issueId: c.issueId, commentId: c.id });
      if (hook) { const h = hook; hook = undefined; await h(c); return void res.destroy(); }
      return json(res, 201, c);
    }
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(u.pathname))) {
      const task = tasks.get(m[1]);
      if (req.method === "PATCH" && task) Object.assign(task, JSON.parse(b || "{}"), { updatedAt: new Date().toISOString() });
      return task ? json(res, 200, task) : json(res, 404, {});
    }
    if (/^\/api\/companies\/[^/]+\/issues$/.test(u.pathname)) {
      const status = u.searchParams.get("status")?.split(",");
      return json(res, 200, [...tasks.values()].filter((x) => !status || status.includes(x.status)));
    }
    if (/^\/api\/agents\/[^/]+$/.test(u.pathname)) return json(res, 200, { id: u.pathname.split("/").pop(), metadata: { runnerEngine: true, box: true } });
    json(res, 404, {});
  });
  t.after(() => pc.s.close());
  return {
    url: pc.url, tasks, comments, events,
    /** A task assigned to `agent`, as Paperclip makes one (an issue.created event with it). */
    task(id, agent, over = {}) { const x = { id, identifier: id, assigneeAgentId: agent, status: "todo", updatedAt: new Date().toISOString(), ...over }; tasks.set(id, x); events.push({ type: "issue.created", issueId: id }); return x; },
    onComment: (fn) => void (hook = fn),
  };
}

/**
 * A fake computer launcher with services/computer/launcher.mjs's job routes (/job, /job/renew, /job/release) over its jobs.json
 * in `dir`, and the box files the kernel's docker stand-in (fixtures/docker.mjs) runs a job by: <container>.env,
 * <container>.box.json and the out folder, in `boxDir`. `hold(route)` parks that route's next call until the caller is killed.
 */
export async function fakeLauncher(t, { dir, boxDir, engineDir = "" }) {
  mkdirSync(boxDir, { recursive: true });
  const file = join(dir, "jobs.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
  const save = (l) => writeFileSync(file, JSON.stringify(l));
  const held = new Set();
  let n = 0;
  const routes = {
    "/job": ({ agentId, issueId, workspace }) => {
      if (read().some((j) => j.issueId === issueId)) return [409, { error: `the task's last box is still up: release it first` }];
      const container = `aidenhq-computer-c${++n}`;
      const outDir = join(boxDir, container);
      mkdirSync(outDir);
      writeFileSync(join(boxDir, `${container}.env`), "AIDENHQ_RUN_TOKEN=ahqj_x\nHOME=/workspace/.aidenhq/home\n");
      writeFileSync(join(boxDir, `${container}.box.json`), JSON.stringify({ workspace, outDir, engineDir }));
      save([...read(), { container, agentId, issueId, workspace }]);
      return [200, { container, envFile: join(boxDir, `${container}.env`), outDir }];
    },
    "/job/renew": ({ container }) => (read().some((j) => j.container === container) ? [200, { container }] : [404, { error: `no live job ${container}` }]),
    "/job/release": ({ container }) => { save(read().filter((j) => j.container !== container)); writeFileSync(join(boxDir, `${container}.box.json`), JSON.stringify({ gone: true })); return [200, { state: "missing" }]; },
  };
  const l = await serve(async (req, res) => {
    const b = JSON.parse((await body(req)) || "{}");
    const route = routes[new URL(req.url, "http://x").pathname];
    if (req.method !== "POST" || !route) return json(res, 404, {});
    if (held.delete(req.url)) return; // parked: no answer, ever
    const [status, out] = route(b);
    json(res, status, out);
  });
  t.after(() => l.s.close());
  return { url: l.url, jobs: read, hold: (route) => void held.add(route) };
}

/** The completion tag the kernel puts on a job's outcome comment (Task F5): `<!-- aidenhq:job=<id> kind=<kind> -->`. */
export const TAG = /<!-- aidenhq:job=(j-[0-9a-f]{16}) kind=(reply|status|notice) -->/;

/** The job rows in a kernel.db that match `where` ({ wake } or { task }). */
export function jobRows(dbFile, where) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const [col, v] = Object.entries(where)[0];
    if (!["wake", "task"].includes(col)) throw new Error(`jobRows: ${col}`);
    return db.prepare(`SELECT * FROM jobs WHERE ${col} = ?`).all(v);
  } finally {
    db.close();
  }
}

/** The completion comments (kind reply) a job posted on its task. */
export const completions = (comments, job) => comments.filter((c) => TAG.exec(c.body)?.[1] === job && TAG.exec(c.body)?.[2] === "reply");

/** What every crash case asserts for a wake: one job row, one completion comment for it, and no box left in the launcher. */
export function exactlyOnce({ dbFile, comments, launcher }, wake) {
  const rows = jobRows(dbFile, { wake });
  assert.equal(rows.length, 1, `one job row for wake ${wake}, got ${rows.length}`);
  assert.equal(completions(comments, rows[0].id).length, 1, `one completion comment for job ${rows[0].id}`);
  assert.deepEqual(launcher.jobs(), [], "no box left behind");
  return rows[0];
}
