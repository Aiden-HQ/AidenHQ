// The in-box `aidenhq` commands against a fake computers' gateway: git writes are write records filed with the job's token
// (the kernel takes the job and its workspace from it), task reads go through the tool proxy, next-turn requests through /v1/jobtools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../images/engineer/bin/aidenhq");
const run = promisify(execFile);

test("aidenhq: writes, task reads and next-turn requests go to the kernel with the job token", async (t) => {
  const seen = [];
  const kernel = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = JSON.parse(b || "{}");
      seen.push({ path: req.url, auth: req.headers.authorization, key: req.headers["x-agent-key"], body });
      const json = (s, o, h = {}) => res.writeHead(s, { "content-type": "application/json", ...h }).end(JSON.stringify(o));
      if (req.url === "/v1/writes") return json(200, { id: `k-${String(seen.length).padStart(16, "0")}`, tier: 1, state: "review" });
      if (req.url === "/v1/jobtools/reset") return json(200, { text: "The next turn starts with a fresh session." });
      if (req.url === "/c/paperclip_tasks/mcp" && body.method === "initialize") return json(200, { jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" });
      if (req.url === "/c/paperclip_tasks/mcp") return res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: `${body.params.name} ${JSON.stringify(body.params.arguments)}` }] } })}\n\n`);
      json(404, { error: { message: "no such route" } });
    });
  });
  await new Promise((r) => kernel.listen(0, "127.0.0.1", r));
  t.after(() => kernel.close());
  // The task's workspace with a clone of acme/app (as the code host finds it: <name> or <org>--<name>), fix-login committed.
  const ws = mkdtempSync(join(tmpdir(), "aidenhq-cli-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", join(ws, "app"), "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "fix-login", join(ws, "app")]);
  git("commit", "-q", "--allow-empty", "-m", "fix");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(ws, "body.md"), "Why.");
  const env = { PATH: process.env.PATH, AIDENHQ_GATEWAY_URL: `http://127.0.0.1:${kernel.address().port}`, AIDENHQ_RUN_TOKEN: "ahqj_job", AIDENHQ_TASK_WORKTREE: ws };
  const aidenhq = async (...args) => (await run(process.execPath, [CLI, ...args], { env })).stdout;

  // The args are the kind's schema's, with no workspace: the kernel names the job's own.
  assert.match(await aidenhq("publish", "acme/app", "fix-login", "--title", "Fix login", "--body-file", join(ws, "body.md")), /acme\/app fix-login: k-\d+: tier 1, review/);
  assert.deepEqual(seen.at(-1), { path: "/v1/writes", auth: "Bearer ahqj_job", key: undefined, body: { kind: "codehost-github.pr", args: { only: [{ repo: "acme/app", branch: "fix-login", sha }], text: { title: "Fix login", body: "Why." } } } });
  await aidenhq("merge", "https://github.com/acme/app/pull/7", sha);
  assert.deepEqual(seen.at(-1).body, { kind: "codehost-github.merge", args: { prs: [{ repo: "acme/app", number: 7, head: sha }] } });
  await aidenhq("close", "https://github.com/acme/app/pull/8");
  assert.deepEqual(seen.at(-1).body, { kind: "codehost-github.close", args: { prs: [{ repo: "acme/app", number: 8 }] } });
  assert.match(await aidenhq("task", "PEN-12"), /task_get \{"issue":"PEN-12"\}/);
  // The tool proxy, as the box's own MCP config calls it: the token as X-Agent-Key.
  assert.deepEqual([seen.at(-1).path, seen.at(-1).key, seen.at(-1).auth], ["/c/paperclip_tasks/mcp", "ahqj_job", undefined]);
  assert.match(await aidenhq("reset"), /fresh session/);
  // Outside a job's computer, nothing is sent.
  await assert.rejects(run(process.execPath, [CLI, "reset"], { env: { PATH: process.env.PATH } }), /only available inside a job's computer/);
});
