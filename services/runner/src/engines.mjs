import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DEFAULT_IDENTITY, identityEnv } from "./github-app.mjs";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { join } from "node:path";
import { progressTracker } from "./progress.mjs";
import { mintToken } from "../../gateway/token.mjs";

const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function sandboxConfig(cfg, worktree, stateRoots = []) {
  const roots = [worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)].filter((p) => existsSync(p) || p === worktree);
  return [
    "-c", 'sandbox_mode="workspace-write"',
    "-c", `sandbox_workspace_write.network_access=${cfg.sandbox?.network === false ? "false" : "true"}`,
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "-c", 'approval_policy="never"',
  ];
}

/** `codex sandbox` around a whole process: writes only in the worktree, the given state dirs and the build caches. */
function codexSandbox(cfg, worktree, stateRoots, argv) {
  return [
    "codex", "sandbox",
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.network_access=true", // the engine itself talks to its model API
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([worktree, ...stateRoots, ...(cfg.sandbox?.extra_writable_roots ?? []).map(expand)])}`,
    "--", ...argv,
  ];
}

// Claude Code's built-in tools for coding jobs. Everything else (scheduling, remote triggers,
// notifications, messaging, workflows) is left out; MCP servers, plugins and claude.ai connectors
// are off entirely.
// TaskCreate/TaskUpdate/TaskList: the agent's own task list, which the board shows while it works.
const CLAUDE_TOOLS = "Bash,Read,Edit,Write,NotebookEdit,Task,TaskStop,TaskCreate,TaskUpdate,TaskList,WebFetch,WebSearch";

/**
 * Primer, read-only, for every engine: primer-mcp's /mcp/read on loopback. The bearer token
 * goes in through the environment (PRIMER_MCP_TOKEN), never on the command line. Skipped until
 * Primer is set up.
 */
function primer(cfg) {
  if (!cfg.primerMcpUrl || !cfg.primerTokenFile || !existsSync(cfg.primerTokenFile)) return undefined;
  return { url: cfg.primerMcpUrl, token: readFileSync(cfg.primerTokenFile, "utf8").trim() };
}

/**
 * Grafana and Google Cloud reads go to Claude Code and Codex only: production logs and
 * metrics never go to OpenRouter's third-party model providers.
 */
export const observes = (kind) => kind === "claude" || kind === "codex";

/**
 * The private reads for Claude Code and Codex (observes): Grafana, Slack and Glean,
 * the user's own messages and the company's documents, and ClickHouse, production data. Each is an MCP server on loopback that serves
 * reads only, with a token the job gets through the environment, never on the command line. Skipped
 * until set up. OpenRouter never gets them: its prompts go to third-party model providers.
 */
const PRIVATE_READS = [
  { name: "grafana", url: "grafanaMcpUrl", tokenFile: "grafanaTokenFile", env: "GRAFANA_MCP_TOKEN" },
  { name: "slack", url: "slackMcpUrl", tokenFile: "slackTokenFile", env: "SLACK_MCP_TOKEN" },
  { name: "glean", url: "gleanMcpUrl", tokenFile: "gleanTokenFile", env: "GLEAN_MCP_TOKEN" },
  // Queries run up to two minutes (clickhouse-mcp caps them), past Codex's 60-second tool timeout.
  { name: "clickhouse", url: "clickhouseMcpUrl", tokenFile: "clickhouseTokenFile", env: "CLICKHOUSE_MCP_TOKEN", toolTimeout: 180 },
];
export function privateReads(cfg) {
  return PRIVATE_READS.filter((s) => cfg[s.url] && cfg[s.tokenFile] && existsSync(cfg[s.tokenFile])).map((s) => ({
    name: s.name,
    url: cfg[s.url],
    env: s.env,
    ...(s.toolTimeout ? { toolTimeout: s.toolTimeout } : {}),
    token: readFileSync(cfg[s.tokenFile], "utf8").trim(),
  }));
}

/**
 * The whole run under bwrap with what it must not read hidden (cfg.gcp.hidden): the sandbox limits writes, not reads.
 * A directory gets an empty tmpfs (the gcloud sign-ins, the secrets, the services' data); a file or socket gets /dev/null
 * (the Docker socket: the runner's user is in the docker group, which is root on the host).
 */
export function hiding(cfg, argv, loopback = []) {
  const paths = (cfg.gcp?.hidden ?? []).filter((d) => existsSync(d));
  const mask = (p) => (statSync(p).isDirectory() ? ["--tmpfs", p] : ["--ro-bind", "/dev/null", p]);
  if (cfg.pasta) return jailed(cfg.pasta, paths.flatMap(mask), loopback, argv);
  return paths.length ? ["bwrap", "--dev-bind", "/", "/", ...paths.flatMap(mask), "--die-with-parent", "--", ...argv] : argv;
}

/** Why jobs can't get their own network here (no pasta, or a trial job failed), or undefined when they can. */
export function jailProblem(cfg) {
  if (!cfg.pasta) return "pasta is not installed (sudo apt-get install -y passt)";
  const [cmd, ...args] = hiding(cfg, ["true"]);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return r.status === 0 ? undefined : `a trial job failed (exit ${r.status ?? r.signal}): ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`;
}

/** Host loopback ports of the given URLs (127.0.0.1 / localhost only): what a jailed job may reach on the host. */
export const loopbackPorts = (urls) =>
  [...new Set(urls.filter(Boolean).map((u) => new URL(u)).filter((u) => ["127.0.0.1", "localhost"].includes(u.hostname)).map((u) => Number(u.port || (u.protocol === "https:" ? 443 : 80))))].sort((a, b) => a - b);

// Unreachable from a job: private, shared, link-local, benchmark, reserved and "this network" ranges (the LAN, Docker
// bridges, the tailnet, cloud metadata), and every address of the host itself (a public one too). 127.0.0.0/8 stays the
// jail's own loopback (the local table wins), where pasta serves the allowed ports. pasta reaches the rest of the
// Internet from the host's side.
const BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "240.0.0.0/4"];
// The link to pasta (a /24: the job is .15, pasta's gateway .2): the first that overlaps none of the host's networks,
// so no host address is ever "on link" in the jail.
const LINKS = ["10.0.2", "172.31.254", "192.168.254", "100.127.254"];
const ipNum = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const overlaps = (a, alen, b, blen) => Math.floor(ipNum(a) / 2 ** (32 - Math.min(alen, blen))) === Math.floor(ipNum(b) / 2 ** (32 - Math.min(alen, blen)));
// From `ip`, not os.networkInterfaces(): that leaves out interfaces without carrier (an idle Docker bridge), whose
// addresses are still the host's.
const hostIPv4 = () =>
  [...execFileSync("ip", ["-4", "-o", "addr", "show"], { encoding: "utf8" }).matchAll(/ inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/g)].map((m) => ({ address: m[1], prefix: Number(m[2]) }));
// Every network the host routes to (a VPN's subnet has no host address on it): the link must avoid these too, or a
// destination "on link" in the jail could be one the host would forward somewhere real.
const hostRoutes = () =>
  [...execFileSync("ip", ["-4", "route", "show", "table", "all"], { encoding: "utf8" }).matchAll(/^(?:(?:unicast|local|broadcast|anycast|multicast|unreachable|blackhole|prohibit|throw)\s+)?(\d+\.\d+\.\d+\.\d+)(?:\/(\d+))?\s/gm)].map((m) => ({ address: m[1], prefix: m[2] ? Number(m[2]) : 32 }));

/**
 * The job in its own network namespace (src/netjail.mjs): Internet egress through pasta, and of the host's loopback
 * only the ports it was given (the run's helper, the read-only MCP endpoints it is wired to). Every other loopback
 * service (the board, Paperclip, apps trusting loopback callers), the host's other addresses and the LAN are out of
 * reach. The job's first step sets the unreachable routes, then drops the capabilities it used (bounding set too).
 */
function jailed(pasta, masks, loopback, argv) {
  const ports = loopbackPorts(loopback).join(",") || "none";
  const host = hostIPv4();
  const nets = [...host, ...hostRoutes()];
  const link = LINKS.find((l) => nets.every((a) => !overlaps(`${l}.0`, 24, a.address, a.prefix)));
  if (!link) throw new Error("no free subnet for the job's network link: every candidate overlaps a host network");
  const unreachable = [...BLOCKED, ...host.filter((a) => !a.address.startsWith("127.")).map((a) => `${a.address}/32`)];
  const inner = `for n in ${unreachable.join(" ")}; do PATH="/usr/sbin:/sbin:$PATH" ip route add unreachable "$n" || exit 1; done; exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$@"`;
  return [
    process.execPath, join(import.meta.dirname, "netjail.mjs"), pasta, ports, link,
    "bwrap", "--dev-bind", "/", "/", ...masks, "--ro-bind-data", "5", "/etc/resolv.conf",
    "--unshare-net", "--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SETPCAP", "--info-fd", "3", "--block-fd", "4", "--die-with-parent",
    "--", "/bin/sh", "-c", inner, "aidenhq-jail", ...argv,
  ];
}

/**
 * Command line for one engine run. Codex sandboxes its own tool calls; opencode and Claude Code run
 * inside `codex sandbox`. `gcp` is the job's gcloud session (src/gcp.mjs), for engines that observe.
 * `loopback`: further host URLs the job may reach (the run's helper), besides the MCP endpoints it is wired to.
 */
export function buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, loopback = [], job = {} }) {
  const built = engineCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp: observes(engine.kind) ? gcp : undefined, job });
  // opencode's model calls go to the model gateway on host loopback (forwarded into the job's network jail).
  const mcp = [primer(cfg)?.url, ...(observes(engine.kind) ? privateReads(cfg).map((r) => r.url) : []), ...(engine.kind === "openrouter" ? [gatewayUrl(cfg)] : [])];
  return { ...built, argv: hiding(cfg, built.argv, [...mcp, ...loopback]) };
}

const gatewayUrl = (cfg) => cfg.gatewayUrl ?? "http://127.0.0.1:8201";

/**
 * A model credential for the gateway (services/gateway/token.mjs), signed with gateway_job_secret: a job's (kind agent, capped,
 * billed to its Engineer and task) or the runner's own (reviewer, grader, intake). Never the OpenRouter key.
 */
export function modelToken(cfg, claims) {
  let secret = "";
  try { secret = readFileSync(cfg.gatewayJobSecretFile, "utf8").trim(); } catch {}
  return mintToken(secret, claims);
}
export const gatewayApi = (cfg) => `${gatewayUrl(cfg)}/api/v1`;

function engineCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, job = {} }) {
  const p = primer(cfg);
  const reads = observes(engine.kind) ? privateReads(cfg) : [];
  const mcpEnv = { ...(p ? { PRIMER_MCP_TOKEN: p.token } : {}), ...Object.fromEntries(reads.map((r) => [r.env, r.token])), ...(gcp?.env ?? {}) };
  const gcpRoots = gcp ? [gcp.root] : [];
  if (engine.kind === "codex") {
    const base = sessionId ? ["codex", "exec", "resume", sessionId] : ["codex", "exec"];
    // The workspace holds several clones and isn't a git repository itself.
    const args = [...base, "--json", "--skip-git-repo-check", "-o", lastMessageFile, ...sandboxConfig(cfg, worktree, gcpRoots)];
    if (p) {
      args.push(
        "-c", `mcp_servers.primer.url=${JSON.stringify(p.url)}`,
        "-c", 'mcp_servers.primer.bearer_token_env_var="PRIMER_MCP_TOKEN"',
        "-c", 'mcp_servers.primer.default_tools_approval_mode="approve"',
      );
    }
    for (const r of reads) {
      args.push(
        "-c", `mcp_servers.${r.name}.url=${JSON.stringify(r.url)}`,
        "-c", `mcp_servers.${r.name}.bearer_token_env_var="${r.env}"`,
        "-c", `mcp_servers.${r.name}.default_tools_approval_mode="approve"`,
      );
      if (r.toolTimeout) args.push("-c", `mcp_servers.${r.name}.tool_timeout_sec=${r.toolTimeout}`);
    }
    if (engine.model) args.push("-m", engine.model);
    if (engine.effort) args.push("-c", `model_reasoning_effort="${engine.effort}"`);
    args.push("-");
    return { argv: args, env: mcpEnv };
  }
  if (engine.kind === "openrouter") {
    // The job's own credential to the model gateway, valid past its deadline (an adopted run keeps its env).
    const key = modelToken(cfg, { kind: "agent", agentId: job.agentId ?? null, issueId: job.issueId ?? null, ttlMs: ((cfg.timeout_minutes ?? 60) + 60) * 60_000 });
    const opencode = ["opencode", "run", "--format", "json", "--model", `openrouter/${engine.model}`];
    if (sessionId) opencode.push("--session", sessionId);
    // OS-level confinement for opencode's tools: Codex's sandbox around the whole process.
    const stateRoots = ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", "~/.config/opencode"].map(expand);
    return {
      argv: codexSandbox(cfg, worktree, stateRoots, opencode),
      env: {
        ...mcpEnv,
        OPENROUTER_API_KEY: key,
        // Non-interactive: opencode must not stop to ask for permission, because an unanswered prompt
        // is auto-rejected and ends the run. Reading outside the worktree (reference repos) is
        // fine: the codex sandbox around opencode still limits writes to the worktree. Its default asks
        // before reading `.env` files, which repositories track too (PEN-2421).
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { read: "allow", edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
          autoupdate: false,
          share: "disabled",
          // Through the model gateway; its title calls use the job's model, not opencode's default small model.
          provider: { openrouter: { options: { baseURL: gatewayApi(cfg) } } },
          small_model: `openrouter/${engine.model}`,
          ...(p ? { mcp: { primer: { type: "remote", url: p.url, headers: { Authorization: "Bearer {env:PRIMER_MCP_TOKEN}" }, oauth: false, enabled: true } } } : {}),
        }),
      },
      promptAsArg: true,
    };
  }
  if (engine.kind === "claude") {
    if (!existsSync(cfg.claudeTokenFile)) throw new Error(`Claude Code isn't set up for the runner: run \`claude setup-token\` and save the token to \`${cfg.claudeTokenFile}\` (0600).`);
    const token = readFileSync(cfg.claudeTokenFile, "utf8").trim();
    mkdirSync(cfg.claudeConfigDir, { recursive: true, mode: 0o700 });
    // Headless, no prompts (the codex sandbox is the write boundary), and nothing from your own
    // Claude setup: a runner-owned config dir, no settings files (yours or the repo's: no hooks),
    // no MCP servers but the read-only endpoints (Primer; Grafana, Slack, Glean, ClickHouse), and no claude.ai connectors.
    const mcpServers = {
      ...(p ? { primer: { type: "http", url: p.url, headers: { Authorization: "Bearer ${PRIMER_MCP_TOKEN}" } } } : {}),
      ...Object.fromEntries(reads.map((r) => [r.name, { type: "http", url: r.url, headers: { Authorization: `Bearer \${${r.env}}` } }])),
    };
    const claude = [
      // Streamed input, so the user's comments can reach a run in progress; each one is echoed back
      // once taken in (--replay-user-messages), which tells runAgent when the conversation is done.
      "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers }),
      "--tools", CLAUDE_TOOLS,
    ];
    if (engine.model) claude.push("--model", engine.model);
    if (engine.effort) claude.push("--effort", engine.effort === "minimal" ? "low" : engine.effort);
    if (sessionId) claude.push("--resume", sessionId);
    return {
      argv: codexSandbox(cfg, worktree, [cfg.claudeConfigDir, ...gcpRoots], claude),
      env: {
        ...mcpEnv,
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_CONFIG_DIR: cfg.claudeConfigDir,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
      },
      streamInput: true,
    };
  }
  throw new Error(`unsupported engine ${engine.kind}`);
}

/** One message for Claude Code's streamed input. */
const userMessage = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;


/**
 * Each run's command under a small `sh` that records its exit status in `<log>.exit`, in a process
 * group of its own, writing straight to its log: nothing ties it to the runner, so a runner restart
 * (a deploy) leaves it running and the next runner adopts it (`adoptRun`). The shell stays the
 * engine's parent (bwrap's --die-with-parent) and outlives a stop's SIGTERM to record the status.
 */
// Builtins only: the job's PATH may not have the engine (exit 127), or anything else.
const WRAP = 'trap : TERM INT HUP; "$@"; echo "$?" > "$0"';
const exitStatus = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
const POLL_MS = 250;

/**
 * Start the agent; returns the run for `watchAgent`. For an engine with streamed input (Claude Code),
 * `channel.send(text)` gives the running session another message from the user (docs/design/conversational-engineers.md,
 * During a run) and returns false once the run is over. An adopted run has no input: its runner is gone.
 * The agent's environment: no SSH agent (fetch only via the runner), read-only gh first on PATH (reading with
 * `ghToken`, a read-only App token for the task's repos), and a git ssh wrapper that refuses pushes.
 */
export function startAgent({ cfg, engine, worktree, prompt, sessionId, logPath, env: jobEnv = {}, gcp, channel, identity = DEFAULT_IDENTITY, ghToken, job }) {
  const lastMessageFile = `${logPath}.last.md`;
  const { argv, env, promptAsArg, streamInput } = buildCommand({ cfg, engine, worktree, sessionId, lastMessageFile, gcp, loopback: [jobEnv.AIDENHQ_REPO_URL], job });
  const full = promptAsArg ? [...argv, prompt] : argv;
  const agentEnv = {
    ...process.env,
    ...env,
    PATH: `${cfg.ghWrapperDir}:${process.env.PATH}`,
    GIT_SSH_COMMAND: join(cfg.ghWrapperDir, "git-ssh-no-push"),
    GIT_TERMINAL_PROMPT: "0",
    AIDENHQ_TASK_WORKTREE: worktree,
    // The agent's commits are the App's bot (or AidenHQ agent), never the owner's identity.
    ...identityEnv(identity),
    // The agent commits unsigned (it has no SSH agent to sign with); the runner signs its commits
    // after the run.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "tag.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    ...jobEnv,
  };
  delete agentEnv.SSH_AUTH_SOCK;
  // A GitHub token in the runner's environment is never the agent's. Its gh reads with `ghToken` (a GitHub App token
  // narrowed to the task's repos, read-only) or nothing: the user's own gh sign-in is hidden from jobs (cfg.gcp.hidden).
  delete agentEnv.GH_TOKEN;
  delete agentEnv.GITHUB_TOKEN;
  // Twice: Codex drops *TOKEN* variables from its tool calls, so the gh wrapper also takes AIDENHQ_GH_AUTH.
  if (ghToken) Object.assign(agentEnv, { GH_TOKEN: ghToken, AIDENHQ_GH_AUTH: ghToken });
  // Never a prompt on the user's desktop: without credentials, git over https and ssh would fall back
  // to the session's askpass dialog (seahorse) and pop it up for every private Go module or repo.
  delete agentEnv.SSH_ASKPASS;
  agentEnv.SSH_ASKPASS_REQUIRE = "never";
  agentEnv.GIT_ASKPASS = "false";
  if (engine.kind === "claude") delete agentEnv.ANTHROPIC_API_KEY; // the subscription token, never an API key

  appendFileSync(logPath, `# ${new Date().toISOString()} ${engine.kind}${engine.model ? ` (${engine.model})` : ""} in ${worktree}\n`);
  const out = openSync(logPath, "a");
  const withStdin = streamInput || !promptAsArg;
  const child = spawn("/bin/sh", ["-c", WRAP, `${logPath}.exit`, ...full], { cwd: worktree, env: agentEnv, detached: true, stdio: [withStdin ? "pipe" : "ignore", out, out] });
  closeSync(out);
  const run = { pid: child.pid, logPath, program: full[0], streamInput, stdin: child.stdin, sent: 0 };
  // Only /bin/sh itself failing to start lands here; a missing engine is the shell's exit 127.
  child.on("error", (e) => (run.spawnError = `couldn't start /bin/sh: ${e.code ?? e.message}`));
  child.unref();
  if (child.stdin) {
    child.stdin.on("error", () => {}); // a message sent as the process exits
    if (streamInput) {
      child.stdin.write(userMessage(prompt));
      run.sent = 1;
      if (channel) {
        channel.send = (text) => {
          if (child.stdin.writableEnded || child.exitCode !== null || child.signalCode !== null) return false;
          child.stdin.write(userMessage(text));
          run.sent++;
          return true;
        };
      }
    } else child.stdin.end(prompt);
  }
  return run;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** True while the run's shell (pid) is alive and is still that run (not a reused pid): for adopting it. */
export function runAlive(pid, logPath) {
  try {
    return alive(pid) && execFileSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).includes(`${logPath}.exit`);
  } catch {
    return false;
  }
}

/** A run another runner process started (a restart): followed from its files, with no input channel. */
export const adoptRun = ({ pid, logPath }) => ({ pid, logPath, adopted: true });

/**
 * Follow a run to its end: its log (the engine's event stream, read from the start, so an adopted run
 * rebuilds the same state), its exit file, the deadline and a stop request. Resolves with
 * { code, sessionId, lastMessage, timedOut, cancelled }, or { detached: true } once `detach` aborts
 * (the runner is restarting and leaves the run to its successor).
 * `onProgress({ said, saidAt, plan })` gets the agent's latest words and task list as they change.
 */
export function watchAgent(run, { engine, sessionId, deadline, signal, detach, channel, onProgress }) {
  const { pid, logPath, stdin, streamInput } = run;
  const exitFile = `${logPath}.exit`;
  const lastMessageFile = `${logPath}.last.md`;
  return new Promise((resolve) => {
    let found = sessionId;
    let finalText = "";
    // Streamed input: the session ends once every message sent has been taken in and answered. A
    // message that arrives as a turn ends gets a turn of its own; its answer joins the reply.
    let taken = 0;
    const answers = [];
    let lingering;
    const finish = () => {
      clearTimeout(lingering);
      if (stdin && !stdin.writableEnded) stdin.end();
    };
    const progress = progressTracker();
    const onLine = (line) => {
      try {
        const e = JSON.parse(line);
        if (progress.take(e)) onProgress?.(progress.current());
        if (e.type === "thread.started" && e.thread_id) found = e.thread_id; // codex
        if (e.sessionID && !found) found = e.sessionID; // opencode
        if (e.type === "text" && e.part?.text) finalText = e.part.text; // opencode: keep last text part
        if (e.type === "system" && e.subtype === "init" && e.session_id && !found) found = e.session_id; // claude
        if (streamInput && e.type === "user" && e.isReplay) taken++;
        if (e.type === "result" && typeof e.result === "string") {
          // claude: the answer of a turn
          answers.push(e.result);
          finalText = answers.filter((a) => a.trim() && a.trim() !== "NO_REPLY").join("\n\n") || e.result;
          if (streamInput && stdin) {
            clearTimeout(lingering);
            if (taken >= run.sent) finish();
            else lingering = setTimeout(finish, 120_000); // a message it never took in: don't wait forever
          }
        }
      } catch {
        /* non-JSON output */
      }
    };
    let offset = 0;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const read = () => {
      let fd;
      try {
        fd = openSync(logPath, "r");
        const size = fstatSync(fd).size;
        if (size <= offset) return;
        const chunk = Buffer.alloc(size - offset);
        readSync(fd, chunk, 0, chunk.length, offset);
        offset = size;
        buffer += decoder.write(chunk);
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      } catch {
        /* no log yet */
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };

    let timedOut = false;
    let cancelled = false;
    let killed = false;
    const kill = () => {
      killed = true;
      try {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 10_000).unref();
      } catch {}
    };
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    let timer;
    const end = (then) => {
      clearInterval(timer);
      clearTimeout(lingering);
      signal?.removeEventListener("abort", onAbort);
      detach?.removeEventListener("abort", onDetach);
      then();
    };
    const onDetach = () => end(() => resolve({ detached: true }));
    const done = () =>
      end(() => {
        read();
        if (channel) channel.send = () => false;
        finish();
        const status = exitStatus(exitFile);
        const code = status === "" ? null : Number(status);
        let lastMessage = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf8").trim() : finalText.trim();
        if (!lastMessage && engine.kind !== "codex") lastMessage = finalText.trim();
        const startError = run.spawnError || (code === 127 && `couldn't start ${run.program ?? "the engine"}: ENOENT`);
        if (!lastMessage && startError) {
          appendFileSync(logPath, `# ${startError}\n`);
          lastMessage = `The job couldn't start: ${startError}.`;
        }
        if (lastMessage) writeFileSync(lastMessageFile, lastMessage);
        // No status: the run died without its shell, by its own stop or timeout (killed), else by hand (a failure).
        resolve({ code: code === null && !killed ? 1 : code, sessionId: found, lastMessage, timedOut, cancelled });
      });
    const tick = () => {
      read();
      if (exitStatus(exitFile) || !pid|| run.spawnError || !alive(pid)) return done();
      if (!timedOut && Date.now() > deadline) {
        timedOut = true;
        kill();
      }
    };
    if (detach?.aborted) return onDetach();
    signal?.addEventListener("abort", onAbort);
    detach?.addEventListener("abort", onDetach);
    timer = setInterval(tick, POLL_MS);
    tick();
  });
}

/** Start the agent and follow it to its end (startAgent + watchAgent). */
export function runAgent({ cfg, signal, detach, onProgress, channel, ...opts }) {
  const run = startAgent({ cfg, channel, ...opts });
  return watchAgent(run, { engine: opts.engine, sessionId: opts.sessionId, deadline: Date.now() + (cfg.timeout_minutes ?? 60) * 60_000, signal, detach, channel, onProgress });
}
