// The kernel's Paperclip plugin (services/paperclip-events): Paperclip's task events reach the kernel's wake inbox, and its
// `post` action lets the kernel write as an agent. Installed from its read-only mount, and reinstalled when its version
// changes or it errored. Each agent's own Paperclip key is the kernel's to call that action with (kernel/src/outcomes.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Api } from "./record-agent.ts";

const PLUGIN_PATH = "/opt/aidenhq-events";
const PLUGIN_KEY = "aidenhq.events";

export async function ensureEventsPlugin({ api, step, version }: { api: Api; step: (msg: string) => void; version: string }) {
  const plugins = (await api("GET", "/api/plugins")).json;
  const mine = (Array.isArray(plugins) ? plugins : plugins.plugins ?? []).find((p: { pluginKey: string }) => p.pluginKey === PLUGIN_KEY);
  if (mine && mine.version === version && mine.status !== "error") return;
  if (mine) await api("DELETE", `/api/plugins/${mine.id}`);
  await api("POST", "/api/plugins/install", { packageName: PLUGIN_PATH, isLocalPath: true });
  step(`Installed the kernel's Paperclip plugin ${version}`);
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
  for (const [key, a] of Object.entries(agents)) {
    const file = join(dir, a.id);
    const existing = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (existing) {
      const res = await fetch(new URL("/api/agents/me", baseUrl), { headers: { authorization: `Bearer ${existing}` } });
      if (res.ok && (await res.json()).id === a.id) continue;
    }
    const { json } = await api("POST", `/api/agents/${a.id}/keys`, { name: "aidenhq-kernel" });
    rmSync(file, { force: true });
    writeFileSync(file, json.token, { mode: 0o400 });
    step(`Minted the kernel's Paperclip key for ${key}`);
  }
}
