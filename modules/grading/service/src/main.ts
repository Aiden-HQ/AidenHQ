// The grading module's service: its rows in data/modules/grading/ (GRADES_DB), the kernel at AIDENHQ_KERNEL_URL with this
// module's own token, and each caller's key from its own secret file.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createGrading, type Kernel } from "./server.ts";
import { createKernelGradeLoop } from "./kernel-loop.ts";

const log = (msg: string, f: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));
const file = (name: string) => readFileSync(process.env[name] ?? "", "utf8").trim();
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const token = file("GRADING_TOKEN_FILE");

async function kernelCall(method: string, path: string, body?: unknown) {
  const r = await fetch(`${kernelUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`kernel ${method} ${path} → ${r.status}: ${JSON.stringify(json).slice(0, 200)}`), { status: r.status });
  return json;
}
async function kernelBytes(path: string) {
  const r = await fetch(`${kernelUrl}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw Object.assign(new Error(`kernel GET ${path} → ${r.status}`), { status: r.status });
  return Buffer.from(await r.arrayBuffer());
}
const kernel: Kernel = {
  issue: (ref) => kernelCall("GET", `/v1/cp/read/api/issues/${encodeURIComponent(ref)}`),
  settings: async () => (await kernelCall("GET", "/v1/agents")).settings ?? {},
  release: async (task) => void (await kernelCall("POST", `/v1/checks/${encodeURIComponent(task)}`, { verdict: "release" })),
};

const db = new DatabaseSync(process.env.GRADES_DB ?? "/data/grades.sqlite");
db.exec("PRAGMA journal_mode = WAL");
const { server, tick, runner, grades } = createGrading({ db, kernel, keys: { check: file("GRADING_CHECK_KEY_FILE"), runner: file("GRADING_RUNNER_KEY_FILE"), board: file("GRADING_BOARD_KEY_FILE") }, log });
const port = Number(process.env.PORT ?? 8096);
server.listen(port, () => log("listening", { port }));
setInterval(() => void tick(), 5 * 60_000).unref();
setTimeout(() => void tick(), 30_000).unref();

// The grade loop on the kernel's jobs (kernel-loop.ts), once a minute: roles kernel.cp-read, kernel.work-read, kernel.grader and kernel.wake.
const loop = createKernelGradeLoop({ db, runner, due: () => ({ grades: grades.due(), resubmitted: grades.resubmitted() }), kernel: kernelCall, kernelBytes, gatewayUrl: process.env.AIDENHQ_GATEWAY_URL ?? "http://10.231.0.1:8201", log });
let grading = false;
setInterval(() => { if (!grading) { grading = true; loop.runGrades().catch((e) => log("grade loop failed", { err: String(e.message ?? e) })).finally(() => (grading = false)); } }, 60_000).unref();
