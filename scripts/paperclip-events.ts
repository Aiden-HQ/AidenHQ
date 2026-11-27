// The kernel's Paperclip plugin (services/paperclip-events): Paperclip's task events reach the kernel's wake inbox, and its
// `post` action lets the kernel write as an agent. Installed from its read-only mount, and reinstalled when the hash of its
// files differs from the one stamped at the last install (the manifest version is only a label), or when it errored. Each agent's own Paperclip key is the kernel's to call that action with (kernel/src/outcomes.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mapLimit } from "./modules.ts";
import type { Api } from "./record-agent.ts";

const PLUGIN_PATH = "/opt/aidenhq-events";
const PLUGIN_KEY = "aidenhq.events";

/** Hash of every file under `dir` (relative path and bytes, sorted): what the install copies, so a changed file changes it. */
export function hashTree(dir: string): string {
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => !f.split("/").includes("node_modules") && statSync(join(dir, f)).isFile()).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(dir, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** `pluginDir`: the plugin's source (the mount's host side). `stampFile`: where the installed hash is kept (Paperclip's record keeps only the manifest version). */
export async function ensureEventsPlugin({ api, step, pluginDir, stampFile }: { api: Api; step: (msg: string) => void; pluginDir: string; stampFile: string }) {
  const hash = hashTree(pluginDir);
  const plugins = (await api("GET", "/api/plugins")).json;
  const mine = (Array.isArray(plugins) ? plugins : plugins.plugins ?? []).find((p: { pluginKey: string }) => p.pluginKey === PLUGIN_KEY);
  const stamped = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : "";
  if (mine && stamped === hash && mine.status !== "error") return;
  if (mine) await api("DELETE", `/api/plugins/${mine.id}`);
  await api("POST", "/api/plugins/install", { packageName: PLUGIN_PATH, isLocalPath: true });
  writeFileSync(stampFile, hash);
  step(`Installed the kernel's Paperclip plugin ${hash}`);
}

/**
 * One Paperclip key per agent, at <secrets>/paperclip-agents/<agentId> (0400, read by the kernel only): kept while it still
 * answers as that agent, minted otherwise; a removed agent's file is deleted. `agents`: key → {id}.
 */
export async function ensureAgentKeys({ api, agents, secretsDir, baseUrl, step }: { api: Api; agents: Record<string, { id: string }>; secretsDir: string; baseUrl: string; step: (msg: string) => void }) {
  const dir = join(secretsDir, "paperclip-agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ids = new Set(Object.values(agents).map((a) => a.id));
  for (const f of readdirSync(dir)) if (!ids.has(f)) rmSync(join(dir, f), { force: true });
  // Each agent's check (and mint) is independent of the next one's: a few side by side.
  await mapLimit(Object.entries(agents), 8, async ([key, a]: [string, { id: string }]) => {
    const file = join(dir, a.id);
    const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (existing) {
      const res = await fetch(new URL("/api/agents/me", baseUrl), { headers: { authorization: `Bearer ${existing}` } });
      if (res.ok && (await res.json()).id === a.id) return;
    }
    const { json } = await api("POST", `/api/agents/${a.id}/keys`, { name: "aidenhq-kernel" });
    rmSync(file, { force: true });
    writeFileSync(file, json.token, { mode: 0o400 });
    step(`Minted the kernel's Paperclip key for ${key}`);
  });
}
