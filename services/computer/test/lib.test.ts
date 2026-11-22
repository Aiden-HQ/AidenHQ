// The launcher's logic: the box's Codex config, admission, repo-checkout. Docker itself is proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, mcpBlock, stale } from "../lib.ts";

test("the box's Codex config lists only granted connections, through the gateway, keyed by the job token", () => {
  const conns = { apps: { tool_timeout_sec: 600 }, slack: { tool_timeout_sec: 300 }, paperclip_tasks: { tool_timeout_sec: 300 } };
  const b = mcpBlock({ apps: ["app_list"], paperclip_tasks: ["task_finish"] }, conns, "http://10.231.2.1:8200");
  assert.match(b, /\[mcp_servers\.apps\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/apps\/mcp"\nenv_http_headers = \{ "X-Agent-Key" = "AIDENHQ_RUN_TOKEN" \}\nenabled_tools = \["app_list"\]/);
  // The tasks tools too: no stdio bridge in the box any more.
  assert.match(b, /\[mcp_servers\.paperclip_tasks\]\nurl = "http:\/\/10\.231\.2\.1:8200\/c\/paperclip_tasks\/mcp"/);
  assert.doesNotMatch(b, /slack|command/);
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
