// The no-shell guard (gate code, paths.yaml): Codex's own sandbox cannot start in the
// Paperclip container, so a tool-only agent's boundary is "no shell". Setup (paperclip-setup.mjs) refuses any Codex agent
// without image: whose final args fail this check.

// The only Codex settings a tool-only agent may carry (an allowlist: anything else, e.g. a profile, fails closed).
const NO_SHELL_FLAGS = new Set(["--sandbox", "-s", "--skip-git-repo-check", "-c", "--config", "--model", "-m"]);
const NO_SHELL_KEYS = /^(features\.[a-z_]+|web_search|sandbox_mode|model|model_reasoning_effort|model_provider|model_providers\.[a-z_]+\.(base_url|env_key|name|wire_api)|mcp_servers\.[a-z_]+\.(enabled|enabled_tools))$/;

/** Refuses a tool-only (no image:) Codex agent unless it is read-only, has no shell, unified exec or apps, and every arg is allowlisted. */
export function assertNoShell(key, extraArgs, bypass) {
  const bad = (why) => { throw new Error(`agent ${key} has no image: (tool-only) but ${why}; give it an image: or fix codex_args`); };
  const args = extraArgs.map(String);
  const last = {};
  let sandbox;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (!NO_SHELL_FLAGS.has(x)) bad(`its Codex args contain ${x.split("=")[0]}, which is not allowed for a tool-only agent`);
    if (x === "--sandbox" || x === "-s") sandbox = args[++i];
    else if (x === "--model" || x === "-m") i++;
    else if (x === "-c" || x === "--config") {
      const v = args[++i] ?? "";
      const m = /^([a-z_]+(?:\.[a-z_]+)*)=(.*)$/.exec(v);
      if (!m || !NO_SHELL_KEYS.test(m[1])) bad(`its Codex args set -c ${v.split("=")[0]}, which is not allowed for a tool-only agent`);
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1].startsWith("features.") && val !== "false") bad(`${m[1]} is ${val}: a tool-only agent turns features off only`);
      if (/[{]/.test(val) || (val.includes("[") && !m[1].endsWith(".enabled_tools"))) bad(`-c ${m[1]} has a table or list value`);
      last[m[1]] = val;
    }
  }
  if (bypass) bad("dangerouslyBypassApprovalsAndSandbox is on");
  if (sandbox !== "read-only") bad(`its sandbox is ${sandbox ?? "unset"}, not read-only`);
  if (last.sandbox_mode !== undefined && last.sandbox_mode !== "read-only") bad(`sandbox_mode is ${last.sandbox_mode}`);
  for (const f of ["shell_tool", "unified_exec", "apps"]) if (last[`features.${f}`] !== "false") bad(`features.${f} is not false`);
}
