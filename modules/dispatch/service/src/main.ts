// The dispatch module's service: its state in data/modules/dispatch/ (DISPATCH_DB), the kernel at AIDENHQ_KERNEL_URL with this
// module's own token. One tick at a time, every few seconds.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createKernel } from "./kernel.ts";
import { createDispatch } from "./loop.ts";

const log = (msg: string, f: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(f));
const token = readFileSync(process.env.DISPATCH_TOKEN_FILE ?? "", "utf8").trim();
const kernel = createKernel(process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", token);
const db = new DatabaseSync(process.env.DISPATCH_DB ?? "/data/dispatch.sqlite");
db.exec("PRAGMA journal_mode = WAL");
const dispatch = createDispatch({ kernel, db, owner: process.env.OWNER_NAME || "the owner", log });

async function loop() {
  await dispatch.tick().catch((e: Error) => log("tick failed", { err: e.message }));
  setTimeout(loop, 5000);
}
log("dispatching");
void loop();
