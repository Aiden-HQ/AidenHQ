// engine@1 for opencode: a long-lived session over `opencode serve`. job.json → opencode.json (src/config.ts), one server, one
// opencode session (resumed by spec.session), the prompt and every comment sent as turns one at a time, its events → events.jsonl.
// It never emits `final` and never exits by itself: the session lives until the kernel stops the job (SIGTERM: the turn is
// aborted and the exit is 143, which the kernel reads as machinery, so a box replacement resumes the same session).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { engineIO } from "../sdk/engine-io.ts";
import { opencodeConfig } from "./config.ts";
import { sseEvents } from "./events.ts";
import { serve } from "./server.ts";
import { startTerminal } from "./terminal.ts";

const jobDir = process.argv[2]!;
const leaseDir = dirname(jobDir);

// Its own session and process group, so session-stop ends the server and everything it started with one signal.
if (!process.env.AIDENHQ_ENGINE_GROUP) {
  const child = spawn("setsid", ["-w", process.execPath, ...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, AIDENHQ_ENGINE_GROUP: "1" }, stdio: "inherit" });
  child.on("error", (e) => { console.error(`couldn't start setsid: ${e.message}`); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (signal === "SIGTERM" ? 15 : 9)));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
} else {
  await run();
}

async function run() {
  const io = engineIO(jobDir);
  const spec = io.spec;
  const env = process.env;
  const need = (n: string) => env[n] || (() => { throw new Error(`${n} is not set`); })();
  const port = Number(need("AIDENHQ_SESSION_PORT"));
  const password = need("OPENCODE_SERVER_PASSWORD");
  const state = spec.state ?? (() => { throw new Error("job.json has no state folder"); })();
  const pluginRoot = env.AIDENHQ_OPENCODE_PLUGINS ?? "/opt/opencode";
  // plugins.json (copied into the image at pluginRoot) names the installed plugins; opencode loads each from its folder, so nothing is fetched.
  const plugins = (JSON.parse(readFileSync(join(pluginRoot, "plugins.json"), "utf8")).plugins as string[]).map((s) => join(pluginRoot, "node_modules", s.slice(0, s.lastIndexOf("@"))));
  writeFileSync(join(leaseDir, "pgid"), String(process.pid));
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "opencode.json"), JSON.stringify(opencodeConfig(spec, { plugins, stateDir: state })), { mode: 0o600 });
  // The context-pruning plugin would update itself from npm: off.
  writeFileSync(join(state, "dcp.jsonc"), JSON.stringify({ autoUpdate: false }));
  const ocEnv = { ...env, OPENCODE_CONFIG: join(state, "opencode.json"), OPENCODE_CONFIG_DIR: state, XDG_DATA_HOME: join(state, "data"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
  const server = await serve({ bin: env.AIDENHQ_OPENCODE_BIN, port, password, env: ocEnv });

  process.on("exit", () => server.child.kill("SIGKILL"));   // a failure past this point never leaves the server behind
  let session = spec.session ?? "";
  if (session) try { await server.call("GET", `/session/${session}`); } catch { session = ""; }
  if (!session) session = (await server.call("POST", "/session", { title: basename(process.cwd()) })).id;
  io.emit({ t: "session", id: session });

  const sse = sseEvents(spec, io.emit, () => session);
  await server.events((ev) => sse.take(ev));

  const busy = async () => Boolean((await server.call("GET", "/session/status"))?.[session]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // One turn at a time: a prompt goes in once the session is idle, and the next waits for that turn to end.
  const queue: string[] = [spec.prompt];
  void (async () => {
    for await (const c of io.comments()) queue.push(c.text);
  })();
  void (async () => {
    for (;;) {
      const text = queue.shift();
      if (text === undefined) { await sleep(200); continue; }
      while (await busy()) await sleep(300);
      await server.call("POST", `/session/${session}/prompt_async`, { parts: [{ type: "text", text }] });
      for (let i = 0; i < 20 && !(await busy()); i++) await sleep(150);
      while (await busy()) await sleep(300);
    }
  })();

  const lease = basename(leaseDir);
  const ttyd = startTerminal({ lease, leaseDir, port: Number(need("AIDENHQ_TERM_PORT")), sessionPort: port, session, credential: need("AIDENHQ_TERM_CREDENTIAL"), cwd: process.cwd(), env: ocEnv });
  void ttyd;

  let stopping = false;
  process.on("SIGTERM", async () => {
    stopping = true;
    try { await server.call("POST", `/session/${session}/abort`); } catch {}
    await server.stop();
    process.exit(143);
  });
  server.child.on("exit", (code) => { if (stopping) return; console.error(`opencode serve exited (${code})`); process.exit(code || 1); });
}
