// The aria service: the Aria page and its tools on :8104 (MCP connection `aria`) and the settings validate hook.
// Settings come from the environment compose sets, so a saved change reaches it with the apply that recreates the service.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { KEYS, problem, readSettings, type Key } from "./settings.ts";
import { openState } from "./state.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const token = () => file(env.ARIA_TOKEN_FILE);
const kernel = () => kernelClient(kernelUrl, token());
const timezone = env.OWNER_TIMEZONE || "UTC";

const settings = readSettings();
const state = openState(env.ARIA_STATE_FILE ?? "/data/state.json");
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);

const mcp = serveMcp(createMcp("aria", configTools({
  settings: () => settings, state, now: () => new Date(),
  env: { timezone, time_format: env.OWNER_TIME_FORMAT || "12h", owner_email: env.OWNER_EMAIL ?? "" },
  file: async (changes, assertion) => {
    const r = await kernel().raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
}), [{ uri: "ui://aria/page", html: pageHtml(new URL("./", import.meta.url)) }]), () => file(env.ARIA_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "aria")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

/** POST /validate: the kernel posts a settings change here (the owner's MCP, the module screen) with the service key; each Aria key is checked whole. */
async function serveValidate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/validate") return false;
  const want = Buffer.from(file(env.ARIA_SERVICE_KEY_FILE)), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return void res.writeHead(401).end(), true;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 256 * 1024) return void res.writeHead(413).end(), true; chunks.push(c as Buffer); }
  let body: { settings?: Record<string, unknown> };
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void res.writeHead(400).end(), true; }
  const errors = KEYS.flatMap((k: Key) => (body?.settings && k in body.settings ? [{ field: k, message: problem(k, body.settings[k]) }] : [])).filter((e) => e.message);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(errors.length ? { ok: false, errors } : { ok: true }));
  return true;
}

createServer(async (req, res) => {
  if (await mcp(req, res) || await serveValidate(req, res)) return;
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8104, "0.0.0.0", () => log("aria listening", { port: 8104 }));
