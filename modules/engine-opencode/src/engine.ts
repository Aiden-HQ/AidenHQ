// engine@1 for opencode: a long-lived session over `opencode serve`. job.json → opencode.json (src/config.ts), one server, one
// opencode session (resumed by spec.session), the prompt and every comment sent as turns one at a time, its events → events.jsonl.
// It never emits `final` (each finished turn's last words are a `reply` event instead) and never exits by itself: the session lives until the kernel stops the job (SIGTERM: the turn is
// aborted and the exit is 143, which the kernel reads as machinery, so a box replacement resumes the same session).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { engineIO } from "../sdk/engine-io.ts";
import { modelLimits, opencodeConfig } from "./config.ts";
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
  // The context-pruning plugin would update itself from npm: off.
  writeFileSync(join(state, "dcp.jsonc"), JSON.stringify({ autoUpdate: false }));
  const ocEnv = { ...env, OPENCODE_CONFIG: join(state, "opencode.json"), OPENCODE_CONFIG_DIR: state, XDG_DATA_HOME: join(state, "data"), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    // Only the engine's config: a workspace's own opencode.json, agents or plugins cannot change the gateway, connections or plugin set.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1" };
  // The terminal's credential is ttyd's alone: the server, and the shell its agent runs, never hold it.
  const { AIDENHQ_TERM_CREDENTIAL: _term, ...serverEnv } = ocEnv;
  let stopping = false;
  const queue: { text: string; comment: boolean }[] = [];
  const pendingFile = join(state, "pending.json");
  const save = () => { writeFileSync(`${pendingFile}.tmp`, JSON.stringify(queue.filter((q) => q.comment).map((q) => q.text))); renameSync(`${pendingFile}.tmp`, pendingFile); };
  // Comments the runner appended that the loops have not read yet are kept for the next job, with the queued ones: dispatch counts them delivered.
  const keepUnread = () => { try { for (const c of io.drain()) queue.push({ text: c.text, comment: true }); save(); } catch {} };
  // A failed loop ends the job loudly (the kernel reads a non-zero exit as a failure and retries), never an unhandled rejection.
  const fail = (e: unknown) => { if (stopping) return; console.error(`engine failed: ${(e as Error)?.message ?? e}`); keepUnread(); process.exit(1); };
  // Comments a previous job kept come first, and are loaded before anything can fail() and rewrite pending.json.
  try { for (const text of JSON.parse(readFileSync(pendingFile, "utf8")) as string[]) queue.push({ text, comment: true }); } catch {}
  // The models' windows come from the gateway before anything starts: a failed or stopped lookup keeps the inbox's comments too.
  const onTerm = () => { keepUnread(); process.exit(143); };
  process.once("SIGTERM", onTerm);
  const limits = await modelLimits(spec, need(spec.model.token_env)).catch((e) => { fail(e); throw e; });
  process.off("SIGTERM", onTerm);
  writeFileSync(join(state, "opencode.json"), JSON.stringify(opencodeConfig(spec, { plugins, stateDir: state, limits })), { mode: 0o600 });
  // A server that never comes up fails through fail(), so comments already in the inbox are kept for the next job.
  const server = await serve({ bin: env.AIDENHQ_OPENCODE_BIN, port, password, env: serverEnv }).catch((e) => { fail(e); throw e; });

  process.on("exit", () => server.child.kill("SIGKILL"));   // a failure past this point never leaves the server behind
  let session = spec.session ?? "";
  if (session) {
    try { await server.call("GET", `/session/${session}`); } catch (e) {
      // A session opencode no longer has: the kernel's stale-session path (kernel/src/jobs.ts STALE_SESSION) reruns the job with its full first-turn prompt.
      if (/ 404 /.test((e as Error).message)) { console.error(`Error: no rollout found for thread id ${session}`); process.exit(1); }
      throw e;
    }
  } else session = (await server.call("POST", "/session", { title: basename(process.cwd()) })).id;
  io.emit({ t: "session", id: session });

  server.child.on("exit", (code) => fail(`opencode serve exited (${code})`));
  // A turn the model gateway refuses (no credit, a bad key) comes back only as a session.error event after prompt_async's 204: loud, not a silent job.
  const sse = sseEvents(spec, io.emit, () => session, (why) => fail(`opencode turn failed: ${why}`));
  await server.events((ev) => sse.take(ev)).catch((e) => { fail(e); throw e; });

  const busy = async () => Boolean((await server.call("GET", "/session/status"))?.[session]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // One turn at a time: a prompt goes in once the session is idle, and the next waits for that turn to end. Dispatch counts a
  // comment delivered once it is in the inbox, so a comment not yet accepted by opencode is kept on disk (pending.json in the
  // state folder) and replayed by the next job of this session if the box is replaced first.
  queue.push({ text: spec.prompt, comment: false });
  void (async () => {
    // The text is kept exactly as dispatch delivered it (fenced when it is not the owner's): never stripped or re-wrapped here.
    for await (const c of io.comments()) { if (stopping) break; queue.push({ text: c.text, comment: true }); save(); }
  })().catch(fail);
  void (async () => {
    for (;;) {
      const next = queue[0];
      if (!next) { await sleep(200); continue; }
      while (await busy()) await sleep(300);
      if (stopping) return;   // a stop keeps the queued comment in pending.json for the next job
      sse.beginTurn();
      await server.call("POST", `/session/${session}/prompt_async`, { parts: [{ type: "text", text: next.text }] });
      queue.shift();
      save();
      for (let i = 0; i < 20 && !(await busy()); i++) await sleep(150);
      while (await busy()) await sleep(300);
      if (stopping) return;
      await sleep(300);   // the turn's last text event can trail the status that says idle
      sse.endTurn();
    }
  })().catch(fail);

  const lease = basename(leaseDir);
  const ttyd = startTerminal({ lease, leaseDir, port: Number(need("AIDENHQ_TERM_PORT")), sessionPort: port, session, credential: need("AIDENHQ_TERM_CREDENTIAL"), cwd: process.cwd(), env: serverEnv });
  // A terminal that never bound its port or died leaves a live session with no way in: loud, the kernel retries.
  ttyd.on("exit", (code) => fail(`ttyd exited (${code})`));
  process.on("exit", () => { ttyd.kill("SIGKILL"); spawnSync("tmux", ["kill-session", "-t", lease], { stdio: "ignore" }); });

  process.on("SIGTERM", async () => {
    stopping = true;
    keepUnread();
    try { await server.call("POST", `/session/${session}/abort`); } catch {}
    await server.stop();
    keepUnread();   // what arrived while the turn was aborting
    process.exit(143);
  });
}
