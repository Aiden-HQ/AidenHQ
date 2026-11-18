#!/usr/bin/env node
// A stand-in for `docker exec` into a job's box (kernel/src/sandbox.ts buildJob), for tests: the box is a record beside its env
// file (<container>.box.json: its task folder `workspace`, its out folder `outDir`, its engine module `engineDir`, or
// `gone`/`die`), and the command runs on the host with the box's paths mapped back: /workspace (the cwd) to the task folder,
// /aidenhq-out to the out folder, /opt/aidenhq/engine to the engine's module. Its env is the env file's and the names passed
// with -e from this client's env.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
if (args[0] !== "exec") { console.error(`fake docker: only exec (got ${args[0]})`); process.exit(2); }
let i = 1, envFile, cwd = "/";
const pass = [];
for (; i < args.length && args[i].startsWith("-"); i++) {
  if (args[i] === "--env-file") envFile = args[++i];
  else if (args[i] === "-e") pass.push(args[++i]);
  else if (args[i] === "-w") cwd = args[++i];
}
const container = args[i];
// Beside the env file; a plain exec (a fast check in the box) names only the container: $FAKE_BOXES holds the records then.
const file = envFile ? envFile.replace(/\.env$/, ".box.json") : process.env.FAKE_BOXES ? join(process.env.FAKE_BOXES, `${container}.box.json`) : "";
const box = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { gone: true };
if (box.gone || box.die) {
  console.error(`Error response from daemon: container ${container} is not running`);
  process.exit(1);
}
const hostOf = (p) => {
  if (p === "/workspace" || p.startsWith("/workspace/")) return box.workspace + p.slice("/workspace".length);
  if (p === "/aidenhq-out" || p.startsWith("/aidenhq-out/")) return box.outDir + p.slice("/aidenhq-out".length);
  if (p.startsWith("/opt/aidenhq/engine/")) return join(isAbsolute(box.engineDir) ? box.engineDir : join(ROOT, box.engineDir), p.slice("/opt/aidenhq/engine/".length));
  return p;
};
const env = {};
for (const line of envFile ? readFileSync(envFile, "utf8").split("\n") : []) { const at = line.indexOf("="); if (at > 0) env[line.slice(0, at)] = line.slice(at + 1); }
for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k];
env.PATH ??= process.env.PATH;
const [cmd, ...rest] = args.slice(i + 1).map(hostOf);
const child = spawn(cmd, rest, { cwd: hostOf(cwd), env, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
