// The grading module's service: its rows in data/modules/grading/ (GRADES_DB), the kernel at AIDENHQ_KERNEL_URL with this
// module's own token (kernel.cp-read, kernel.grader, kernel.wake), the model gateway at AIDENHQ_GATEWAY_URL, and each caller's
// key from its own secret file.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.ts";
import { createServer } from "./server.ts";
import { createChecker, SCHEMA } from "./check.ts";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { LUNA, openRouterAsk } from "./aidenhq-sdk/judge.ts";

const log = (msg: string, f: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));
const file = (name: string) => readFileSync(process.env[name] ?? "", "utf8").trim();
const kernel = kernelClient(process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", file("GRADING_TOKEN_FILE"), { timeoutMs: 60_000 });
const gateway = `${(process.env.AIDENHQ_GATEWAY_URL ?? "http://10.231.0.1:8201").replace(/\/$/, "")}/api/v1/chat/completions`;

const db = new DatabaseSync(process.env.GRADES_DB ?? "/data/grades.sqlite");
db.exec("PRAGMA journal_mode = WAL");
const store = new Store(db);
const server = createServer({ store, issue: (ref) => kernel.read(`/api/issues/${encodeURIComponent(ref)}`), keys: { check: file("GRADING_CHECK_KEY_FILE"), board: file("GRADING_BOARD_KEY_FILE") }, log });
const port = Number(process.env.PORT ?? 8096);
server.listen(port, () => log("listening", { port }));

// The model call is billed to the task: the kernel mints a grader token for a closed task.
const ask = async (task: string, p: { system: string; user: string }) => {
  const { token } = await kernel.call("POST", "/v1/work/grader-token", { task });
  return openRouterAsk(token, { schema: SCHEMA, url: gateway, effort: "low" })(LUNA, p);
};
const checker = createChecker({ store, kernel: kernel.call, ask, model: LUNA, log });
let busy = false;
setInterval(() => {
  if (busy) return;
  busy = true;
  checker.pass().catch((e) => log("check pass failed", { err: String(e.message ?? e) })).finally(() => (busy = false));
}, 2 * 60_000).unref();
