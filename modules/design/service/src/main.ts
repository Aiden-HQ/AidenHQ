// The design service: the UI Reviewer's runs and evidence store (store.ts) behind the `design` connection (tools.ts, served at
// /mcp with the service key; every call carries the kernel's signed caller assertion). Evidence older than 30 days is swept daily.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createMcp, serveMcp } from "./mcp.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { designTools } from "./tools.ts";
import { DAY, openStore } from "./store.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const store = openStore(env.DESIGN_DATA ?? "/data");

const mcp = serveMcp(createMcp("design", designTools(store)), () => file(env.DESIGN_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "design")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
  // design_evidence_put takes 8 MB decoded per call: about 10.7 MB as base64 (the kernel's proxy takes 14 MB).
  12 * 1024 * 1024);
const sweep = () => { try { const n = store.sweep(); if (n) log("swept old runs", { n }); } catch (e) { log("WARNING: sweep failed", { err: String((e as Error).message).slice(0, 300) }); } };
sweep();
setInterval(sweep, DAY);
createServer(async (req, res) => { if (!(await mcp(req, res))) res.writeHead(req.url === "/healthz" ? 200 : 404).end(); }).listen(8099, "0.0.0.0", () => log("design listening", { port: 8099 }));
