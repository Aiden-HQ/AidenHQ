// The computer launcher's logic, kept free of Docker and HTTP so it can be tested: run tokens, the env an exec gets, the Codex
// config the box gets, and the `docker run` line. launcher.mjs wires it up.
import { randomBytes } from "node:crypto";

const RUN_TOKEN_PREFIX = "ahqc_"; // services/shared/agent-auth.ts resolves these through /whoami
const RUN_TOKEN_ENV = "AIDENHQ_RUN_TOKEN";
const MCP_BLOCK_ENV = "AIDENHQ_MCP_B64";
const TOKEN_TTL_MS = 6 * 3600_000; // longer than any run (Paperclip's sandbox backstop is 4 h)

// The box's shell tools (repo-checkout) read the current run token here, not from the env: the Codex shell allowlist drops
// a launcher-issued *TOKEN* variable, so an env-only token reaches the model and MCP clients but not the shell.
// /dev/shm is the box's tmpfs (Docker's --shm-size): the file cannot outlive a stopped box, and release removes it too.
export const RUN_TOKEN_PATH = "/dev/shm/aidenhq/run-token";
export const WRITE_RUN_TOKEN_SCRIPT = `mkdir -p /dev/shm/aidenhq && chmod 700 /dev/shm/aidenhq && cat > ${RUN_TOKEN_PATH} && chmod 600 ${RUN_TOKEN_PATH}`;
export const CLEAR_RUN_TOKEN_SCRIPT = `rm -f ${RUN_TOKEN_PATH}`;

/** Run tokens: one live token per container, issued when a run starts there, gone when it ends. */
export class Tokens {
  #byToken = new Map(); // token → { container, agentId, at }
  #byContainer = new Map(); // container → token
  issue(container, agentId, now = Date.now()) {
    this.revoke(container);
    const token = RUN_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    this.#byToken.set(token, { container, agentId, at: now });
    this.#byContainer.set(container, token);
    return token;
  }
  revoke(container) {
    const t = this.#byContainer.get(container);
    if (t) this.#byToken.delete(t);
    this.#byContainer.delete(container);
  }
  current(container) { return this.#byContainer.get(container); }
  /** The live tokens as plain data, to survive a launcher restart (the box's env file holds its token). */
  dump() { return [...this.#byToken].map(([token, v]) => ({ token, ...v })); }
  load(rows, now = Date.now()) {
    for (const r of rows) if (r?.token?.startsWith(RUN_TOKEN_PREFIX) && now - r.at <= TOKEN_TTL_MS) { this.#byToken.set(r.token, { container: r.container, agentId: r.agentId, at: r.at }); this.#byContainer.set(r.container, r.token); }
  }
  whoami(token, now = Date.now()) {
    const hit = typeof token === "string" ? this.#byToken.get(token) : undefined;
    if (!hit) return undefined;
    if (now - hit.at > TOKEN_TTL_MS) { this.revoke(hit.container); return undefined; }
    return { agentId: hit.agentId, container: hit.container };
  }
}

const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : JSON.stringify(String(v)));

/**
 * The agent's granted connections as Codex config, for the box only: HTTP ones through the gateway with the run token as
 * X-Agent-Key; stdio ones (the tasks bridge) as they are. Wrapped in markers so applying it twice replaces it.
 */
export function mcpBlock(tools, connections, gatewayUrl) {
  const lines = ["# >>> aidenhq-computer (written by the launcher)"];
  for (const [name, list] of Object.entries(tools ?? {})) {
    const c = connections[name];
    if (!c || !/^[a-z0-9_]+$/.test(name)) continue;
    lines.push(`[mcp_servers.${name}]`);
    if (c.url) lines.push(`url = ${toml(`${gatewayUrl}/c/${name}/mcp`)}`, `env_http_headers = { "X-Agent-Key" = ${toml(RUN_TOKEN_ENV)} }`);
    else lines.push(`command = ${toml(c.command)}`, `args = ${toml(c.args ?? [])}`, `env_vars = ${toml(c.env_vars ?? [])}`);
    lines.push(`enabled_tools = ${toml(list)}`, "startup_timeout_sec = 20", `tool_timeout_sec = ${Number(c.tool_timeout_sec) || 300}`, 'default_tools_approval_mode = "approve"', "");
  }
  lines.push("# <<< aidenhq-computer", "");
  return lines.join("\n");
}

// Paperclip hands some execs its own server env (seen live: BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET, PAPERCLIP_AGENT_PRIVATE_KEY,
// PAPERCLIP_SECRETS_MASTER_KEY_FILE, PAPERCLIP_GITHUB_BROKER_TOKEN, every compose secret). None of it may enter a box. The run's own
// bridge credential stays (PAPERCLIP_API_KEY, PAPERCLIP_BRIDGE_TOKEN: valid only on the box's own bridge).
const SERVER_SECRET = /SECRET|PRIVATE|MASTER_KEY|PASSWORD|(^|_)TOKEN$|DATABASE_URL/;
const BOX_KEYS = new Set(["PAPERCLIP_BRIDGE_TOKEN"]);

/**
 * A routine's own model and reasoning effort (AIDENHQ_MODEL, AIDENHQ_REASONING_EFFORT in the exec's env, which execEnv then strips)
 * swapped into a `codex exec` for the agent's: the box's equivalent of services/paperclip-tasks-mcp/codex-model.
 */
export function routineArgs(command, args, env) {
  const model = env?.AIDENHQ_MODEL, effort = env?.AIDENHQ_REASONING_EFFORT;
  if (!/(^|\/)codex$/.test(command) || args[0] !== "exec" || (!model && !effort)) return args;
  const out = ["exec", ...(model ? ["--model", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
  for (let i = 1; i < args.length; i++) {
    if (model && args[i] === "--model" && i + 1 < args.length) { i++; continue; }
    if (effort && args[i] === "-c" && String(args[i + 1]).startsWith("model_reasoning_effort=")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/**
 * What an exec in a box gets: Paperclip's env minus every real secret (the OpenRouter key from adapterConfig, our AIDENHQ_* tokens),
 * plus this run's token; with CODEX_HOME, the agent's Codex config as base64 for the wrapper.
 */
export function execEnv(env, { token, mcp }) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (k === "OPENROUTER_API_KEY" || k.startsWith("AIDENHQ_") || (SERVER_SECRET.test(k) && !BOX_KEYS.has(k))) continue;
    out[k] = String(v);
  }
  if ("OPENAI_API_KEY" in out) out.OPENAI_API_KEY = "unused"; // Codex wants one even on OpenRouter; never a real one
  if (token) out[RUN_TOKEN_ENV] = token;
  if (out.CODEX_HOME && mcp) out[MCP_BLOCK_ENV] = Buffer.from(mcp).toString("base64");
  return out;
}

// Before anything runs with a CODEX_HOME: drop Paperclip's managed MCP block (its gateway JWTs) and our shared block from the box's
// config.toml, append this agent's granted servers, and refuse to start if a JWT is still there.
export const CODEX_CONFIG_SCRUB = [
  'f="$CODEX_HOME/config.toml"',
  'mkdir -p "$CODEX_HOME"',
  "if [ -f \"$f\" ]; then sed -e '/^# BEGIN PAPERCLIP MANAGED MCP/,/^# END PAPERCLIP MANAGED MCP/d' -e '/^# >>> aidenhq/,/^# <<< aidenhq/d' \"$f\" > \"$f.aidenhq\" && mv \"$f.aidenhq\" \"$f\" || exit 97; fi",
  `[ -n "$${MCP_BLOCK_ENV}" ] && printf '%s' "$${MCP_BLOCK_ENV}" | base64 -d >> "$f"`,
  `unset ${MCP_BLOCK_ENV}`,
  "if [ -f \"$f\" ] && grep -q 'eyJ' \"$f\"; then echo 'aidenhq: a token is still in the Codex config; refusing to start' >&2; exit 97; fi",
  'exec "$@"',
].join("\n");

/** [command, args] for docker exec: wrapped in the scrub when the exec carries a CODEX_HOME. */
export function wrapExec(command, args, env) {
  return env?.CODEX_HOME ? ["sh", ["-c", CODEX_CONFIG_SCRUB, "aidenhq-computer", command, ...(args ?? [])]] : [command, args ?? []];
}

/** `docker run` arguments: image, limits, network and mounts all come from the launcher's own config. */
export function dockerRunArgs({ name, image, agentId, network, limits, mounts }) {
  const args = ["run", "-d", "--name", name, "--runtime=runsc", "--network", network,
    "--memory", limits.memory, "--memory-swap", limits.memory, "--cpus", String(limits.cpus), "--shm-size", limits.shm, "--pids-limit", String(limits.pids),
    "--label", "aidenhq.computer=1", "--label", `aidenhq.agent=${agentId}`, "-e", "HOME=/root", "-w", "/workspace"];
  for (const m of mounts) args.push("-v", m);
  args.push(image, "sleep", "infinity");
  return args;
}

/**
 * Admission: with `max` boxes already up, the least recently used idle one (no exec in flight) is evicted; none idle → wait.
 * Returns the container to evict, or null when there is room, or "wait".
 */
export function admit(boxes, max) {
  if (boxes.size < max) return null;
  const idle = [...boxes].filter(([, b]) => !b.busy).sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
  return idle.length ? idle[0][0] : "wait";
}

/** The live box of this agent (the busy one, else the latest used), for reading its session log. */
export function boxOf(boxes, agentId) {
  return [...boxes].filter(([, b]) => b.agentId === agentId).sort(([, a], [, b]) => (b.busy ? 1 : 0) - (a.busy ? 1 : 0) || b.lastUsed - a.lastUsed)[0]?.[0];
}

/** Last lines of the newest Codex session log in a box (sh -c). */
export const PROGRESS_SCRIPT = 'f=$(ls -t $(find /workspace/.paperclip-runtime/codex/home/sessions -name "rollout-*.jsonl" 2>/dev/null) 2>/dev/null | head -1); [ -n "$f" ] && tail -n 400 "$f"';

/** Boxes idle longer than idleMs. */
export const stale = (boxes, idleMs, now = Date.now()) => [...boxes].filter(([, b]) => !b.busy && now - b.lastUsed > idleMs).map(([n]) => n);

/**
 * The run's own Paperclip credential, from an exec's env: the per-run bridge token and the box's bridge URL (127.0.0.1 inside the
 * box; the token only works there, and Paperclip forwards with the run's identity) and the run's task. Kept per box for /reply.
 */
export function runCredential(env) {
  const apiUrl = env?.PAPERCLIP_API_URL, apiKey = env?.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) return undefined;
  return { apiUrl: String(apiUrl), apiKey: String(apiKey), taskId: env.PAPERCLIP_TASK_ID ? String(env.PAPERCLIP_TASK_ID) : undefined };
}

/** Why a reply can't be posted for this run (null: it can). A run posts only on its own task; for a chat run that is the chat. */
export function replyRefusal(cred, issueId, body) {
  if (!cred) return "this run has no Paperclip credential (no exec from Paperclip yet, or the run ended)";
  if (typeof body !== "string" || !body.trim()) return "a reply needs a body";
  if (typeof issueId !== "string" || !cred.taskId || issueId !== cred.taskId) return "a run may reply only on its own task";
  return null;
}

/** Runs in the box (node): posts the comment through the box's bridge. Everything, the key included, comes on stdin. */
export const REPLY_SCRIPT = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const r=JSON.parse(s);try{const res=await fetch(new URL("/api/issues/"+encodeURIComponent(r.issueId)+"/comments",r.url),{method:"POST",headers:{authorization:"Bearer "+r.key,"content-type":"application/json"},body:JSON.stringify({body:r.body}),signal:AbortSignal.timeout(25000)});console.log(res.status);process.exit(res.ok?0:1)}catch(e){console.log("error "+e.message);process.exit(1)}});`;

/**
 * A long control call (the agent's whole turn is one /exec): headers go out at once and a space every interval, then the
 * JSON result (or `{error, status}`). Node's fetch abandons a request with no headers, or a body silent, for 5 minutes, so
 * an Agent Architect turn past 5 min used to fail with "fetch failed" and lose its computer (2026-11-11).
 */
export async function answerSlowly(res, work, intervalMs = 60_000) {
  res.writeHead(200, { "content-type": "application/json" });
  const ping = setInterval(() => res.write(" "), intervalMs);
  try {
    const out = await work;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.end(JSON.stringify({ error: e.message, status: e.status ?? 500 }));
  } finally {
    clearInterval(ping);
  }
}

const refused = (status, msg) => Object.assign(new Error(msg), { status });

/**
 * A box's `repo-checkout` request (POST /repo on the gateway), checked: a repo in the agents org and a full commit SHA. The
 * snapshot comes from the runner's cache clone (<runner work_dir>/repos/<org>/<name>, kept fetched with the runner's GitHub
 * App token), so no token goes near the box; the launcher, never the caller, picks the folder in the box.
 * Returns { cache, sha?, dest }, or throws with a message for the agent.
 */
export function checkoutRequest(body, { agentsOrg, cacheRoot }) {
  const m = /^([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_-][A-Za-z0-9_.-]*)$/.exec(String(body?.repo ?? "").trim());
  if (!m) throw refused(400, "give the repository as org/name");
  if (!agentsOrg || m[1].toLowerCase() !== agentsOrg.toLowerCase()) throw refused(403, `only repositories in the agents org (${agentsOrg || "none configured"})`);
  // No SHA: the default branch as the runner's copy last saw it (the launcher resolves it).
  const sha = String(body?.sha ?? "").trim().toLowerCase() || undefined;
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw refused(400, "give the full 40-character commit SHA (e.g. the PR's head), or none for the default branch");
  const name = m[2].replace(/\.git$/, "");
  return { cache: `${cacheRoot}/${agentsOrg}/${name}`, sha, dest: `/workspace/repos/${name}` };
}

/** Runs in the box (sh -c, $1 = the folder): replaces the folder with the tar on stdin. */
export const UNTAR_SCRIPT = 'rm -rf "$1" && mkdir -p "$1" && tar -x --no-same-owner -C "$1"';

/**
 * What OpenRouter billed for one model call, read as the answer streams past the gateway: the `response.completed` event of
 * an SSE stream (or a plain JSON answer) carries the generation id and the usage, its cost included.
 * feed() takes the text as it arrives; done() gives { key, model, input (uncached), cached, output, costUsd }, or undefined.
 * The model is the one OpenRouter answered with (the resolved slug, e.g. deepseek/deepseek-v4.1-flash-1017), never the request's.
 */
export function usageTap() {
  let tail = "";
  let found;
  const take = (text) => {
    if (found || !text.includes('"usage"')) return;
    try {
      const j = JSON.parse(text);
      const r = j.type === "response.completed" ? j.response : j;
      if (r?.usage && typeof r.id === "string") found = r;
    } catch {}
  };
  return {
    feed(text) {
      if (found) return;
      const lines = (tail + text).split("\n");
      tail = lines.pop();
      for (const l of lines) if (l.startsWith("data: ") && l.includes('"response.completed"')) take(l.slice(6));
    },
    done() {
      take(tail.startsWith("data: ") ? tail.slice(6) : tail);
      if (!found) return undefined;
      const u = found.usage;
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      // OpenRouter's output_tokens already include the reasoning tokens.
      return { key: found.id.slice(0, 200), model: typeof found.model === "string" ? found.model.slice(0, 120) : "", input: Math.max(0, (u.input_tokens ?? 0) - cached), cached, output: u.output_tokens ?? 0, costUsd: typeof u.cost === "number" ? u.cost : null };
    },
  };
}
