// The ship service: its state (SHIP_STATE_FILE), the HTTP API and the MCP connection `ship` on :8101. Idle with no repo listed.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, serveMcp } from "./mcp.ts";
import { scopeFrom } from "./settings.ts";
import { openState } from "./state.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, file(env.SHIP_TOKEN_FILE)) as Record<string | symbol, unknown>)[k] });

const json = (v: string | undefined) => { try { return JSON.parse(v || "null"); } catch { return null; } };
const raw = () => { const v = json(env.SHIP_SETTINGS); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
const scope = () => scopeFrom(env);
const maintainerRepos = (): unknown[] => { const t = String(env.SHIP_MAINTAINER_REPOS ?? "").trim(); const v = t.startsWith("[") ? json(t) : t.split(",").map((x) => x.trim()).filter(Boolean); return Array.isArray(v) ? v : []; };
const codeReview = () => { const v = json(env.SHIP_CODE_REVIEW); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };

const state = openState(env.SHIP_STATE_FILE ?? "/data/state.json");
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const mcp = serveMcp(createMcp("ship", configTools({
  raw, scope, state, maintainerRepos, codeReview,
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
}), [{ uri: "ui://ship/page", html: readFileSync(new URL("./page.html", import.meta.url), "utf8") }]), () => file(env.SHIP_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "ship")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

createServer(async (req, res) => {
  if (await mcp(req, res)) return;
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8101, "0.0.0.0", () => log("ship listening", { port: 8101 }));
