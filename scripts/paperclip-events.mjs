// The paperclip-events plugin (services/paperclip-events): Paperclip's task events reach the kernel's wake inbox. Installed
// from its read-only mount, and reinstalled when its version changes or it errored.
const PLUGIN_PATH = "/opt/aidenhq-events";
const PLUGIN_KEY = "aidenhq.events";

export async function ensureEventsPlugin({ api, step, version }) {
  const plugins = (await api("GET", "/api/plugins")).json;
  const mine = (Array.isArray(plugins) ? plugins : plugins.plugins ?? []).find((p) => p.pluginKey === PLUGIN_KEY);
  if (mine && mine.version === version && mine.status !== "error") return;
  if (mine) await api("DELETE", `/api/plugins/${mine.id}`);
  await api("POST", "/api/plugins/install", { packageName: PLUGIN_PATH, isLocalPath: true });
  step(`Installed the wake events plugin ${version}`);
}
