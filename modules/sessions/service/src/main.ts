// The sessions service: the event watches (watches.ts), the log reader that fires them (reader.ts) and the MCP connection
// `sessions` on :8102 (tools.ts).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { createMcp, serveMcp } from "./mcp.ts";
import { createReader } from "./reader.ts";
import { watchTools } from "./tools.ts";
import { openWatches } from "./watches.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
// The token file is read on every call: the vault may write it after the service starts.
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, file(env.SESSIONS_TOKEN_FILE)) as Record<string | symbol, unknown>)[k] });
const watches = openWatches(env.SESSIONS_DB ?? "/data/sessions.db");
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);

const mcp = serveMcp(createMcp("sessions", watchTools({ watches, kernel })), () => file(env.SESSIONS_SERVICE_KEY_FILE), (req) => verifyCaller(req, jwks, "sessions"));

// Every armed watch is checked against the live state at start (an event may have passed while the service was down), then the
// log is read every few seconds. A pass that fails (the kernel restarting, GitHub not connected) is tried again at the next.
const reader = createReader({ kernel, watches, log });
let quiet = false;
const every = Math.max(Number(env.SESSIONS_POLL_SECONDS) || 15, 1) * 1000;
void (async () => {
  // The cursor is set (at the log's head) before any live check, so an event after it is read and one before it was checked live.
  await reader.tick().catch((e) => log("event log not read", { err: String(e?.message ?? e).slice(0, 200) }));
  await reader.reconcileAll().catch((e) => log("start check failed", { err: String(e?.message ?? e).slice(0, 200) }));
  for (;;) {
    await reader.tick().catch((e) => {
      // No GitHub in the install: the kernel has no subscription to answer for, which is no failure (timed waits and comments still work). Said once.
      if (e?.status === 403) { if (!quiet) log("no GitHub event subscription: watches wait for GitHub", {}); quiet = true; return; }
      log("event log not read", { err: String(e?.message ?? e).slice(0, 200) });
    });
    await new Promise((r) => setTimeout(r, every));
  }
})();

createServer(async (req, res) => {
  if (await mcp(req, res)) return;
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8102, "0.0.0.0", () => log("sessions listening", { port: 8102 }));
