// The launcher's logic: the box's Codex config, admission, repo-checkout. Docker itself is proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, dockerRunArgs, mcpBlock, stale, CODEX_CONFIG_SCRUB, checkoutDest, UNTAR_SCRIPT } from "../lib.ts";

test("the box's Codex config lists only granted connections, through the gateway, keyed by the job token", () => {
  const conns = { apps: { tool_timeout_sec: 600 }, slack: { tool_timeout_sec: 300 }, paperclip_tasks: { tool_timeout_sec: 300 } };
  const b = mcpBlock({ apps: ["app_list"], paperclip_tasks: ["task_finish"] }, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/apps\/mcp"\nenv_http_headers = \{ "X-Agent-Key" = "AIDENHQ_RUN_TOKEN" \}\nenabled_tools = \["app_list"\]/);
  // The tasks tools too: no stdio bridge in the box any more.
  assert.match(b, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(b, /slack|command/);
});

test("the scrub replaces our block with this job's, once", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"));
  const f = join(home, "config.toml");
  writeFileSync(f, 'model = "x"\n\n# >>> aidenhq (managed)\n[mcp_servers.apps]\nurl = "http://apps-mcp:8090/mcp"\n# <<< aidenhq\n');
  const block = mcpBlock({ apps: ["app_list"] }, { apps: { url: "http://apps-mcp:8090/mcp" } }, "http://gw");
  const env = { ...process.env, CODEX_HOME: home, AIDENHQ_MCP_B64: Buffer.from(block).toString("base64") };
  const run = () => execFileSync("sh", ["-c", CODEX_CONFIG_SCRUB, "x", "cat", f], { env, encoding: "utf8" });
  run();
  const out = run(); // twice: still one copy of ours
  assert.equal((out.match(/\[mcp_servers\.apps\]/g) ?? []).length, 1);
  assert.doesNotMatch(out, /apps-mcp:8090/);
  assert.match(out, /^model = "x"/);
});

test("docker run: gVisor, the computers network, limits and mounts from config", () => {
  const a = dockerRunArgs({ name: "aidenhq-computer-1", image: "img:1", agentId: "ag", network: "aidenhq-computers", limits: { memory: "2g", cpus: 2, shm: "512m", pids: 1024 }, mounts: ["/r:/etc/resolv.conf:ro"] });
  for (const want of ["--runtime=runsc", "aidenhq-computers", "2g", "aidenhq.agent=ag", "/r:/etc/resolv.conf:ro"]) assert.ok(a.includes(want), want);
  assert.deepEqual(a.slice(-3), ["img:1", "sleep", "infinity"]);
});

test("admission: room → go; full → evict the least recently used idle box; all busy → wait; idle boxes are reaped", () => {
  const boxes = new Map([["a", { lastUsed: 5, busy: 0 }], ["b", { lastUsed: 1, busy: 1 }], ["c", { lastUsed: 3, busy: 0 }]]);
  assert.equal(admit(boxes, 6), null);
  assert.equal(admit(boxes, 3), "c");
  boxes.get("a").busy = 1; boxes.get("c").busy = 1;
  assert.equal(admit(boxes, 3), "wait");
  boxes.get("c").busy = 0;
  assert.deepEqual(stale(boxes, 10, 100), ["c"]);
});

test("repo-checkout: the launcher picks the folder from the name alone", () => {
  assert.equal(checkoutDest("acme-agents/roadmap-keeper.git"), "/workspace/repos/roadmap-keeper");
  for (const bad of ["acme-agents/..", "acme-agents/x/y", "x", "../x"]) assert.throws(() => checkoutDest(bad));
});

// A design review passed on PNGs an earlier PR had committed under .aidenhq/out/: the checkout carried them as if they
// showed the head. The snapshot leaves every .aidenhq/ folder out, so a reviewer has only its own captures to look at.
test("repo-checkout's snapshot leaves out every .aidenhq/ folder", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "checkout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  for (const f of ["src/app.ts", ".aidenhq/out/final/plan-1440-light.png", "web/.aidenhq/out/home.png"]) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), "x");
  }
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar.gz", sha]);
  const dest = join(dir, "box", "repos", "repo");
  execFileSync("sh", ["-c", UNTAR_SCRIPT, "sh", dest], { input: tar });
  assert.ok(existsSync(join(dest, "src/app.ts")));
  assert.ok(!existsSync(join(dest, ".aidenhq")), "the top-level .aidenhq/ is left out");
  assert.ok(!existsSync(join(dest, "web/.aidenhq")), "and a nested one");
  // Most repositories have no .aidenhq/ at all: the cleanup matching nothing must not fail the untar.
  execFileSync("git", ["-C", repo, "rm", "-rq", ".aidenhq", "web/.aidenhq"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-qm", "plain"]);
  const plain = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("sh", ["-c", UNTAR_SCRIPT, "sh", dest], { input: execFileSync("git", ["-C", repo, "archive", "--format=tar.gz", plain]) });
  assert.ok(existsSync(join(dest, "src/app.ts")));
});

test("repo-checkout sends the job's own token to the gateway", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-checkout-"));
  const record = join(dir, "sent");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nfor a in "$@"; do case "$a" in X-Agent-Key:*) printf "%s" "${a#X-Agent-Key: }" > "$RECORD" ;; esac; done\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
  const script = join(dirname(fileURLToPath(import.meta.url)), "../images/agent-base/repo-checkout");
  const run = (token) => spawnSync("sh", [script, "acme-agents/roadmap-keeper", "a".repeat(40)], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECORD: record, AIDENHQ_RUN_TOKEN: token } });
  const ok = run("ahqj_job.sig");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(record, "utf8"), "ahqj_job.sig");
  const none = run("");
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no job token/);
  rmSync(dir, { recursive: true, force: true });
});
