// The adapter config Paperclip's new-agent check (its harness hello probe) runs with. Paperclip probes an agent outside any run,
// in an empty home, and keeps a new agent paused until the probe passes; the runner never dispatches to a paused agent.

/** Without the `-c mcp_servers.<x>.…` pairs: in the probe's empty CODEX_HOME there are no such servers, so they are invalid. */
export const dropMcpScoping = (args = []) => args.filter((x, i) => !String(x).startsWith("mcp_servers.") && !(x === "-c" && String(args[i + 1]).startsWith("mcp_servers.")));

/**
 * A Codex agent probes with plain `codex` (the codex-model launcher skips the probe). An OpenCode runner agent probes with
 * `opencode`, on the model gateway with its harness key: with `codex` the probe fails on `--format`, and with no key on auth
 * (the App Engineer stayed paused, 2026-11-13). `codexArgs` gives the gateway (model_providers.or.base_url).
 */
export function probeConfig(adapterType, adapterConfig, { codexArgs = [], harnessSecretId } = {}) {
  if (adapterType !== "opencode_local") return { ...adapterConfig, command: "codex", extraArgs: dropMcpScoping(adapterConfig.extraArgs) };
  const baseURL = /^model_providers\.or\.base_url="?([^"]+)"?$/.exec(codexArgs.map(String).find((x) => x.startsWith("model_providers.or.base_url=")) ?? "")?.[1];
  if (!baseURL || !harnessSecretId) throw new Error("an OpenCode agent's check needs the model gateway (codex_args model_providers.or.base_url) and the gateway_harness_key secret");
  return {
    ...adapterConfig,
    command: "opencode",
    env: {
      OPENROUTER_API_KEY: { type: "secret_ref", secretId: harnessSecretId, version: "latest" },
      OPENCODE_CONFIG_CONTENT: { type: "plain", value: JSON.stringify({ provider: { openrouter: { options: { baseURL } } } }) },
    },
  };
}

/**
 * Waits on Paperclip's check of a new or reconfigured agent, up to `ms`: true once it leaves preparing/verifying. A failed
 * probe (lifecycleError) is waited through: Paperclip tries again by itself a minute later, and a new key's first call can
 * fail. `get` reads the agent.
 */
export async function awaitVerified(get, { ms = 180_000, every = 2_000, sleep = (t) => new Promise((r) => setTimeout(r, t)) } = {}) {
  for (let waited = 0; ; waited += every) {
    if (!["preparing", "verifying"].includes((await get()).lifecycleState)) return true;
    if (waited >= ms) return false;
    await sleep(every);
  }
}
