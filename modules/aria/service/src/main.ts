// The aria service: the Aria page and its tools on :8104 (MCP connection `aria`), and the nightly tidy-up's trigger (tidy.ts).
// Settings come from the environment compose sets, so a saved change reaches it with the apply that recreates the service.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { readSettings } from "./settings.ts";
import { openState } from "./state.ts";
import { tidyLook } from "./tidy.ts";

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
  work: async (since) => ((await kernel().call("GET", `/v1/work?since=${encodeURIComponent(since)}`)).records ?? []),
}), [{ uri: "ui://aria/page", html: pageHtml(new URL("./", import.meta.url)) }]), () => file(env.ARIA_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "aria")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

// The tidy-up: one look a minute. Nothing runs while it is off, and a token the kernel writes later is picked up without a restart.
const opt = settings.aria_optimizer as { on: boolean; at: string; max_moves: number; no_move_within_hours: number; horizon_working_days: number; prompt_lines: string[] };
let looking = false;
setInterval(() => {
  if (looking || !token()) return;
  looking = true;
  void tidyLook({
    now: () => new Date(), timeZone: timezone, state, log,
    settings: () => ({ on: opt.on, at: opt.at, prompt: opt.prompt_lines, plan: opt }),
    file: async (title, description, source) => {
      try { const r = await kernel().call("POST", "/v1/tasks", { title, description, role: "aria-admin", source }); return { id: String(r.id ?? "") }; } catch { return false; }
    },
  }).catch((e) => log("tidy-up look failed", { err: String(e) })).finally(() => { looking = false; });
}, 60_000).unref();

createServer(async (req, res) => {
  if (await mcp(req, res)) return;
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8104, "0.0.0.0", () => log("aria listening", { port: 8104 }));
