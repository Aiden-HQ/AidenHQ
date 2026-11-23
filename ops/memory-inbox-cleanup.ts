#!/usr/bin/env node
// One-time manual cleanup (agent anatomy, after the deploy that moved memory into the kernel): the old per-agent memory inbox
// tasks (setup's marker `<!-- source:memory-inbox:<key> -->`) have no writer or reader any more. Each open one is cancelled
// with one comment. Run on the host by hand, never from the apply.
//   node ops/memory-inbox-cleanup.ts            prints what it would cancel (nothing changes)
//   node ops/memory-inbox-cleanup.ts --apply    cancels them
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paperclipClient } from "../kernel/sdk/src/paperclip.ts";

const MARKER = /<!-- source:memory-inbox:([\w-]+) -->/;
const NOTE = "Closed: agent memory now lives in the kernel (memory_note writes it at once), so this inbox has no reader. Nothing here is lost: the curated memory was imported.";

const apply = process.argv.includes("--apply");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.AIDENHQ_ENV_FILE ?? join(repo, ".env");
const dotenv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m): [string, string] => [m![1]!, m![2]!.replace(/^["']|["']$/g, "")]))
  : {};
const env = (k: string, d: string) => process.env[k] ?? dotenv[k] ?? d;
const secrets = env("AIDENHQ_SECRETS_DIR", "~/.config/aidenhq").replace(/^~\//, `${homedir()}/`);
const paperclip = paperclipClient({ url: env("PAPERCLIP_URL", "http://127.0.0.1:3100"), token: readFileSync(join(secrets, "paperclip_board_key"), "utf8").trim(), lane: "direct" });
const api = (method: string, path: string, body?: unknown) => paperclip.request(method, path, body);

// Setup's inbox: its title, its marker naming the same agent key, and no agent as its creator (setup filed it as the board).
const inbox = (i: { title?: string; description?: string; createdByAgentId?: string | null }) => {
  const key = MARKER.exec(String(i.description ?? ""))?.[1];
  return Boolean(key) && i.title === `Memory inbox: ${key}` && !i.createdByAgentId;
};
let n = 0;
for (const company of await api("GET", "/api/companies")) {
  // Every open task, a page at a time.
  const open: { id: string; identifier?: string; title?: string; description?: string; createdByAgentId?: string | null }[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await api("GET", `/api/companies/${company.id}/issues?status=backlog,todo,in_progress,in_review,blocked&limit=500&offset=${offset}`);
    open.push(...page);
    if (page.length < 500) break;
  }
  for (const t of open.filter(inbox)) {
    n++;
    console.log(`${apply ? "cancelled" : "would cancel"} ${t.identifier ?? t.id} "${t.title}"`);
    if (apply) await api("PATCH", `/api/issues/${t.id}`, { status: "cancelled", comment: NOTE });
  }
}
console.log(`${n} memory inbox task${n === 1 ? "" : "s"} ${apply ? "cancelled" : "to cancel (run with --apply)"}.`);
