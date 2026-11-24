// The launcher's logic: the box's Codex config, admission, repo-checkout. Docker itself is proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WARM_MS, admit, compatKey, emitsServer, Jobs, mcpBlock, stale, tokenHash, unemittedServers } from "../lib.ts";

test("the box's Codex config lists only granted connections, through the gateway, keyed by the job token", () => {
  const conns = { apps: { tool_timeout_sec: 600 }, slack: { tool_timeout_sec: 300 }, paperclip_tasks: { tool_timeout_sec: 300 } };
  const b = mcpBlock({ apps: ["app_list"], paperclip_tasks: ["task_finish"] }, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/apps\/mcp"\nenv_http_headers = \{ "X-Agent-Key" = "AIDENHQ_RUN_TOKEN" \}\nenabled_tools = \["app_list"\]/);
  // The tasks tools too: no stdio bridge in the box any more.
  assert.match(b, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(b, /slack|command/);
});

test("the shared rule: a declared server is emitted only with tools, a connection entry and a Codex-safe name", () => {
  const conns = { apps: {}, github: {}, jira: {}, slack: {} };
  const tools = { apps: ["app_list"], github: [] };
  assert.deepEqual(unemittedServers(["apps"], tools, conns), []); // present: emitted
  assert.deepEqual(unemittedServers(["github"], tools, conns), ["github"]); // an empty tools entry is no server
  assert.deepEqual(unemittedServers(["jira"], tools, conns), ["jira"]); // no tools entry at all
  assert.deepEqual(unemittedServers(["slack"], { slack: ["search"] }, conns), []); // present, tools in the frozen set
  assert.deepEqual(unemittedServers(["slack"], { slack: ["search"] }, {}), ["slack"]); // no connection entry
  assert.deepEqual(unemittedServers(["slack.mcp"], { "slack.mcp": ["search"] }, { "slack.mcp": {} }), ["slack.mcp"]); // a name Codex refuses
  assert.deepEqual(unemittedServers(["apps", "github", "slack"], tools, conns), ["github", "slack"]);
  // A name that only exists on Object.prototype is not a present server.
  assert.deepEqual(unemittedServers(["toString"], {}, conns), ["toString"]);
  assert.deepEqual(unemittedServers(["constructor"], { constructor: ["x"] }, conns), ["constructor"]);
  assert.equal(emitsServer("toString", tools, conns), false);
  // A null connection entry is no entry, exactly as `mcpBlock` treats it: the check and the renderer never disagree.
  assert.deepEqual(unemittedServers(["slack"], { slack: ["search"] }, { slack: null }), ["slack"]);
  assert.doesNotMatch(mcpBlock({ slack: ["search"] }, { slack: null }, "http://10.231.2.1:8200"), /\[mcp_servers\.slack\]/);
  assert.equal(emitsServer("apps", tools, conns), true);
  assert.equal(emitsServer("github", tools, conns), false);
  // The block and the rule agree: a server it lists is one the predicate calls emitted.
  const b = mcpBlock(tools, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]/);
  assert.doesNotMatch(b, /\[mcp_servers\.github\]/);
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

test("a task's box is leased to one job at a time: a late renew or release of an earlier lease touches nothing; parked, its token opens nothing", () => {
  const jobs = new Jobs();
  jobs.add({ container: "box", agentId: "a1", issueId: "t1", kernel: true, tokenHash: tokenHash("ahqj_one"), job: "j1", gen: 1, compat: "k" }, 0);
  assert.ok(jobs.renew("box", { issueId: "t1", gen: 1 }, 1));
  jobs.revoke("box");
  assert.equal(jobs.byKernelToken("ahqj_one"), undefined, "the job's token is revoked at its release");
  jobs.park("box", 2);
  assert.equal(jobs.leased("box", 3), false, "a parked box holds no lease: admission may evict it, the idle reaper takes it");
  assert.deepEqual(jobs.lapsed(10 ** 12), [], "a parked box is no lapsed lease");
  assert.equal(jobs.renew("box", { issueId: "t1", gen: 1 }, 3), undefined, "nothing renews a parked box");
  jobs.lease("box", { job: "j2", tokenHash: tokenHash("ahqj_two"), roles: [] }, 4);
  assert.equal(jobs.get("box").gen, 2);
  assert.equal(jobs.current("box", 1), false, "the first job's late release is not this lease");
  assert.equal(jobs.renew("box", { issueId: "t1", gen: 1 }, 5), undefined);
  assert.ok(jobs.renew("box", { issueId: "t1", gen: 2 }, 5));
  assert.equal(jobs.byKernelToken("ahqj_two").container, "box");
  // A record saved before leases had generations is generation 0, so its kernel's release (no gen) still ends it.
  jobs.add({ container: "old", issueId: "t2", kernel: true }, WARM_MS);
  assert.equal(jobs.current("old", undefined), true);
  // The idle reaper takes a parked box WARM_MS after it was parked, never a leased one.
  const boxes = new Map([["box", { lastUsed: 0, busy: 0 }], ["old", { lastUsed: 0, busy: 0 }]]);
  jobs.park("box", 0);
  assert.deepEqual(stale(boxes, WARM_MS, WARM_MS + 1, (n) => jobs.leased(n, WARM_MS + 1)), ["box"]);
});

test("a parked box fits the next job only with the same run line and the very folders it mounted", () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-"));
  const ws = join(dir, "PEN-1"), home = join(dir, "home");
  mkdirSync(ws); mkdirSync(home);
  const args = ["run", "-v", `${ws}:/workspace`, "img:1"];
  const k = compatKey(args, [ws, home]);
  assert.equal(compatKey([...args], [ws, home]), k);
  assert.notEqual(compatKey(["run", "-v", `${ws}:/workspace`, "img:2"], [ws, home]), k, "a new image is a new box");
  // The workspace removed and made again (aidenhq cleanup, the disk sweep): the parked box's mount holds the old folder.
  rmSync(ws, { recursive: true }); mkdirSync(ws);
  assert.notEqual(compatKey(args, [ws, home]), k);
  rmSync(dir, { recursive: true, force: true });
});
