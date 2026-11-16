// The job sandbox (kernel/src/sandbox.ts), with each engine module the engineering module runs in it: what a job sees of the host's files (bwrap allowlist, masks), its own network (pasta
// netjail), its engine module and state, its cloud session and jobcaps. The real-bwrap cases run where bwrap works (the host,
// CI on Linux).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildJob, cowRoot, layout, removeLayers } from "../../../kernel/src/sandbox.ts";
import { sandboxConfig } from "../../../kernel/src/sandbox-config.ts";
import { readEvents } from "../../../kernel/src/jobs.ts";
import { appendLine } from "../../../kernel/sdk/src/engine-io.ts";
import { codexCommand } from "../../../modules/engine-codex/src/codex.ts";
import { claudeCommand } from "../../../modules/engine-claude/src/claude.ts";
import { opencodeCommand } from "../../../modules/engine-opencode/src/opencode.ts";
import { enginesFile, registry } from "./fakes/engines.mjs";

const ENGINES = enginesFile(mkdtempSync(join(tmpdir(), "k-engines-")));
/** One engine@1 job's command, env and spec, in a fresh job dir and state dir, with a vault holding the Claude token. */
function bj({ cfg: c, ...o }) {
  const d = mkdtempSync(join(tmpdir(), "k-job-"));
  for (const x of ["job", "vault"]) mkdirSync(join(d, x));
  writeFileSync(join(d, "vault", "claude_oauth_token"), "tok\n");
  writeFileSync(join(d, "vault", "gateway_job_secret"), "s".repeat(32));
  const base = { bwrap: "bwrap", hidden: [], binDir: join(d, "bin"), browserDir: "/opt/aidenhq/browser", workDir: join(d, "work"), stateDir: join(d, "state"), secretsDir: join(d, "vault"), enginesFile: ENGINES, gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "http://10.231.2.1:8200", timeout_minutes: 60 };
  return { ...buildJob({ cfg: { ...base, ...c }, jobDir: join(d, "job"), boxWrap: 'exec "$@"', ...o }), dir: d };
}

describe("the job sandbox", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "k-observe-"));
    writeFileSync(join(dir, "jobcaps.json"), JSON.stringify({ "grafana-read": { connection: "grafana", url: "http://127.0.0.1:3124/mcp", bearer_secret: "grafana_mcp_token", tools: ["query_prometheus"] } }));
    mkdirSync(join(dir, "gcloud-user"));
    const c = { jobcapsFile: join(dir, "jobcaps.json"), hidden: [join(dir, "gcloud-user"), join(dir, "not-there")], sandbox: { extra_writable_roots: [] } };
    const cloud = { root: join(dir, "job-gcloud"), env: { CLOUDSDK_CONFIG: join(dir, "job-gcloud/config") } };
    mkdirSync(cloud.root);
    return { dir, c, cloud };
  };

  it("gives gcloud to an Engineer with private reads, never to a light one; Grafana through its jobcap", () => {
    const { c, cloud } = setup();
    for (const kind of ["codex", "claude"]) {
      const { argv, env, spec } = bj({ cfg: c, engine: { kind, reads: true }, worktree: "/w", cloud, job: { issueId: "i1", jobcaps: ["grafana-read"] } });
      assert.equal(env.CLOUDSDK_CONFIG, cloud.env.CLOUDSDK_CONFIG, kind);
      assert.equal(spec.mcp[0].url, "http://127.0.0.1:8201/c/grafana/mcp", kind);
      assert.ok(argv.join(" ").includes(`--bind ${cloud.root} ${cloud.root}`), `${kind}: gcloud dir writable`);
    }
    const or = bj({ cfg: c, engine: { kind: "openrouter", model: "m" }, worktree: "/w", cloud });
    assert.equal(or.env.CLOUDSDK_CONFIG, undefined);
    assert.ok(!or.argv.some((a) => a.includes(cloud.root)));
  });

  // The job's filesystem is an allowlist: its task folder, the toolchains, its engine's state; nothing else of the host.
  it("binds only the job's task folder and toolchains: no sibling task, no product checkout", () => {
    const { dir, c } = setup();
    const tasks = join(dir, "tasks");
    for (const t of ["WOR-1", "WOR-2"]) mkdirSync(join(tasks, t), { recursive: true });
    mkdirSync(join(tasks, "WOR-1", "gcloud-in-task"));
    const repo = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
    const jc = { ...c, binDir: join(repo, "services/runner/bin"), hidden: [join(dir, "gcloud-user"), join(tasks, "WOR-1", "gcloud-in-task")] };
    for (const kind of ["codex", "claude", "openrouter", "codex-openrouter"]) {
      const { argv } = bj({ cfg: jc, engine: { kind, model: "m" }, worktree: join(tasks, "WOR-1"), job: { issueId: "i1" } });
      const sep = argv.indexOf("--die-with-parent");
      const mounts = argv.slice(0, sep);
      assert.equal(mounts[0], "bwrap", kind);
      assert.ok(!mounts.includes("/") , `${kind}: the host's root is not bound`);
      assert.ok(mounts.join(" ").includes(`--bind ${join(tasks, "WOR-1")} ${join(tasks, "WOR-1")}`), `${kind}: its task folder, read-write`);
      assert.ok(!mounts.some((m) => m.startsWith(join(tasks, "WOR-2")) || m === tasks), `${kind}: no sibling task`);
      const engineDir = join(repo, registry()[kind].dir);
      assert.ok(mounts.join(" ").includes(`--ro-bind ${engineDir} ${engineDir}`), `${kind}: its engine module, read-only`);
      assert.ok(!mounts.some((m) => m === repo || (m.startsWith(repo + "/") && !m.startsWith(jc.binDir) && m !== engineDir)), `${kind}: of the product checkout only the wrappers and its engine module`);
      assert.ok(mounts.join(" ").includes(`--tmpfs ${join(tasks, "WOR-1", "gcloud-in-task")}`), `${kind}: a hidden path inside an allowed one stays masked`);
      assert.ok(!mounts.includes(join(dir, "gcloud-user")), `${kind}: a hidden path outside the allowlist is simply absent`);
    }
  });

  // The private bwrap (ops/vm/setup.sh) carries the AppArmor exemption; /usr/bin/bwrap keeps the release's policy.
  it("runs jobs with the configured bwrap, with and without the network jail", () => {
    const { dir, c } = setup();
    const jc = { ...c, bwrap: "/opt/aidenhq/bwrap/bwrap" };
    const plain = bj({ cfg: jc, engine: { kind: "codex", model: "m" }, worktree: join(dir, "WOR-1"), job: { issueId: "i1" } }).argv;
    assert.equal(plain[0], "/opt/aidenhq/bwrap/bwrap");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/ip"), "#!/bin/sh\necho '1: lo    inet 127.0.0.1/8 scope host lo'\n");
    chmodSync(join(dir, "bin/ip"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    try {
      const jailed = bj({ cfg: { ...jc, pasta: "/usr/bin/pasta" }, engine: { kind: "codex", model: "m" }, worktree: join(dir, "WOR-1"), job: { issueId: "i1" } }).argv;
      assert.equal(jailed[5], "/opt/aidenhq/bwrap/bwrap"); // netjail.ts <pasta> <ports> <link> <bwrap> …
    } finally {
      process.env.PATH = path;
    }
  });

  // bin/aidenhq-browse drives the host's pinned browser (ops/vm/setup.sh): every job sees it, none can change it.
  it("binds the host's browser read-only into every job", () => {
    const { dir, c } = setup();
    const browserDir = join(dir, "browser");
    mkdirSync(browserDir);
    const jc = { ...c, browserDir };
    for (const kind of ["codex", "claude", "openrouter", "codex-openrouter"]) {
      const { argv } = bj({ cfg: jc, engine: { kind, model: "m" }, worktree: join(dir, "WOR-1"), job: { issueId: "i1" } });
      const mounts = argv.slice(0, argv.indexOf("--die-with-parent")).join(" ");
      assert.ok(mounts.includes(`--ro-bind ${browserDir} ${browserDir}`), kind);
      assert.ok(!mounts.includes(`--bind ${browserDir}`), `${kind}: never writable`);
    }
  });

  // Run for real where bwrap works (the host, CI on Linux): a job can't read a sibling task or the product checkout.
  it("a real job can read its own task folder but not a sibling's or the product checkout", { skip: spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status !== 0 && "bwrap unavailable" }, () => {
    const { dir, c } = setup();
    const tasks = join(dir, "tasks");
    for (const t of ["WOR-1", "WOR-2"]) {
      mkdirSync(join(tasks, t), { recursive: true });
      writeFileSync(join(tasks, t, "f"), t);
    }
    const repo = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
    const { argv } = bj({ cfg: { ...c, binDir: join(repo, "services/runner/bin") }, engine: { kind: "codex" }, worktree: join(tasks, "WOR-1") });
    const inner = argv.indexOf("--") + 1;
    const run = (path) => spawnSync(argv[0], [...argv.slice(1, inner), "cat", path], { encoding: "utf8" });
    assert.equal(run(join(tasks, "WOR-1", "f")).stdout, "WOR-1");
    assert.notEqual(run(join(tasks, "WOR-2", "f")).status, 0);
    assert.notEqual(run(join(repo, "CLAUDE.md")).status, 0);
    assert.equal(run(join(repo, "services/runner/bin/git-ssh-no-push")).status, 0);
    // Its own PID namespace and procfs: another process's environment (the runner's) and the host's root through
    // /proc/1/root are out of reach.
    const other = spawn("sleep", ["30"], { env: { ...process.env, AIDENHQ_TEST_MARKER: "host-secret" } });
    try {
      const sh = (cmd) => spawnSync(argv[0], [...argv.slice(1, inner), "sh", "-c", cmd], { encoding: "utf8" });
      assert.notEqual(sh(`cat /proc/${other.pid}/environ`).status, 0);
      assert.doesNotMatch(sh("cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'").stdout, /host-secret/);
      assert.notEqual(sh(`cat /proc/1/root${repo}/CLAUDE.md`).status, 0);
    } finally {
      other.kill();
    }
  });

  // The shared build caches are copy-on-write per task: a job's writes stay in its task's layer, never in the seed others read.
  it("a real job's cache writes stay with its task: the shared seed and other tasks never see them", { skip: spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status !== 0 && "bwrap unavailable" }, () => {
    const { dir, c } = setup();
    const seed = join(dir, "npm-cache");
    mkdirSync(seed);
    writeFileSync(join(seed, "pkg"), "seed\n");
    const tasks = join(dir, "tasks");
    for (const t of ["WOR-1", "WOR-2"]) mkdirSync(join(tasks, t), { recursive: true });
    const cc = { ...c, workDir: dir, sandbox: { extra_writable_roots: [seed] } };
    const sh = (task, cmd) => {
      const { argv } = bj({ cfg: cc, engine: { kind: "codex" }, worktree: join(tasks, task) });
      const inner = argv.indexOf("--") + 1;
      return spawnSync(argv[0], [...argv.slice(1, inner), "sh", "-c", cmd], { encoding: "utf8" });
    };
    assert.equal(sh("WOR-1", `cat ${seed}/pkg && echo poisoned > ${seed}/pkg && echo mine > ${seed}/new`).status, 0);
    assert.equal(readFileSync(join(seed, "pkg"), "utf8"), "seed\n", "the seed is unchanged");
    assert.ok(!existsSync(join(seed, "new")));
    assert.equal(sh("WOR-2", `cat ${seed}/pkg; ls ${seed}`).stdout, "seed\npkg\n", "another task reads the seed only");
    assert.equal(sh("WOR-1", `cat ${seed}/pkg ${seed}/new`).stdout, "poisoned\nmine\n", "the task keeps its own writes");
    // Its layers go with its workspace, read-only folders (Go's module cache) included.
    assert.equal(sh("WOR-1", `mkdir -p ${seed}/mod/x && touch ${seed}/mod/x/f && chmod -R a-w ${seed}/mod`).status, 0);
    removeLayers(cowRoot(cc, join(tasks, "WOR-1")));
    assert.ok(!existsSync(cowRoot(cc, join(tasks, "WOR-1"))));
  });

  it("with pasta, a job gets its own network: of the host's loopback only its helper and the model gateway", () => {
    const { dir, c } = setup();
    const jc = { ...c, pasta: "/usr/bin/pasta" };
    const loopback = ["http://127.0.0.1:41000"];
    // The host's addresses, as `ip -4 -o addr show` gives them: its LAN is 10.0.2.0/24, the first link candidate.
    mkdirSync(join(dir, "bin"));
    // ...and its routes (`ip -4 route show table all`): a VPN routes 172.31.254.0/24, the second candidate, though no address is on it.
    writeFileSync(join(dir, "bin/ip"), "#!/bin/sh\ncase \"$*\" in *route*) echo 'default via 10.0.2.1 dev eth0'; echo '172.31.254.0/24 via 10.0.2.9 dev eth0'; echo 'local 10.0.2.7 dev eth0 table local proto kernel scope host src 10.0.2.7'; exit 0;; esac\necho '1: lo    inet 127.0.0.1/8 scope host lo'\necho '2: eth0    inet 10.0.2.7/24 brd 10.0.2.255 scope global eth0'\necho '3: br0    inet 203.0.113.9/32 scope global br0'\n");
    chmodSync(join(dir, "bin/ip"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    const claude = bj({ cfg: jc, engine: { kind: "claude", reads: true }, worktree: "/w", loopback, job: { issueId: "i1", jobcaps: ["grafana-read"] } }).argv;
    const or = bj({ cfg: jc, engine: { kind: "openrouter", model: "m" }, worktree: "/w", loopback }).argv;
    const codex = bj({ cfg: jc, engine: { kind: "codex" }, worktree: "/w", loopback }).argv;
    process.env.PATH = path;
    assert.equal(claude[0], process.execPath);
    assert.ok(claude[1].endsWith("/netjail.ts"));
    assert.deepEqual([...claude.slice(2, 4), ...claude.slice(5, 8)], ["/usr/bin/pasta", "8201,41000", "bwrap", "--unshare-pid", "--unshare-ipc"]);
    assert.equal(claude[4], "192.168.254"); // pasta's link: apart from the host's 10.0.2.0/24 and the routed 172.31.254.0/24
    assert.ok(claude.includes("--unshare-net") && claude.includes("--die-with-parent"));
    // The public resolvers sit on the job's own tmpfs, not on the host's resolver file (whose rewrites detach a bind).
    const rc = claude.indexOf("/etc/resolv.conf");
    assert.deepEqual(claude.slice(rc - 4, rc), ["--tmpfs", "/run/systemd/resolve", "--ro-bind-data", "5"]);
    const jail = claude.indexOf("aidenhq-jail");
    assert.deepEqual(claude.slice(jail + 1, jail + 3), [process.execPath, join(fileURLToPath(new URL("../../..", import.meta.url)), "modules/engine-claude/bin/engine")]); // the engine itself, after the jail's own setup: bwrap is its boundary
    // The job's first step: private and reserved ranges, and each of the host's own addresses (a public one too), are unreachable.
    for (const n of ["192.168.0.0/16", "240.0.0.0/4", "10.0.2.7/32", "203.0.113.9/32"]) assert.ok(claude[jail - 1].split(/[ ;]/).includes(n), n);
    // The model gateway's port for its model calls; a job with neither jobcaps nor gateway models gets only its helper.
    assert.equal(or[3], "8201,41000");
    assert.equal(codex[3], "41000");
  });

  it("masks the runner's state db (every run's helper token) but not the state dir, where a job's cloud session lives", () => {
    const dir = mkdtempSync(join(tmpdir(), "k-cfg-"));
    const cfg = sandboxConfig((k) => (k === "AIDENHQ_CONFIG_DIR" ? dir : process.env[k]));
    for (const x of ["", "-wal", "-shm"]) assert.ok(cfg.hidden.includes(join(cfg.stateDir, `state.sqlite${x}`)), `state.sqlite${x} hidden`);
    assert.ok(!cfg.hidden.includes(cfg.stateDir));
    for (const p of ["/run/docker.sock", "/run/tailscale/tailscaled.sock"]) assert.ok(cfg.hidden.includes(p), p);
  });
});

// Hostile-job checks (spec §8.9): what a job could use to reach past its own task folder.
describe("hostile jobs", () => {
  it("H2: the jail hides the vault, the data dir, the Docker and tailscaled sockets and the user's runtime dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "h2-"));
    const env = { AIDENHQ_CONFIG_DIR: dir, AIDENHQ_SECRETS_DIR: join(dir, "secrets"), AIDENHQ_DATA_DIR: join(dir, "data") };
    const cfg = sandboxConfig((k) => env[k] ?? process.env[k]);
    for (const p of [join(dir, "secrets"), join(dir, "data"), "/run/docker.sock", "/run/tailscale/tailscaled.sock", `/run/user/${process.getuid()}`]) assert.ok(cfg.hidden.includes(p), `${p} hidden`);
    // What the list names inside an allowed path is masked in the job: a folder by an empty tmpfs, a file by /dev/null.
    for (const d of ["secrets", "data"]) mkdirSync(join(dir, d));
    writeFileSync(join(dir, "docker.sock"), "");
    const args = layout({ hidden: [join(dir, "secrets"), join(dir, "data"), join(dir, "docker.sock")] }, { rw: [dir] });
    const after = args.slice(args.indexOf(dir) + 2).join(" ");
    for (const d of ["secrets", "data"]) assert.ok(after.includes(`--tmpfs ${join(dir, d)}`), d);
    assert.ok(after.includes(`--ro-bind /dev/null ${join(dir, "docker.sock")}`));
  });

  it("H3: no MCP token or connection URL in a job, and no engine wrapped in codex sandbox; private data never meets the web", () => {
    const dir = mkdtempSync(join(tmpdir(), "h3-"));
    writeFileSync(join(dir, "jobcaps.json"), JSON.stringify({ "primer-read": { connection: "primer", url: "http://127.0.0.1:3123/mcp/read", bearer_secret: "primer_mcp_read_token", tools: ["primer_get_document"] } }));
    const c = { jobcapsFile: join(dir, "jobcaps.json"), sandbox: { extra_writable_roots: [] } };
    const build = (o) => bj({ cfg: c, worktree: join(dir, "w"), ...o });
    // What the engine runs, from the spec the kernel wrote and the env it set (each engine module's own builder).
    const vendor = { codex: (sp, env) => codexCommand(sp, "/job", env), claude: (sp, env) => claudeCommand(sp, env), openrouter: (sp, env) => opencodeCommand(sp, env) };
    for (const kind of ["codex", "claude", "openrouter"]) {
      const { argv, env, spec } = build({ engine: { kind, model: "m" }, job: { agentId: "a1", issueId: "i1", jobcaps: ["primer-read"] } });
      assert.deepEqual(Object.keys(env).filter((k) => /_MCP_TOKEN$/.test(k)), [], kind);
      const child = vendor[kind](spec, env);
      const text = `${argv.join(" ")} ${JSON.stringify(spec)} ${child.argv.join(" ")} ${child.env.OPENCODE_CONFIG_CONTENT ?? ""}`;
      const urls = [...text.matchAll(/https?:\/\/[^\s"',\\]+/g)].map((m) => m[0]).filter((u) => /\/mcp/.test(u));
      assert.ok(urls.length, `${kind}: wired to its jobcap`);
      for (const u of urls) assert.ok(u.startsWith("http://127.0.0.1:8201/c/"), `${kind}: ${u}`);
      if (kind !== "codex") assert.ok(!child.argv.some((a, i) => a === "codex" && child.argv[i + 1] === "sandbox"), `${kind}: codex sandbox`);
      assert.ok(!text.includes("primer_mcp_read_token"), `${kind}: the read secret's name`);
    }
    // A job that doesn't observe (web search on) gets no private jobcap, and its token isn't minted as observing; one that
    // observes gets both, with search off, in every engine.
    writeFileSync(join(dir, "jobcaps.json"), JSON.stringify({
      "primer-read": { connection: "primer", url: "http://127.0.0.1:3123/mcp/read", bearer_secret: "primer_mcp_read_token", tools: ["primer_get_document"] },
      "slack-read": { connection: "slack", url: "http://127.0.0.1:3125/mcp/read", bearer_secret: "slack_mcp_read_token", tools: ["slack_read_thread"], private: true },
    }));
    const claims = (env) => JSON.parse(Buffer.from(env.AIDENHQ_JOB_TOKEN.slice(5).split(".")[0], "base64url"));
    const job = { agentId: "a1", issueId: "i1", jobcaps: ["slack-read", "primer-read"] };
    const light = build({ engine: { kind: "codex" }, job });
    assert.deepEqual(light.spec.mcp.map((m) => m.name), ["primer"]);
    assert.deepEqual([claims(light.env).j, claims(light.env).o], [["primer-read"], undefined]);
    assert.equal(light.spec.web, true);
    assert.ok(codexCommand(light.spec, "/job", light.env).argv.includes('web_search="live"'));
    const deep = build({ engine: { kind: "codex", reads: true }, job });
    assert.deepEqual(deep.spec.mcp.map((m) => m.name), ["primer", "slack"]);
    assert.deepEqual([claims(deep.env).j, claims(deep.env).o], [["primer-read", "slack-read"], true]);
    assert.equal(deep.spec.web, false);
    assert.ok(codexCommand(deep.spec, "/job", deep.env).argv.includes('web_search="disabled"'));
    const tools = claudeCommand(deep.spec, deep.env).argv;
    assert.doesNotMatch(tools[tools.indexOf("--tools") + 1], /Web/);
    const { permission } = JSON.parse(opencodeCommand(deep.spec, deep.env).env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual([permission.webfetch, permission.websearch], ["deny", "deny"]);
    // A box job too: private reads, no web search.
    const box = { container: "aidenhq-computer-x", envFile: "/e", outDir: "/o" };
    for (const reads of [true, false]) {
      const { spec } = build({ engine: { kind: "codex-openrouter", model: "m", box: true, ...(reads ? { reads: true } : {}) }, job: { issueId: "x" }, box });
      assert.match(codexCommand(spec, "/aidenhq-out/job", {}).argv.join(" "), reads ? /web_search="disabled"/ : /web_search="live"/);
    }
  });

  it("H4: an events file linked to a host file is never read; an inbox link or a FIFO takes no comment and hangs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "h4-"));
    const secret = join(dir, "vault-file");
    writeFileSync(secret, `${JSON.stringify({ t: "final", text: "the owner key 0123456789" })}\n`);
    const job = join(dir, "job");
    mkdirSync(job);
    symlinkSync(secret, join(job, "events.jsonl"));
    assert.throws(() => readEvents(job, 0), /ELOOP|symbolic link|not a regular file/);
    symlinkSync(join(dir, "elsewhere"), join(job, "inbox.jsonl"));
    assert.throws(() => appendLine(join(job, "inbox.jsonl"), { t: "comment", from: "owner", text: "x" }));
    assert.ok(!existsSync(join(dir, "elsewhere")));
    const fifo = join(dir, "fifo-job");
    mkdirSync(fifo);
    for (const f of ["events.jsonl", "inbox.jsonl"]) execFileSync("mkfifo", [join(fifo, f)]);
    assert.throws(() => readEvents(fifo, 0), /not a regular file/);
    assert.throws(() => appendLine(join(fifo, "inbox.jsonl"), { t: "comment", from: "owner", text: "x" }), /ENXIO|not a regular file/);
  });
});
