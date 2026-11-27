// The kernel's Paperclip plugin (services/paperclip-events): Paperclip's task events reach the kernel's wake inbox, and its
// `post` action lets the kernel write as an agent. Installed from its read-only mount, and reinstalled when its directory's
// content changes, when it errored, or when it is absent: Paperclip's GET /api/plugins reports only the manifest's version,
// and post.js has changed without a bump before (evidence/source scopes, #1958), so the version string alone misses it.
// Each agent's own Paperclip key is the kernel's to call that action with (kernel/src/outcomes.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { dirHash } from "./dir-hash.ts";
import { mapLimit } from "./modules.ts";
import type { Api } from "./record-agent.ts";

const PLUGIN_PATH = "/opt/aidenhq-events";
const PLUGIN_KEY = "aidenhq.events";

/** The plugin's version: manifest.js and package.json must agree (manifest.js's own comment), because setup keys the plugin
 * record on it; a mismatch fails setup here rather than installing a plugin that never updates. */
export async function pluginVersion(pluginDir: string) {
  const version = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).version;
  const manifest = (await import(pathToFileURL(join(pluginDir, "manifest.js")).href)).default;
  if (manifest?.version !== version) throw new Error(`${join(pluginDir, "manifest.js")} says version ${JSON.stringify(manifest?.version)} but package.json says ${JSON.stringify(version)}: keep them equal`);
  return version as string;
}

/** Installs the plugin from `pluginDir` unless Paperclip has it at `version`, without an error, and with the content
 * `stateFile` records: the directory hash of the last install, kept across applies since Paperclip can't report it.
 * `stateFile` may point into a directory that does not exist yet. */
export async function ensureEventsPlugin({ api, step, pluginDir, stateFile }: { api: Api; step: (msg: string) => void; pluginDir: string; stateFile: string }) {
  const version = await pluginVersion(pluginDir);
  const hash = dirHash(pluginDir);
  const installed = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "";
  const plugins = (await api("GET", "/api/plugins")).json;
  const mine = (Array.isArray(plugins) ? plugins : plugins.plugins ?? []).find((p: { pluginKey: string }) => p.pluginKey === PLUGIN_KEY);
  if (mine && mine.version === version && mine.status !== "error" && installed === hash) return;
  if (mine) await api("DELETE", `/api/plugins/${mine.id}`);
  await api("POST", "/api/plugins/install", { packageName: PLUGIN_PATH, isLocalPath: true });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, hash);
  step(`Installed the kernel's Paperclip plugin ${version} (${hash.slice(0, 12)})`);
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
