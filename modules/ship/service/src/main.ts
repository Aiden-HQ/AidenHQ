// The ship service: its state (SHIP_STATE_FILE), the HTTP API and the MCP connection `ship` on :8101. Idle with no repo listed.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { handler } from "./api.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, serveMcp } from "./mcp.ts";
import { isModule } from "./module-caller.ts";
import { coveredRepos } from "./settings.ts";
import { openState } from "./state.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, file(env.SHIP_TOKEN_FILE)) as Record<string | symbol, unknown>)[k] });

const json = (v: string | undefined) => { try { return JSON.parse(v || "null"); } catch { return null; } };
const raw = () => { const v = json(env.SHIP_SETTINGS); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
const covered = () => coveredRepos(env);
const gated = () => (env.SHIP_GATED === undefined ? undefined : env.SHIP_GATED.split(",").map((s) => s.trim()).filter(Boolean));

const state = openState(env.SHIP_STATE_FILE ?? "/data/state.json");
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const api = handler({ state, isModule: (a, m) => isModule(kernelUrl, a, m) });
const mcp = serveMcp(createMcp(configTools({
  raw, covered, gated, state,
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
})), () => file(env.SHIP_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "ship")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

createServer(async (req, res) => { if (await mcp(req, res)) return; await api(req, res); })
    .listen(8101, "0.0.0.0", () => log("ship listening", { port: 8101, covered: covered().length }));
