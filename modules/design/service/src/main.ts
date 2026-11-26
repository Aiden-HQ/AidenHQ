// The design service: the UI Reviewer's runs and evidence store (store.ts) behind the `design` connection (tools.ts, served at
// /mcp with the service key; every call carries the kernel's signed caller assertion), the apps it tests and their passes
// (passes.ts: settings.ui_testing, tasks filed with this module's kernel token; schedule.ts: when they start) and the job tools the kernel forwards to a pass
// (jobtools.ts, POST /jobtools with the service key). Evidence older than 30 days is swept daily.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createMcp, serveMcp } from "./mcp.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { designTools } from "./tools.ts";
import { DAY, openStore } from "./store.ts";
import { createPasses, readApps, readLogins, validate } from "./passes.ts";
import { createJobTools } from "./jobtools.ts";
import { createScheduler } from "./schedule.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const store = openStore(env.DESIGN_DATA ?? "/data");
const { apps, errors } = readApps(env.DESIGN_UI_TESTING);
for (const e of errors) log("WARNING: settings.ui_testing", { error: e });
// Read on each call, so a login pasted on the board works without a restart. Never logged.
const logins = () => readLogins(file(env.DESIGN_UI_LOGINS_FILE));
const kernel = () => kernelClient(kernelUrl, file(env.DESIGN_TOKEN_FILE));
/** Closes a pass's task, cancelled: the dispatcher stops its job (a Stop, a pass past its time). */
const closeTask = async (task: string, body: string) => void await kernel().call("POST", `/v1/tasks/${encodeURIComponent(task)}/close`, { status: "cancelled", body });
const passes = createPasses({
  store, apps: () => apps, logins, boardUrl: env.DESIGN_BOARD_URL,
  kernel: {
    fileTask: async (t) => { const r = await kernel().call("POST", "/v1/tasks", t); return { id: String(r.id), agent: String(r.agent) }; },
    closeTask,
    spend: async (prefix, day) => (await kernel().call("GET", `/v1/work?spend_tasks=${encodeURIComponent(prefix)}&day=${day}`)).by_task,
  },
});
// The scheduler (schedule.ts): deploys, 24/7 apps and the running passes' reconcile, one tick a minute, one at a time.
const scheduler = createScheduler({
  store, passes, apps: () => apps, log,
  kernel: {
    openTasks: async (prefix) => (await kernel().call("GET", `/v1/tasks?source=${encodeURIComponent(prefix)}`)).tasks,
    taskWork: async (task) => {
      const w = await kernel().call("GET", `/v1/work?task=${encodeURIComponent(task)}`);
      return { status: w.status ?? null, live: (w.jobs as { state: string }[]).some((j) => ["admitted", "running"].includes(j.state)) };
    },
    closeTask,
  },
  feed: (connection, after) => kernel().call("GET", `/v1/events/log?connection=${connection}&limit=200${after === undefined ? "" : `&after=${after}`}`),
});
let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try { await scheduler.tick(); } finally { ticking = false; }
};
setInterval(tick, 60_000);
void tick();
// An AidenHQ app's test-user session: this module's token and the job tool call's own assertion, which the kernel re-checks.
const mintSession = (assertion: string, app: string) => kernel().raw("POST", "/v1/test-session", { app, minutes: 60 }, { "x-aidenhq-caller": assertion });
const jobtools = createJobTools({ passes, logins, mintSession });
const serviceKey = () => file(env.DESIGN_SERVICE_KEY_FILE);

const mcp = serveMcp(createMcp("design", designTools(store, { passes, apps: () => apps, logins })), serviceKey, async (req) => ({ ...(await verifyCaller(req, jwks, "design")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
  // design_evidence_put takes 8 MB decoded per call: about 10.7 MB as base64 (the kernel's proxy takes 14 MB).
  12 * 1024 * 1024);
const sweep = () => { try { const n = store.sweep(); if (n) log("swept old runs", { n }); } catch (e) { log("WARNING: sweep failed", { err: String((e as Error).message).slice(0, 300) }); } };
sweep();
setInterval(sweep, DAY);
// The validate hook (module.yaml validate:): the kernel posts a settings change or a pasted ui_logins with the service key.
async function serveValidate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/validate") return false;
  const want = Buffer.from(serviceKey()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return res.writeHead(401).end(), true;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { if ((n += (c as Buffer).length) > 256 * 1024) return res.writeHead(413).end(), true; chunks.push(c as Buffer); }
  let body: Parameters<typeof validate>[0];
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return res.writeHead(400).end(), true; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(validate(body && typeof body === "object" ? body : {})));
  return true;
}
createServer(async (req, res) => {
  try { if (!(await mcp(req, res)) && !(await jobtools.serve(req, res, serviceKey)) && !(await serveValidate(req, res))) res.writeHead(req.url === "/healthz" ? 200 : 404).end(); }
  catch (e) { log("request failed", { err: String((e as Error).message).slice(0, 200) }); if (!res.headersSent && res.writable) res.writeHead(400).end(); }
}).listen(8099, "0.0.0.0", () => log("design listening", { port: 8099 }));
