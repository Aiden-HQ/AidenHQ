// The host sandbox (kernel/src/sandbox.ts hiding): what repo code the host runs itself (a fast check, the reviewer eval) sees of
// the host's files (bwrap allowlist, masks) and its own network (pasta netjail); and a job's command in its agent's computer
// (buildJob). The real-bwrap cases run where bwrap works (the host, CI on Linux).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildJob, hiding, jailProblem, layout } from "../../../kernel/src/sandbox.ts";
import { sandboxConfig } from "../../../kernel/src/sandbox-config.ts";
import { readEvents } from "../../../kernel/src/jobs.ts";
import { appendLine } from "../../../kernel/sdk/src/engine-io.ts";
import { codexCommand } from "../../../modules/engine-codex/src/codex.ts";
import { enginesFile } from "./fakes/engines.mjs";

const ENGINES = enginesFile(mkdtempSync(join(tmpdir(), "k-engines-")));
const REPO = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
/** The host sandbox's command around `argv`, with `rw` its one writable folder. */
const jail = (c, argv, { rw = [], loopback = [] } = {}) => hiding({ bwrap: "bwrap", hidden: [], binDir: join(REPO, "services/runner/bin"), browserDir: "/opt/aidenhq/browser", ...c }, argv, loopback, { rw });

describe("the host sandbox", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "k-sandbox-"));
    mkdirSync(join(dir, "gcloud-user"));
    return { dir, c: { hidden: [join(dir, "gcloud-user"), join(dir, "not-there")] } };
  };

  // Its filesystem is an allowlist: the clone being checked and the toolchains; nothing else of the host.
  it("binds only the clone it checks and the toolchains: no sibling task, no product checkout", () => {
    const { dir, c } = setup();
    const tasks = join(dir, "tasks");
    for (const t of ["WOR-1", "WOR-2"]) mkdirSync(join(tasks, t), { recursive: true });
    mkdirSync(join(tasks, "WOR-1", "gcloud-in-task"));
    const argv = jail({ ...c, hidden: [join(dir, "gcloud-user"), join(tasks, "WOR-1", "gcloud-in-task")] }, ["true"], { rw: [join(tasks, "WOR-1")] });
    const mounts = argv.slice(0, argv.indexOf("--die-with-parent"));
    assert.equal(mounts[0], "bwrap");
    assert.ok(!mounts.includes("/"), "the host's root is not bound");
    assert.ok(mounts.join(" ").includes(`--bind ${join(tasks, "WOR-1")} ${join(tasks, "WOR-1")}`), "its clone, read-write");
    assert.ok(!mounts.some((m) => m.startsWith(join(tasks, "WOR-2")) || m === tasks), "no sibling task");
    assert.ok(!mounts.some((m) => m === REPO || (m.startsWith(REPO + "/") && !m.startsWith(join(REPO, "services/runner/bin")))), "of the product checkout only the wrappers");
    assert.ok(mounts.join(" ").includes(`--tmpfs ${join(tasks, "WOR-1", "gcloud-in-task")}`), "a hidden path inside an allowed one stays masked");
    assert.ok(!mounts.includes(join(dir, "gcloud-user")), "a hidden path outside the allowlist is simply absent");
  });

  // The private bwrap (ops/vm/setup.sh) carries the AppArmor exemption; /usr/bin/bwrap keeps the release's policy.
  it("runs with the configured bwrap, with and without the network jail", () => {
    const { dir, c } = setup();
    const jc = { ...c, bwrap: "/opt/aidenhq/bwrap/bwrap" };
    assert.equal(jail(jc, ["true"], { rw: [dir] })[0], "/opt/aidenhq/bwrap/bwrap");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/ip"), "#!/bin/sh\necho '1: lo    inet 127.0.0.1/8 scope host lo'\n");
    chmodSync(join(dir, "bin/ip"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    try {
      assert.equal(jail({ ...jc, pasta: "/usr/bin/pasta" }, ["true"], { rw: [dir] })[5], "/opt/aidenhq/bwrap/bwrap"); // netjail.ts <pasta> <ports> <link> <bwrap> …
    } finally {
      process.env.PATH = path;
    }
  });

  // bin/aidenhq-browse drives the host's pinned browser (ops/vm/setup.sh): every job sees it, none can change it.
  it("binds the host's browser read-only", () => {
    const { dir, c } = setup();
    const browserDir = join(dir, "browser");
    mkdirSync(browserDir);
    const argv = jail({ ...c, browserDir }, ["true"], { rw: [join(dir, "WOR-1")] });
    const mounts = argv.slice(0, argv.indexOf("--die-with-parent")).join(" ");
    assert.ok(mounts.includes(`--ro-bind ${browserDir} ${browserDir}`));
    assert.ok(!mounts.includes(`--bind ${browserDir}`), "never writable");
  });

  // Run for real where bwrap works (the host, CI on Linux): a job can't read a sibling task or the product checkout.
  it("for real, it reads its own clone but not a sibling's or the product checkout", { skip: spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status !== 0 && "bwrap unavailable" }, () => {
    const { dir, c } = setup();
    const tasks = join(dir, "tasks");
    for (const t of ["WOR-1", "WOR-2"]) {
      mkdirSync(join(tasks, t), { recursive: true });
      writeFileSync(join(tasks, t, "f"), t);
    }
    const repo = REPO;
    const argv = jail(c, ["true"], { rw: [join(tasks, "WOR-1")] });
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

  it("with pasta, it gets its own network: of the host's loopback only the ports it was given", () => {
    const { dir, c } = setup();
    const jc = { ...c, pasta: "/usr/bin/pasta" };
    // The host's addresses, as `ip -4 -o addr show` gives them: its LAN is 10.0.2.0/24, the first link candidate.
    mkdirSync(join(dir, "bin"));
    // ...and its routes (`ip -4 route show table all`): a VPN routes 172.31.254.0/24, the second candidate, though no address is on it.
    writeFileSync(join(dir, "bin/ip"), "#!/bin/sh\ncase \"$*\" in *route*) echo 'default via 10.0.2.1 dev eth0'; echo '172.31.254.0/24 via 10.0.2.9 dev eth0'; echo 'local 10.0.2.7 dev eth0 table local proto kernel scope host src 10.0.2.7'; exit 0;; esac\necho '1: lo    inet 127.0.0.1/8 scope host lo'\necho '2: eth0    inet 10.0.2.7/24 brd 10.0.2.255 scope global eth0'\necho '3: br0    inet 203.0.113.9/32 scope global br0'\n");
    chmodSync(join(dir, "bin/ip"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    const argv = jail(jc, ["npm", "test"], { rw: ["/w"], loopback: ["http://127.0.0.1:41000", "http://127.0.0.1:8201"] });
    const none = jail(jc, ["npm", "test"], { rw: ["/w"] });
    process.env.PATH = path;
    assert.equal(argv[0], process.execPath);
    assert.ok(argv[1].endsWith("/netjail.ts"));
    assert.deepEqual([...argv.slice(2, 4), ...argv.slice(5, 8)], ["/usr/bin/pasta", "8201,41000", "bwrap", "--unshare-pid", "--unshare-ipc"]);
    assert.equal(argv[4], "192.168.254"); // pasta's link: apart from the host's 10.0.2.0/24 and the routed 172.31.254.0/24
    assert.ok(argv.includes("--unshare-net") && argv.includes("--die-with-parent"));
    // The public resolvers sit on its own tmpfs, not on the host's resolver file (whose rewrites detach a bind).
    const rc = argv.indexOf("/etc/resolv.conf");
    assert.deepEqual(argv.slice(rc - 4, rc), ["--tmpfs", "/run/systemd/resolve", "--ro-bind-data", "5"]);
    const at = argv.indexOf("aidenhq-jail");
    assert.deepEqual(argv.slice(at + 1), ["npm", "test"]); // the command itself, after the jail's own setup
    // Its first step: private and reserved ranges, and each of the host's own addresses (a public one too), are unreachable.
    for (const n of ["192.168.0.0/16", "240.0.0.0/4", "10.0.2.7/32", "203.0.113.9/32"]) assert.ok(argv[at - 1].split(/[ ;]/).includes(n), n);
    assert.equal(none[3], "none", "no host port when none is given");
  });

  it("reports a reason instead of throwing when no link candidate is free", () => {
    const { dir, c } = setup();
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/ip"), "#!/bin/sh\ncase \"$*\" in *route*) exit 0;; esac\nfor n in 10.0.2.1 172.31.254.1 192.168.254.1 100.127.254.1; do echo \"1: eth0    inet $n/24 scope global eth0\"; done\n");
    chmodSync(join(dir, "bin/ip"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, "bin")}:${path}`;
    try {
      const reason = jailProblem({ ...c, bwrap: "bwrap", pasta: "/usr/bin/pasta", binDir: join(dir, "bin"), browserDir: "/opt/aidenhq/browser" });
      assert.match(reason ?? "", /no free subnet for the job's network link: every candidate overlaps a host network/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("masks the runner's state db (every run's helper token)", () => {
    const dir = mkdtempSync(join(tmpdir(), "k-cfg-"));
    const cfg = sandboxConfig((k) => (k === "AIDENHQ_CONFIG_DIR" ? dir : process.env[k]));
    for (const x of ["", "-wal", "-shm"]) assert.ok(cfg.hidden.includes(join(cfg.stateDir, `state.sqlite${x}`)), `state.sqlite${x} hidden`);
    assert.ok(!cfg.hidden.includes(cfg.stateDir));
    for (const p of ["/run/docker.sock", "/run/tailscale/tailscaled.sock"]) assert.ok(cfg.hidden.includes(p), p);
  });
});

// Hostile-code checks (spec §8.9): what repo code or a job could use to reach past its own task folder.
describe("hostile jobs", () => {
  it("H2: the host sandbox hides the vault, the data dir, the Docker and tailscaled sockets and the user's runtime dir", () => {
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

  it("H3: a job runs in its computer: no connection URL or token in its spec, the run token its only key; private data never meets the web", () => {
    const d = mkdtempSync(join(tmpdir(), "h3-"));
    mkdirSync(join(d, "job"));
    const cfg = { bwrap: "bwrap", hidden: [], binDir: join(d, "bin"), browserDir: "/opt/aidenhq/browser", workDir: join(d, "work"), stateDir: join(d, "state"), logsDir: join(d, "logs"), secretsDir: join(d, "vault"), enginesFile: ENGINES, gatewayUrl: "http://127.0.0.1:8201", boxGatewayUrl: "http://10.231.2.1:8200", boxDir: join(d, "boxes"), timeout_minutes: 60, stall_minutes: 15, progress_minutes: 35 };
    const box = { container: "aidenhq-computer-x", envFile: "/e", outDir: "/o" };
    for (const reads of [false, true]) {
      const jobDir = join(d, `job-${reads}`);
      mkdirSync(jobDir);
      const { argv, spec } = buildJob({ cfg, engine: { kind: "codex-openrouter", model: "m", ...(reads ? { reads: true } : {}) }, worktree: join(d, "w"), jobDir, job: { issueId: "x" }, box, boxWrap: 'exec "$@"' });
      assert.deepEqual(argv.slice(0, 4), ["docker", "exec", "--env-file", "/e"]);
      assert.deepEqual([spec.mcp, spec.model.token_env, spec.model.base_url, spec.sandbox.kind], [[], "AIDENHQ_RUN_TOKEN", "http://10.231.2.1:8200/api/v1", "box"]);
      assert.doesNotMatch(JSON.stringify(spec), /_mcp_(read_)?token|127\.0\.0\.1/);
      assert.match(codexCommand(spec, "/aidenhq-out/job", {}).argv.join(" "), reads ? /web_search="disabled"/ : /web_search="live"/);
    }
    // An engine that doesn't run in a computer runs nowhere.
    const reg = JSON.parse(execFileSync("cat", [ENGINES], { encoding: "utf8" }));
    const hostOnly = Object.keys(reg).find((k) => reg[k].box !== true);
    if (hostOnly) assert.throws(() => buildJob({ cfg, engine: { kind: hostOnly }, worktree: join(d, "w"), jobDir: join(d, "job"), box, boxWrap: "" }), /doesn't run in an agent computer/);
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
