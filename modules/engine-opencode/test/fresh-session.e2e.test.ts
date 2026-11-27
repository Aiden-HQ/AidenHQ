// A fresh session: opencode 1.19.6 started by the engine from a job spec alone lists the gateway's models, configures no
// connection tools (they are code: the tool index is an instruction), and loads every plugin in plugins.json. Runs where opencode 1.19.6 is on
// PATH (the session image: `docker run --rm -v "$PWD":/m -w /m aidenhq/computer-session bun test test/fresh-session.e2e.test.ts`);
// elsewhere it is skipped. AIDENHQ_OPENCODE_PLUGINS defaults to the image's /opt/opencode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGateway } from "./fakes.ts";

const version = (() => { try { return execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
const plugins: string[] = JSON.parse(readFileSync(join(import.meta.dirname, "../plugins.json"), "utf8")).plugins;
const bin = join(import.meta.dirname, "bin");

test("a fresh session lists the expected models and plugins, and no connection tools", { skip: version === "1.19.6" ? false : `opencode 1.19.6 is not on PATH (found ${version || "none"})` }, async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-e2e-"));
  const [lease, state, work, home, shim] = ["l-e2e0", "state", "work/PEN-1", "home", "shim"].map((d) => join(root, d));
  const job = join(lease!, "job-1");
  for (const d of [job, state!, work!, home!, shim!]) mkdirSync(d, { recursive: true });
  // The terminal and setsid are the image's; where they are missing, the stand-ins are.
  for (const t of ["tmux", "ttyd", "setsid"]) { try { execFileSync("which", [t], { stdio: "ignore" }); } catch { symlinkSync(join(bin, t), join(shim!, t)); } }
  // The kernel places the agent's skills in the state folder.
  mkdirSync(join(state!, "skills/demo"), { recursive: true });
  writeFileSync(join(state!, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: A demo skill.\n---\nSay hi.\n");
  // A workspace's own opencode.json cannot change the engine's config.
  writeFileSync(join(work!, "opencode.json"), JSON.stringify({ disabled_providers: ["aidenhq"], plugin: ["left-pad"] }));
  const gw = await fakeGateway(28801);
  // The kernel's generated tool index (kernel/src/codemode.ts).
  mkdirSync(join(state!, "aidenhq-tools"), { recursive: true });
  writeFileSync(join(state!, "aidenhq-tools/README.md"), "# Your connections' tools\n");
  const spec = {
    contract: "engine@1", job: "j", agent: "a", task: "t", prompt: "hello", web: false, env: [], limits: { timeout_s: 0 }, state,
    model: { base_url: "http://127.0.0.1:28801/api/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "~deepseek/deepseek-flash-latest", effort: "high", models: ["openrouter/moonshotai/kimi-k3.1-pro"] },
    mcp: [], tools: { dir: join(state!, "aidenhq-tools"), index: join(state!, "aidenhq-tools/README.md") },
    sandbox: { kind: "box", writable: [], network: true },
  };
  writeFileSync(join(job, "job.json"), JSON.stringify(spec));
  const port = 28803;
  const child = spawn(join(import.meta.dirname, "../bin/engine"), [job], {
    cwd: work, stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PATH: `${process.env.PATH}:${shim}`, HOME: home, AIDENHQ_SESSION_PORT: String(port), AIDENHQ_TERM_PORT: String(port + 1), OPENCODE_SERVER_PASSWORD: "pw", AIDENHQ_TERM_CREDENTIAL: "u:p", AIDENHQ_RUN_TOKEN: "ahqj_e2e" },
  });
  const exited = new Promise((r) => child.on("exit", r));
  const call = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` } })).json() as Promise<any>;
  try {
    let providers: any;
    for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 300))) {
      try { providers = await call("/config/providers"); break; } catch { if (Date.now() > end) throw new Error("opencode never answered"); }
    }
    assert.deepEqual(providers.providers.map((p: any) => p.id), ["aidenhq"], "only our gateway is a provider");
    assert.deepEqual(Object.keys(providers.providers[0].models), ["~deepseek/deepseek-flash-latest", "moonshotai/kimi-k3.1-pro"]);
    assert.deepEqual(await call("/mcp"), {}, "no MCP server: connections are code");
    const config = await call("/config");
    assert.ok(config.instructions.includes(join(state!, "aidenhq-tools/README.md")), "the tool index is an instruction");
    for (const p of plugins) assert.ok(config.plugin.some((x: string) => x.endsWith(`/node_modules/${p.slice(0, p.lastIndexOf("@"))}`)), `${p} is configured`);
    assert.ok(!config.plugin.includes("left-pad"), "a workspace's plugin is not loaded");
    assert.ok((await call("/skill")).some((k: any) => k.name === "demo"), "the agent's skills are listed");
    const tools: string[] = await call("/experimental/tool/ids");
    assert.ok(tools.includes("pty_spawn") && tools.includes("compress"), "the plugins' tools are loaded");   // opencode-pty, opencode-dcp
    assert.ok(!tools.some((x) => /task_comment|github|slack/.test(x)), "no connection tool is native");
    for (const end = Date.now() + 20_000; !gw.seen.some((s) => s.model === "~deepseek/deepseek-flash-latest") && Date.now() < end; await new Promise((r) => setTimeout(r, 200)));
    assert.ok(gw.seen.some((s) => s.model === "~deepseek/deepseek-flash-latest" && s.effort === "high"), "the first prompt reached the gateway with the agent's effort");
    assert.ok(gw.seen.every((s) => s.auth === "Bearer ahqj_e2e"), "model calls carry the run token");
  } finally {
    child.kill("SIGTERM");
    await exited;
    gw.close();
  }
});
