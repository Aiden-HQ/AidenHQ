// The server-manager service: one container (`server-manager-ssh`), on :8103, holding a server's private key only at connect time
// and the only thing in the fleet that speaks to a server (spec §2, §4). It serves the MCP connection `server-manager` with the
// config read path (`server_manager_config`, `server_manager_status`), the SSH check (`server_manager_check`), its Servers page
// view, and the `validate` hook (a settings change and a key's clear). The write kinds and the executor land on this same service.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { StatusStore } from "./status-store.ts";
import { configTools } from "./tools.ts";
import { validate, type ValidateInput } from "./validate.ts";
import { readKeys, type Transport } from "./ssh.ts";
import { ensureSchema } from "./status.ts";

const env = process.env;
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const serviceKey = () => file(env.SERVERS_SERVICE_KEY_FILE);
// Settings.servers_machines as the instance holds it (a JSON list). It is the container's environment, fixed at start: a saved
// change applies because the kernel applies the settings change by recreating this service with the new value, never mid-process.
const machines = () => env.SERVERS_MACHINES ?? "[]";
const status = new StatusStore(env.SERVERS_STATE_DIR ?? "/data");
// The key map (servers_keys) and the transport's paths: read fresh on every check, never cached and never logged.
const keys = () => readKeys(env.SERVERS_KEYS_FILE);
const transport: Transport = { config: { stateDir: env.SERVERS_STATE_DIR ?? "/data", tmpDir: env.SERVERS_TMP_DIR } };

const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const mcp = serveMcp(
  createMcp("server-manager", configTools({ machines, status, keys, transport, log }), [{ uri: "ui://server-manager/page", html: pageHtml(new URL("./", import.meta.url)) }]),
  serviceKey,
  async (req) => ({ ...(await verifyCaller(req, jwks, "server-manager")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }),
);

/** POST /validate: the kernel posts a settings change or a key's set/clear here with the service key. */
async function serveValidate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean> {
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/validate") return false;
  const want = Buffer.from(serviceKey()), got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return void res.writeHead(401).end(), true;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 256 * 1024) return void res.writeHead(413).end(), true; chunks.push(c as Buffer); }
  let body: ValidateInput;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return void res.writeHead(400).end(), true; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(validate(body && typeof body === "object" ? body : {}, machines())));
  return true;
}

createServer(async (req, res) => {
  try {
    if (await mcp(req, res)) return;
    if (await serveValidate(req, res)) return;
    res.writeHead(req.url === "/healthz" ? 200 : 404).end();
  } catch (e) {
    log("request failed", { err: String((e as Error).message).slice(0, 200) });
    if (!res.headersSent && res.writable) res.writeHead(400).end();
  }
}).listen(8103, "0.0.0.0", () => {
  log("server-manager listening", { port: 8103, machines: (() => { try { return JSON.parse(machines()).length; } catch { return 0; } })() });
  // The advertised src_servers views exist from the first boot, before any machine is checked (spec §8).
  void ensureSchema(log);
});
