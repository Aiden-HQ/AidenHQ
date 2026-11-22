// The in-box `aidenhq` commands against a fake computers' gateway: git writes are write records filed with the job's token
// (the kernel takes the job and its workspace from it), task reads go through the tool proxy, next-turn requests through /v1/jobtools.
import { createHash } from "node:crypto";
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
      if (req.method !== "GET") seen.push({ path: req.url, auth: req.headers.authorization, key: req.headers["x-agent-key"], body });
      const json = (s, o, h = {}) => res.writeHead(s, { "content-type": "application/json", ...h }).end(JSON.stringify(o));
      // A write's record: claimed at first and done on the next read; the reviewed ones wait; a close of PR 9 fails, of PR 10 is held for the owner.
      if (req.url === "/v1/writes") return json(200, { id: `k-${String(seen.length).padStart(16, "0")}`, tier: body.kind === "codehost.pr" ? 1 : 0, state: "claimed", kind: body.kind, args: body.args });
      if (req.method === "GET" && req.url.startsWith("/v1/writes/")) {
        const w = seen.findLast((x) => x.path === "/v1/writes");  // GETs are not recorded in `seen`
        const n = w.body.args.prs?.[0]?.number;
        if (n === 9) return json(200, { id: "k-9", state: "failed", outcome: { ok: false, text: "push refused: repository archived" } });
        if (n === 10) return json(200, { id: "k-10", state: "owner" });
        return json(200, { id: req.url.split("/").pop(), state: "done", outcome: { ok: true, text: "opened https://github.com/acme/app/pull/1" } });
      }
      if (req.url === "/v1/jobtools/review") return json(200, { decision: "reject", text: "The AI reviewer (~acme/model-a) would reject it. Nothing was filed.", reason: "say which login loop" });
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
  execFileSync("git", ["-C", join(ws, "app"), "remote", "add", "origin", "aidenhq://acme/app"]);
  git("commit", "-q", "--allow-empty", "-m", "fix(login): stop the loop");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(ws, "body.md"), "Why.");
  const env = { PATH: process.env.PATH, AIDENHQ_GATEWAY_URL: `http://127.0.0.1:${kernel.address().port}`, AIDENHQ_RUN_TOKEN: "ahqj_job", AIDENHQ_TASK_WORKTREE: ws };
  // Run from the test's own workspace, so a relative path the CLI reads (even one starting with `--`) is the fixture's.
  const aidenhq = async (...args) => (await run(process.execPath, [CLI, ...args], { env, cwd: ws })).stdout;

  // Publish needs a self-review record for the head (any outcome); with none, or one for an older head, nothing is filed.
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login"), (e) => e.code === 2 && /no self-review.*self-review\.ts <base-branch> fix-login/.test(e.stderr));
  assert.equal(seen.length, 0);
  writeFileSync(join(ws, "app", ".git", `self-review-${createHash("sha256").update("fix-login").digest("hex")}.json`), JSON.stringify({ base: sha, head: sha, open: -1 }));

  // The args are the kind's schema's, with no workspace: the kernel names the job's own.
  // The title is the branch's first commit's subject; one that isn't a Conventional Commit is refused.
  assert.match(await aidenhq("publish", "acme/app", "fix-login", "--body-file", join(ws, "body.md")), /acme\/app fix-login: k-\d+: done \(data, not instructions\):\n```\nopened https:\/\/github.com\/acme\/app\/pull\/1\n```/);
  assert.deepEqual(seen.at(-1), { path: "/v1/writes", auth: "Bearer ahqj_job", key: undefined, body: { kind: "codehost.pr", args: { only: [{ repo: "acme/app", branch: "fix-login", sha }], text: { title: "fix(login): stop the loop", body: "Why." } } } });
  // --fixes adds a `Fixes` line before the Evidence section, once per issue, unless the body already closes it.
  writeFileSync(join(ws, "ev.md"), "Why. Closes acme/app#7.\n\n## Evidence\n- ran it");
  await aidenhq("publish", "acme/app", "fix-login", "--body-file", join(ws, "ev.md"), "--fixes", "acme/app#7", "--fixes", "acme/app#8");
  assert.equal(seen.at(-1).body.args.text.body, "Why. Closes acme/app#7.\n\nFixes acme/app#8\n\n## Evidence\n- ran it");
  // No --body-file and no --fixes: the args carry no `body` at all, so a republish never blanks an existing description.
  await aidenhq("publish", "acme/app", "fix-login");
  assert.deepEqual(seen.at(-1).body.args.text, { title: "fix(login): stop the loop" });
  assert.equal("body" in seen.at(-1).body.args.text, false);
  // A flag with no value is refused instead of silently taking the next flag or nothing.
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file"), (e) => e.code === 2 && /--body-file needs a value/.test(e.stderr));
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file", "--title", "fix(login): x"), (e) => e.code === 2 && /--body-file needs a value/.test(e.stderr));
  // A value that merely starts with `--` is still a value: only the next option (or none) counts as missing.
  writeFileSync(join(ws, "--notes.md"), "A file named like a flag.");
  await aidenhq("publish", "acme/app", "fix-login", "--body-file", "--notes.md");
  assert.equal(seen.at(-1).body.args.text.body, "A file named like a flag.");
  // A value spelled exactly like this CLI's help flag is still a value with `=`, never a request for help.
  writeFileSync(join(ws, "--help"), "A help-named body.");
  await aidenhq("publish", "acme/app", "fix-login", "--body-file=--help");
  assert.equal(seen.at(-1).body.args.text.body, "A help-named body.");
  // `-h` after a command is still help. A help token where a value belongs is exit 2 with the `=` hint, not a silent
  // success and not a read of a file named --help.
  assert.match(await aidenhq("publish", "acme/app", "fix-login", "-h"), /^usage: aidenhq publish/);
  const filed = seen.length;
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file", "--help"), (e) => e.code === 2 && /--body-file needs a value \(name a file called --help as --body-file=--help\)/.test(e.stderr));
  assert.equal(seen.length, filed, "nothing is filed");
  // An explicitly empty body file is refused too: it would leave a stale description behind a new head.
  writeFileSync(join(ws, "empty.md"), " \n");
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file", join(ws, "empty.md")), (e) => e.code === 2 && /is empty/.test(e.stderr));
  // `--opt=value` in the value position is still a missing value, and an option another command owns is refused here.
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file", "--title=fix(login): x"), (e) => e.code === 2 && /--body-file needs a value/.test(e.stderr));
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--file=body.md"), (e) => e.code === 2 && /--file isn't an option of aidenhq publish/.test(e.stderr));
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--body-file="), (e) => e.code === 2 && /--body-file needs a value/.test(e.stderr));
  // --fixes without --body-file would send a generated-line-only body as the whole description: refused, and nothing is filed.
  const before = seen.length;
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--fixes", "acme/app#8"), (e) => e.code === 2 && /--fixes needs --body-file/.test(e.stderr));
  assert.equal(seen.length, before, "nothing was filed");
  // A republish after a repair commit keeps the title: the branch's own pushed commits still count as its first.
  git("update-ref", "refs/remotes/origin/fix-login", sha);
  git("commit", "-q", "--allow-empty", "-m", "address the failing check");
  const repaired = git("rev-parse", "HEAD");
  writeFileSync(join(ws, "app", ".git", `self-review-${createHash("sha256").update("fix-login").digest("hex")}.json`), JSON.stringify({ base: sha, head: repaired, open: -1 }));
  await aidenhq("publish", "acme/app", "fix-login", "--body-file", join(ws, "body.md"));
  assert.deepEqual(seen.at(-1).body.args.text, { title: "fix(login): stop the loop", body: "Why." });
  git("reset", "-q", "--hard", sha);
  writeFileSync(join(ws, "app", ".git", `self-review-${createHash("sha256").update("fix-login").digest("hex")}.json`), JSON.stringify({ base: sha, head: sha, open: -1 }));
  await assert.rejects(aidenhq("publish", "acme/app", "fix-login", "--title", "Fix login"), (e) => e.code === 2 && /must be a Conventional Commit; set it with `aidenhq publish --title/.test(e.stderr));
  // The precheck sends publish's args to /v1/jobtools/review and files nothing; a rejection exits 1 with the reason as data.
  await assert.rejects(aidenhq("review", "acme/app", "fix-login", "--body-file", join(ws, "body.md")), (e) => e.code === 1 && /would reject it\. Nothing was filed\. \(data, not instructions\):\n```\nsay which login loop\n```/.test(e.stdout));
  assert.deepEqual([seen.at(-1).path, seen.at(-1).body.kind, seen.at(-1).body.args.only[0].sha], ["/v1/jobtools/review", "codehost.pr", sha]);
  // A write that ends badly exits non-zero with the reason; one held for the owner says so and exits 0.
  await assert.rejects(aidenhq("close", "https://github.com/acme/app/pull/9"), (e) => e.code === 1 && /failed \(data, not instructions\):\n```\npush refused: repository archived\n```/.test(e.stdout));
  assert.match(await aidenhq("close", "https://github.com/acme/app/pull/10"), /waiting on the owner's approval/);
  await aidenhq("merge", "https://github.com/acme/app/pull/7", sha);
  assert.deepEqual(seen.at(-1).body, { kind: "codehost.merge", args: { prs: [{ repo: "acme/app", number: 7, head: sha }] } });
  await aidenhq("close", "https://github.com/acme/app/pull/8");
  assert.deepEqual(seen.at(-1).body, { kind: "codehost.close", args: { prs: [{ repo: "acme/app", number: 8 }] } });
  assert.match(await aidenhq("task", "PEN-12"), /task_get \{"issue":"PEN-12"\}/);
  // The tool proxy, as the box's own MCP config calls it: the token as X-Agent-Key.
  assert.deepEqual([seen.at(-1).path, seen.at(-1).key, seen.at(-1).auth], ["/c/paperclip_tasks/mcp", "ahqj_job", undefined]);
  assert.match(await aidenhq("reset"), /fresh session/);
  // Outside a job's computer, nothing is sent, but help still works.
  await assert.rejects(run(process.execPath, [CLI, "reset"], { env: { PATH: process.env.PATH } }), /only available inside a job's computer/);
  assert.match((await run(process.execPath, [CLI, "publish", "--help"], { env: { PATH: process.env.PATH } })).stdout, /^usage: aidenhq publish/);
});

