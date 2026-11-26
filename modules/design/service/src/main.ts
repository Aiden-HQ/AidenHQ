// The design service: the UI Reviewer's runs and evidence store (store.ts) behind the `design` connection (tools.ts, served at
// /mcp with the service key; every call carries the kernel's signed caller assertion), the apps it tests and their passes
// (passes.ts: settings.ui_testing, tasks filed with this module's kernel token) and the job tools the kernel forwards to a pass
// (jobtools.ts, POST /jobtools with the service key). Evidence older than 30 days is swept daily.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createMcp, serveMcp } from "./mcp.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { designTools } from "./tools.ts";
import { DAY, openStore } from "./store.ts";
import { createPasses, readApps, readLogins } from "./passes.ts";
import { createJobTools } from "./jobtools.ts";

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
const passes = createPasses({
  store, apps: () => apps, logins,
  fileTask: async (t) => { const r = await kernel().call("POST", "/v1/tasks", t); return { id: String(r.id), agent: String(r.agent) }; },
});
const jobtools = createJobTools({ passes, store, logins });
const serviceKey = () => file(env.DESIGN_SERVICE_KEY_FILE);

const mcp = serveMcp(createMcp("design", designTools(store, { passes, apps: () => apps, logins })), serviceKey, async (req) => ({ ...(await verifyCaller(req, jwks, "design")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
  // design_evidence_put takes 8 MB decoded per call: about 10.7 MB as base64 (the kernel's proxy takes 14 MB).
  12 * 1024 * 1024);
const sweep = () => { try { const n = store.sweep(); if (n) log("swept old runs", { n }); } catch (e) { log("WARNING: sweep failed", { err: String((e as Error).message).slice(0, 300) }); } };
sweep();
setInterval(sweep, DAY);
createServer(async (req, res) => {
  try { if (!(await mcp(req, res)) && !(await jobtools.serve(req, res, serviceKey))) res.writeHead(req.url === "/healthz" ? 200 : 404).end(); }
  catch (e) { log("request failed", { err: String((e as Error).message).slice(0, 200) }); if (!res.headersSent && res.writable) res.writeHead(400).end(); }
}).listen(8099, "0.0.0.0", () => log("design listening", { port: 8099 }));
