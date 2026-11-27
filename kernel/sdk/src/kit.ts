// The contract kit (engine part): runs each engine a module declares on a temp job dir with a fake spec and checks what
// engine@1 promises. Throws with what failed.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { appendLine, lines, readFrom } from "./engine-io.ts";
import type { EngineEvent, JobSpec } from "./types.ts";

export interface EngineDecl { kind: string; bin: string; live_input?: boolean }

/** `yaml` from the module's own dependencies, else from each NODE_PATH entry (named here: not every runtime reads NODE_PATH itself). */
function requireYaml(moduleDir: string) {
  try { return createRequire(join(moduleDir, "module.yaml"))("yaml"); } catch (e) {
    for (const dir of (process.env.NODE_PATH ?? "").split(":").filter(Boolean)) {
      try { return createRequire(join(resolve(dir), "x.js"))("yaml"); } catch {}
    }
    throw e;
  }
}

/** The engines a module declares. module.yaml is read with the `yaml` package, from the module's own dependencies or NODE_PATH. */
export function engineDecls(moduleDir: string): EngineDecl[] {
  const YAML = requireYaml(moduleDir);
  const def = YAML.parse(readFileSync(join(moduleDir, "module.yaml"), "utf8")) ?? {};
  const list = [def.providers?.engine ?? []].flat();
  if (!list.length) throw new Error(`${moduleDir}: module.yaml declares no providers.engine`);
  return list;
}

const events = (dir: string) => lines(readFrom(join(dir, "events.jsonl"))).values as EngineEvent[];

/** One turn of an engine; resolves with its exit code and events. */
export async function turn(moduleDir: string, decl: EngineDecl, { session, env = {}, comment, timeoutMs = 30_000 }: { session?: string; env?: Record<string, string>; comment?: string; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aidenhq-kit-"));
  const [job, work, state] = ["job", "work", "state"].map((d) => join(root, d));
  for (const d of [job, work, state]) mkdirSync(d);
  const spec: JobSpec = {
    contract: "engine@1", job: "kit-1", agent: "agent-kit", task: "task-kit", prompt: "Kit: answer ok.", ...(session ? { session } : {}),
    model: { base_url: "http://127.0.0.1:9/api/v1", token_env: "AIDENHQ_MODEL_TOKEN", id: "kit-model", effort: "" },
    mcp: [], env: [], limits: { timeout_s: 60 }, web: true, state, sandbox: { kind: "box", writable: [work], network: true },
  };
  writeFileSync(join(job, "job.json"), JSON.stringify(spec));
  try {
    const child = spawn(join(moduleDir, decl.bin), [job], { cwd: work, env: { ...process.env, AIDENHQ_MODEL_TOKEN: "kit-token", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const poke = comment ? setInterval(() => {
      if (events(job).length) appendLine(join(job, "inbox.jsonl"), { t: "comment", from: "kit", text: comment }), clearInterval(poke);
    }, 50) : undefined;
    const code = await new Promise<number | null>((res) => {
      const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("exit", (c) => (clearTimeout(t), res(c)));
    });
    clearInterval(poke);
    return { code, events: events(job), out };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every engine the module declares: a final event and exit 0, a live comment echoed, a reported session resumed. */
export async function engineKit(moduleDir: string, env: Record<string, string> = {}) {
  for (const decl of engineDecls(moduleDir)) {
    const where = `${decl.kind}:`;
    const first = await turn(moduleDir, decl, { env, comment: decl.live_input ? "kit comment" : undefined });
    if (first.code !== 0) throw new Error(`${where} exit ${first.code}\n${first.out}`);
    if (!first.events.some((e) => e.t === "final")) throw new Error(`${where} no final event\n${first.out}`);
    if (decl.live_input && !first.events.some((e) => e.t === "progress" && e.text.includes("kit comment"))) throw new Error(`${where} the live comment never came back`);
    const session = first.events.find((e) => e.t === "session") as { id: string } | undefined;
    if (!session) throw new Error(`${where} no session event`);
    const second = await turn(moduleDir, decl, { env, session: session.id });
    const resumed = second.events.find((e) => e.t === "session") as { id: string } | undefined;
    if (second.code !== 0 || resumed?.id !== session.id) throw new Error(`${where} the session ${session.id} was not resumed (got ${resumed?.id})\n${second.out}`);
  }
}
