// The launcher's logic: run tokens, what a box's exec gets, the box's Codex config, admission. Docker itself is proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Tokens, admit, dockerRunArgs, execEnv, routineArgs, mcpBlock, stale, wrapExec, runCredential, replyRefusal, REPLY_SCRIPT, CODEX_CONFIG_SCRUB, checkoutRequest, usageTap, RUN_TOKEN_PATH, WRITE_RUN_TOKEN_SCRIPT, CLEAR_RUN_TOKEN_SCRIPT } from "../lib.mjs";

test("only execs carrying a CODEX_HOME are wrapped", () => {
  assert.deepEqual(wrapExec("ls", ["-l"], {}), ["ls", ["-l"]]);
  const [cmd, args] = wrapExec("codex", ["exec"], { CODEX_HOME: "/h" });
  assert.equal(cmd, "sh");
  assert.deepEqual(args.slice(2), ["aidenhq-computer", "codex", "exec"]);
});

test("a routine's model and effort replace the agent's in a box's codex exec, before execEnv strips them", () => {
  const args = ["exec", "--json", "--model", "agent-m", "-c", 'model_reasoning_effort="high"', "-c", "x=1", "-"];
  const env = { AIDENHQ_MODEL: "routine-m", AIDENHQ_REASONING_EFFORT: "low" };
  assert.deepEqual(routineArgs("codex", args, env), ["exec", "--model", "routine-m", "-c", 'model_reasoning_effort="low"', "--json", "-c", "x=1", "-"]);
  assert.deepEqual(routineArgs("codex", args, {}), args);
  assert.deepEqual(routineArgs("sh", args, env), args);
  assert.ok(!("AIDENHQ_MODEL" in execEnv(env, {})));
});

test("a run token names its agent until the run ends; a new run gets a new one", () => {
  const t = new Tokens();
  const a = t.issue("box1", "agent-1");
  assert.match(a, /^ahqc_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(t.whoami(a), { agentId: "agent-1", container: "box1" });
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
  const conns = { apps: { url: "http://apps-mcp:8090/mcp", tool_timeout_sec: 600 }, slack: { url: "http://slack-mcp:8082/mcp", bearer_secret: "slack_mcp_token" }, paperclip_tasks: { command: "node", args: ["/opt/aidenhq/paperclip-tasks-mcp.mjs"], env_vars: ["PAPERCLIP_API_KEY"] } };
  const b = mcpBlock({ apps: ["app_list"], paperclip_tasks: ["task_finish"] }, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/apps\/mcp"\nenv_http_headers = \{ "X-Agent-Key" = "AIDENHQ_RUN_TOKEN" \}\nenabled_tools = \["app_list"\]/);
  assert.match(b, /\[mcp_servers\.paperclip_tasks\]\ncommand = "node"/);
  assert.doesNotMatch(b, /slack|slack_mcp_token/);
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

test("a run's Paperclip credential comes from the exec env (bridge URL + key + task); posting is limited to that task", () => {
  assert.equal(runCredential({ PATH: "/bin" }), undefined);
  const c = runCredential({ PAPERCLIP_API_URL: "http://127.0.0.1:4567", PAPERCLIP_API_KEY: "bridge", PAPERCLIP_TASK_ID: "issue-1" });
  assert.deepEqual(c, { apiUrl: "http://127.0.0.1:4567", apiKey: "bridge", taskId: "issue-1" });
  assert.equal(replyRefusal(c, "issue-1", "hi"), null);
  assert.match(replyRefusal(c, "issue-2", "hi"), /only on its own task/);
  assert.match(replyRefusal(undefined, "issue-1", "hi"), /no Paperclip credential/);
  assert.match(replyRefusal({ ...c, taskId: undefined }, "issue-1", "hi"), /only on its own task/);
  assert.match(replyRefusal(c, "issue-1", ""), /body/);
});

test("the reply script posts the comment through the box's bridge with the key from stdin, never argv", async () => {
  const got = [];
  const srv = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(201).end("{}"); }); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const run = (input) => new Promise((resolve) => {
    const ch = spawn(process.execPath, ["-e", REPLY_SCRIPT]);
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.on("close", (code) => resolve({ code, out }));
    ch.stdin.end(JSON.stringify(input));
  });
  const r = await run({ url, key: "bridge", issueId: "issue-1", body: "line 1\n<!-- aidenhq-reply -->" });
  srv.close();
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "201");
  assert.deepEqual(got, [{ url: "/api/issues/issue-1/comments", auth: "Bearer bridge", body: { body: "line 1\n<!-- aidenhq-reply -->" } }]);
  assert.ok(!REPLY_SCRIPT.includes("bridge"));
});

test("repo-checkout: only the agents org, only a full SHA; the launcher picks the folder", () => {
  const opts = { agentsOrg: "acme-agents", cacheRoot: "/w/repos" };
  const sha = "a".repeat(40);
  assert.deepEqual(checkoutRequest({ repo: "ACME-agents/roadmap-keeper", sha }, opts), { cache: "/w/repos/acme-agents/roadmap-keeper", sha, dest: "/workspace/repos/roadmap-keeper" });
  for (const bad of [{ repo: "other-org/x", sha }, { repo: "acme-agents/..", sha }, { repo: "acme-agents/x", sha: "abc123" }, { repo: "acme-agents/x", sha: "main" }, { repo: "acme-agents/x/y", sha }]) {
    assert.throws(() => checkoutRequest(bad, opts));
  }
  assert.throws(() => checkoutRequest({ repo: "acme-agents/x", sha }, { cacheRoot: "/w/repos" }), /agents org/);
});

test("repo-checkout reads this run's token from the launcher's file, never a stale env value", () => {
  // The original failure: once the run rotates, the earlier token is dead and the gateway answers 401 not a live computer.
  const t = new Tokens();
  const stale = t.issue("box1", "agent-1");
  const current = t.issue("box1", "agent-1");
  assert.equal(t.whoami(stale), undefined);
  assert.deepEqual(t.whoami(current), { agentId: "agent-1", container: "box1" });

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

test("the gateway reads OpenRouter's billed cost from a streamed answer, split across chunks", () => {
  const done = { type: "response.completed", response: { id: "gen-1", model: "deepseek/deepseek-v4.1-flash-1017", usage: { input_tokens: 17000, input_tokens_details: { cached_tokens: 3584 }, output_tokens: 44, output_tokens_details: { reasoning_tokens: 1 }, cost: 0.002369 } } };
  const sse = `event: response.created\ndata: {"type":"response.created","response":{"id":"gen-1"}}\n\nevent: response.completed\ndata: ${JSON.stringify(done)}\n\n`;
  const tap = usageTap();
  for (let i = 0; i < sse.length; i += 37) tap.feed(sse.slice(i, i + 37));
  assert.deepEqual(tap.done(), { key: "gen-1", model: "deepseek/deepseek-v4.1-flash-1017", input: 13416, cached: 3584, output: 44, costUsd: 0.002369 });
  const none = usageTap();
  none.feed('data: {"type":"response.failed"}\n');
  assert.equal(none.done(), undefined);
});
