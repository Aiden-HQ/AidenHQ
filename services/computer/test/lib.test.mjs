// The launcher's logic: run tokens, what a box's exec gets, the box's Codex config, admission. Docker itself is proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Tokens, Creds, admit, builtImage, dockerRunArgs, oomMessage, execEnv, routineArgs, mcpBlock, stale, wrapExec, runCredential, CP_SCRIPT, CODEX_CONFIG_SCRUB, checkoutRequest, archiveArgs, UNTAR_SCRIPT, RUN_TOKEN_PATH, WRITE_RUN_TOKEN_SCRIPT, CLEAR_RUN_TOKEN_SCRIPT } from "../lib.mjs";
import { host as localHost } from "../../../modules/codehost-local/src/host.mjs";
import { ensureClone } from "../../../modules/codehost-local/src/git.mjs";

test("a run token names its agent until the run ends; a new run gets a new one", () => {
  const t = new Tokens();
  const a = t.issue("box1", "agent-1");
  assert.match(a, /^ahqc_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(t.whoami(a), { agentId: "agent-1", container: "box1", runId: null, issueId: null });
  // The first exec from Paperclip binds the run and task (what the model gateway caps by); it survives a reload.
  assert.equal(t.bind("box1", { runId: "run-1", issueId: "iss-1" }), true);
  assert.equal(t.bind("box1", { runId: "run-1", issueId: "iss-1" }), false);
  const reloaded = new Tokens();
  reloaded.load(t.dump());
  assert.deepEqual(reloaded.whoami(a), { agentId: "agent-1", container: "box1", runId: "run-1", issueId: "iss-1" });
  const b = t.issue("box1", "agent-1");
  assert.equal(t.whoami(a), undefined);
  assert.equal(t.current("box1"), b);
  t.revoke("box1");
  assert.equal(t.whoami(b), undefined);
  const c = t.issue("box2", "agent-2", 0);
  assert.equal(t.whoami(c, 7 * 3600_000), undefined, "expires");
  assert.equal(t.whoami("forged"), undefined);
});

test("an exec gets no real key, no AIDENHQ_* token, and this run's token", () => {
  const e = execEnv({ OPENROUTER_API_KEY: "sk-or-real", OPENAI_API_KEY: "sk-real", AIDENHQ_BOARD_TOKEN: "b", AIDENHQ_SLACK_MCP_TOKEN: "s", PAPERCLIP_API_KEY: "bridge", PATH: "/bin" }, { token: "ahqc_x" });
  assert.deepEqual(e, { OPENAI_API_KEY: "unused", PAPERCLIP_API_KEY: "bridge", PATH: "/bin", AIDENHQ_RUN_TOKEN: "ahqc_x" });
  assert.equal(execEnv({ CODEX_HOME: "/h" }, { token: "t", mcp: "x" }).AIDENHQ_MCP_B64, "eA==");
  // Paperclip's own server env, seen live on some execs: never into a box. The box's bridge credential stays.
  const server = { BETTER_AUTH_SECRET: "s", PAPERCLIP_AGENT_JWT_SECRET: "j", PAPERCLIP_AGENT_PRIVATE_KEY: "p", PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/k", PAPERCLIP_GITHUB_BROKER_TOKEN: "g", GH_TOKEN: "", DATABASE_URL: "postgres://x" };
  assert.deepEqual(execEnv({ ...server, PAPERCLIP_BRIDGE_TOKEN: "b", PAPERCLIP_API_KEY: "k", PAPERCLIP_TASK_ID: "t" }, {}), { PAPERCLIP_BRIDGE_TOKEN: "b", PAPERCLIP_API_KEY: "k", PAPERCLIP_TASK_ID: "t" });
});

test("the box's Codex config lists only granted connections, through the gateway, keyed by the run token", () => {
  const conns = { apps: { tool_timeout_sec: 600 }, slack: { tool_timeout_sec: 300 }, paperclip_tasks: { tool_timeout_sec: 300 } };
  const b = mcpBlock({ apps: ["app_list"], paperclip_tasks: ["task_finish"] }, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/apps\/mcp"\nenv_http_headers = \{ "X-Agent-Key" = "AIDENHQ_RUN_TOKEN" \}\nenabled_tools = \["app_list"\]/);
  // The tasks tools too: no stdio bridge in the box any more.
  assert.match(b, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(b, /slack|command/);
});

test("the scrub drops Paperclip's JWT block and the shared block, adds ours once, and refuses a leftover token", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"));
  const f = join(home, "config.toml");
  const original = 'model = "x"\n\n# >>> aidenhq (managed)\n[mcp_servers.apps]\nurl = "http://apps-mcp:8090/mcp"\n# <<< aidenhq\n\n# BEGIN PAPERCLIP MANAGED MCP\n[mcp_servers.paperclip-projects]\nhttp_headers = { Authorization = "Bearer eyJhbGciOi.x.y" }\n# END PAPERCLIP MANAGED MCP\n';
  writeFileSync(f, original);
  const block = mcpBlock({ apps: ["app_list"] }, { apps: { url: "http://apps-mcp:8090/mcp" } }, "http://gw");
  const env = { ...process.env, CODEX_HOME: home, AIDENHQ_MCP_B64: Buffer.from(block).toString("base64") };
  const run = () => execFileSync("sh", ["-c", CODEX_CONFIG_SCRUB, "x", "cat", f], { env, encoding: "utf8" });
  run();
  const out = run(); // twice: still one copy of ours
  assert.equal((out.match(/\[mcp_servers\.apps\]/g) ?? []).length, 1);
  assert.doesNotMatch(out, /eyJ|PAPERCLIP MANAGED|apps-mcp:8090/);
  assert.match(out, /^model = "x"/);
  writeFileSync(f, 'x = "eyJleftover"\n');
  assert.throws(() => run(), (e) => e.status === 97);
  assert.equal(readFileSync(f, "utf8").includes("eyJleftover"), true);
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

test("a box's Paperclip credential survives a launcher restart (dump/load) and goes on delete", () => {
  const c = new Creds();
  assert.equal(c.get("box1"), undefined);
  c.set("box1", { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge", taskId: "issue-1" });
  assert.deepEqual(c.get("box1"), { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge", taskId: "issue-1" });
  // The detached turn outlives the launcher: the saved file reloads into /cp's lookup as it was.
  const reloaded = new Creds();
  reloaded.load(JSON.parse(JSON.stringify(c.dump())));
  assert.deepEqual(reloaded.get("box1"), { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge", taskId: "issue-1" });
  // Rows a broken file might carry are skipped, never a credential without a key.
  const junk = new Creds();
  junk.load([{ container: "box2", apiUrl: "http://127.0.0.1:1" }, null]);
  assert.equal(junk.get("box2"), undefined);
  // The box's token is revoked: the credential goes with it, so a later box reusing the name has none.
  reloaded.delete("box1");
  assert.equal(reloaded.get("box1"), undefined);
  const afterRestart = new Creds();
  afterRestart.load(reloaded.dump());
  assert.equal(afterRestart.get("box1"), undefined);
});

test("a credential goes when its box's token does, expiry included", () => {
  const creds = new Creds();
  const tokens = new Tokens({ onRevoke: (container) => creds.delete(container) });
  const token = tokens.issue("box1", "agent-1", 0);
  creds.set("box1", { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge" });
  assert.ok(creds.get("box1"));
  assert.equal(tokens.whoami(token, 7 * 3600_000), undefined); // expired: whoami revokes
  assert.equal(creds.get("box1"), undefined);
  // A new token for the same name (a resumed box, or a reused name) takes the old credential with it.
  tokens.issue("box1", "agent-2");
  creds.set("box1", { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge-2" });
  tokens.revoke("box1");
  assert.equal(creds.get("box1"), undefined);
});

test("the cp script makes one control-plane call through the box's bridge with the key from stdin, never argv", async () => {
  const got = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(201, { "content-type": "application/json" }).end('{"id":"c1"}'); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const ch = spawn(process.execPath, ["-e", CP_SCRIPT]);
  let out = "";
  ch.stdout.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => { ch.on("close", resolve); ch.stdin.end(JSON.stringify({ url, key: "bridge", method: "POST", path: "/api/issues/issue-1/comments", body: Buffer.from('{"body":"hi"}').toString("base64") })); });
  srv.close();
  assert.equal(code, 0);
  const r = JSON.parse(out.trim());
  assert.deepEqual([r.status, Buffer.from(r.body, "base64").toString()], [201, '{"id":"c1"}']);
  assert.deepEqual(got, [{ method: "POST", url: "/api/issues/issue-1/comments", auth: "Bearer bridge", body: { body: "hi" } }]);
  assert.ok(!CP_SCRIPT.includes("bridge\""));
});

test("repo-checkout: only the agents org, only a full SHA; the launcher picks the folder", () => {
  const opts = { agentsOrg: "acme-agents", cacheRoot: "/w/repos" };
  const sha = "a".repeat(40);
  assert.deepEqual(checkoutRequest({ repo: "ACME-agents/roadmap-keeper", sha }, opts), { cache: "/w/repos/acme-agents/roadmap-keeper", sha, dest: "/workspace/repos/roadmap-keeper" });
  for (const bad of [{ repo: "other-org/x", sha }, { repo: "acme-agents/..", sha }, { repo: "acme-agents/x", sha: "abc123" }, { repo: "acme-agents/x", sha: "main" }, { repo: "acme-agents/x/y", sha }]) {
    assert.throws(() => checkoutRequest(bad, opts));
  }
  assert.throws(() => checkoutRequest({ repo: "acme-agents/x", sha }, { cacheRoot: "/w/repos" }), /agents org/);
  // With codehost-local on, this server's repos are checked out from the runner's cache clone too.
  const both = { agentsOrg: "acme-agents", agentsOrgs: ["acme-agents", "local"], cacheRoot: "/w/repos" };
  assert.deepEqual(checkoutRequest({ repo: "local/expense-tracker", sha }, both), { cache: "/w/repos/local/expense-tracker", sha, dest: "/workspace/repos/expense-tracker" });
  assert.throws(() => checkoutRequest({ repo: "local/expense-tracker", sha }, opts), /agents org/);
});

// The UI Reviewer on an instance with no GitHub: `repo-checkout local/<name> <sha>` places a change request's head from the
// runner's cache clone of this server's bare repo (codehost-local), exactly where the launcher looks for it.
test("repo-checkout local/<name> <sha>: a local change's head, from the runner's cache clone of the bare repo", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "checkout-local-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = localHost({ dataDir: join(dir, "data"), workDir: join(dir, "work") });
  await h.createRepo("local/expense-tracker");
  const work = join(dir, "clone");
  const sh = (...a) => execFileSync("git", ["-C", work, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "-q", h.bare("local/expense-tracker"), work]);
  sh("checkout", "-qb", "feat/page");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/page.tsx"), "export const Page = () => null;\n");
  sh("add", "-A"), sh("commit", "-qm", "feat: page");
  await h.publish({ path: work, slug: "local/expense-tracker", sha: sh("rev-parse", "HEAD"), branch: "feat/page" });
  const { number } = await h.openChange({ slug: "local/expense-tracker", branch: "feat/page", base: "main", title: "feat: page" });
  const { head } = await h.readChange("local/expense-tracker", number);
  // The runner refreshes its cache clone before filing the design review (main.mjs publishLocal); the launcher reads it.
  const runnerWork = join(dir, "runner-work");
  const cachePath = await ensureClone(runnerWork, { org: "local", name: "expense-tracker", slug: "local/expense-tracker" }, h.bare("local/expense-tracker"));
  const { cache, sha, dest } = checkoutRequest({ repo: "local/expense-tracker", sha: head }, { agentsOrgs: ["local"], cacheRoot: join(runnerWork, "repos") });
  assert.equal(cache, cachePath);
  const box = join(dir, "box", dest);
  execFileSync("sh", ["-c", UNTAR_SCRIPT, "sh", box], { input: execFileSync("git", archiveArgs(cache, sha)) });
  assert.equal(readFileSync(join(box, "src/page.tsx"), "utf8"), "export const Page = () => null;\n");
  assert.ok(existsSync(join(box, "README.md")));
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
  const tar = execFileSync("git", archiveArgs(repo, sha));
  const dest = join(dir, "box", "repos", "repo");
  execFileSync("sh", ["-c", UNTAR_SCRIPT, "sh", dest], { input: tar });
  assert.ok(existsSync(join(dest, "src/app.ts")));
  assert.ok(!existsSync(join(dest, ".aidenhq")), "the top-level .aidenhq/ is left out");
  assert.ok(!existsSync(join(dest, "web/.aidenhq")), "and a nested one");
  // Most repositories have no .aidenhq/ at all: the exclude matching nothing must not fail the archive.
  execFileSync("git", ["-C", repo, "rm", "-rq", ".aidenhq", "web/.aidenhq"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-qm", "plain"]);
  const plain = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("sh", ["-c", UNTAR_SCRIPT, "sh", dest], { input: execFileSync("git", archiveArgs(repo, plain)) });
  assert.ok(existsSync(join(dest, "src/app.ts")));
});

test("repo-checkout reads this run's token from the launcher's file, never a stale env value", () => {
  // The original failure: once the run rotates, the earlier token is dead and the gateway answers 401 not a live computer.
  const t = new Tokens();
  const stale = t.issue("box1", "agent-1");
  const current = t.issue("box1", "agent-1");
  assert.equal(t.whoami(stale), undefined);
  assert.equal(t.whoami(current)?.agentId, "agent-1");

  const dir = mkdtempSync(join(tmpdir(), "repo-checkout-"));
  const tokenFile = join(dir, "run-token");
  const record = join(dir, "sent");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nfor a in "$@"; do case "$a" in X-Agent-Key:*) printf "%s" "${a#X-Agent-Key: }" > "$RECORD" ;; esac; done\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
  const script = join(dirname(fileURLToPath(import.meta.url)), "../images/agent-base/repo-checkout");
  const run = () => spawnSync("sh", [script, "acme-agents/roadmap-keeper", "a".repeat(40)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RECORD: record, AIDENHQ_RUN_TOKEN: stale, AIDENHQ_RUN_TOKEN_FILE: tokenFile },
  });

  writeFileSync(tokenFile, current, { mode: 0o600 });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(record, "utf8"), current);

  rmSync(tokenFile);
  const gone = run();
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /no live run token/);
  assert.equal(readFileSync(record, "utf8"), current, "it never falls back to the stale env token");
});

test("the launcher hands the box its token on stdin and clears it at the end of the run", () => {
  assert.equal(RUN_TOKEN_PATH, "/dev/shm/aidenhq/run-token");
  assert.match(WRITE_RUN_TOKEN_SCRIPT, /cat > \/dev\/shm\/aidenhq\/run-token/);
  assert.match(WRITE_RUN_TOKEN_SCRIPT, /chmod 600/);
  assert.match(CLEAR_RUN_TOKEN_SCRIPT, /rm -f \/dev\/shm\/aidenhq\/run-token/);
  for (const s of [WRITE_RUN_TOKEN_SCRIPT, CLEAR_RUN_TOKEN_SCRIPT]) assert.doesNotMatch(s, /ahqc_/);
});

test("only execs carrying a CODEX_HOME are wrapped", () => {
  assert.deepEqual(wrapExec("ls", ["-l"], {}), ["ls", ["-l"]]);
  const [cmd, args] = wrapExec("codex", ["exec"], { CODEX_HOME: "/h" });
  assert.equal(cmd, "sh");
  assert.deepEqual(args.slice(2), ["aidenhq-computer", "codex", "exec"]);
});

test("a run's Paperclip credential comes from the exec env (bridge URL + key + task)", () => {
  assert.equal(runCredential({ PATH: "/bin" }), undefined);
  assert.deepEqual(runCredential({ PAPERCLIP_API_URL: "http://127.0.0.1:4567", PAPERCLIP_API_KEY: "bridge", PAPERCLIP_TASK_ID: "issue-1" }), { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge", taskId: "issue-1" });
});
