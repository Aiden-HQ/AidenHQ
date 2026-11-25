// `aidenhq ship checkout` and `ship push` against a fake gateway: the PR's head commit comes from the code host by its sha (a
// fork's too), and a fix on top of it is filed as one codehost.push naming the adopted PR, the head it expects and the generation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../images/engineer/bin/aidenhq");
const run = promisify(execFile);

test("ship checkout fetches the PR's head by its sha; ship push files the fix onto the adopted PR", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ship-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "a\n");
  git(origin, "add", "-A"); git(origin, "commit", "-qm", "init");
  // The fork's commit: only reachable by its sha (refs/pull/7/head on GitHub), not a branch of the repo.
  git(origin, "checkout", "-qb", "tmp"); writeFileSync(join(origin, "b.txt"), "b\n"); git(origin, "add", "-A"); git(origin, "commit", "-qm", "fork");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main"); git(origin, "update-ref", `refs/pull/7/head`, head); git(origin, "branch", "-qD", "tmp");
  const bundle = (refs: string[]) => { const f = join(root, `b-${Math.random()}`); execFileSync("git", ["-C", origin, "bundle", "create", "-q", f, ...refs]); return readFileSync(f); };

  const writes: any[] = [];
  const kernel = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/v1/jobtools/clone") {
        const asked = JSON.parse(b);
        // The kernel's bundle of one commit names it as a branch of that sha (codehost bundle op).
        if (asked.head) { execFileSync("git", ["-C", origin, "update-ref", `refs/heads/${asked.head}`, asked.head]); const out = bundle([`refs/heads/${asked.head}`]); git(origin, "update-ref", "-d", `refs/heads/${asked.head}`); return res.writeHead(200).end(out); }
        return res.writeHead(200).end(bundle(["refs/heads/main"]));
      }
      if (req.url === "/v1/writes") { writes.push(JSON.parse(b)); return json({ id: "k-1", state: "claimed" }); }
      if (req.url?.startsWith("/v1/writes/")) return json({ id: "k-1", state: "done", outcome: { ok: true, text: "written" } });
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => kernel.listen(0, "127.0.0.1", r));
  t.after(() => kernel.close());
  const ws = join(root, "ws");
  mkdirSync(ws);
  const env = { PATH: process.env.PATH, AIDENHQ_GATEWAY_URL: `http://127.0.0.1:${(kernel.address() as { port: number }).port}`, AIDENHQ_RUN_TOKEN: "ahqj_job", AIDENHQ_TASK_WORKTREE: ws };
  const aidenhq = (...a: string[]) => run(process.execPath, [CLI, ...a], { env, cwd: ws });
  const link = "https://github.com/acme/app/pull/7";

  assert.match((await aidenhq("ship", "checkout", link, head)).stdout, /ship-pr-7 is checked out/);
  const app = join(ws, "app");
  assert.equal(git(app, "rev-parse", "HEAD"), head);
  writeFileSync(join(app, "b.txt"), "b fixed\n");
  git(app, "commit", "-qam", "fix: b");
  const fix = git(app, "rev-parse", "HEAD");
  assert.match((await aidenhq("ship", "push", link, head, "3")).stdout, /k-1: done/);
  assert.deepEqual(writes, [{ kind: "codehost.push", args: { only: [{ repo: "acme/app", branch: "ship-pr-7", sha: fix }], pr: { repo: "acme/app", number: 7 }, expected: head, generation: 3 } }]);
  // The pushed fix lands as the App's commit (another sha): the next checkout moves on from it, as it isn't unpublished work.
  const next = git(origin, "commit-tree", git(origin, "rev-parse", `${head}^{tree}`), "-p", head, "-m", "the App's commit");
  assert.match((await aidenhq("ship", "checkout", link, next)).stdout, /ship-pr-7 is checked out/);
  assert.equal(git(app, "rev-parse", "HEAD"), next);
  // A second fix round: fixed on the App's commit, pushed, and the next checkout moves on from that one too.
  writeFileSync(join(app, "b.txt"), "b fixed again\n");
  git(app, "commit", "-qam", "fix: b again");
  assert.match((await aidenhq("ship", "push", link, next, "3")).stdout, /k-1: done/);
  const next2 = git(origin, "commit-tree", git(origin, "rev-parse", `${next}^{tree}`), "-p", next, "-m", "the App's second commit");
  assert.match((await aidenhq("ship", "checkout", link, next2)).stdout, /ship-pr-7 is checked out/);
  assert.equal(git(app, "rev-parse", "HEAD"), next2);
  writes.pop();
  // Nothing on top of the head: nothing filed.
  git(app, "checkout", "-q", "-B", "ship-pr-7", head);
  await assert.rejects(aidenhq("ship", "push", link, head, "3"), (e: { code?: number }) => e.code === 2);
  assert.equal(writes.length, 1);

  // `ship title` files one codehost.retitle naming the PR, its head and the generation: no checkout, no clone, no commit.
  writes.length = 0;
  const title = "fix(widget): keep the drawer open";
  assert.match((await aidenhq("ship", "title", link, head, "3", title)).stdout, /k-1: done/);
  assert.deepEqual(writes, [{ kind: "codehost.retitle", args: { repo: "acme/app", number: 7, head, generation: 3, title } }]);
  // The arguments are required: a title with no words, or a missing generation, is a usage error and files nothing.
  assert.equal(writes.length, 1);
  await assert.rejects(aidenhq("ship", "title", link, head, "3"), (e: { code?: number }) => e.code === 2);
  await assert.rejects(aidenhq("ship", "title", link, head, "x", title), (e: { code?: number }) => e.code === 2);
  assert.equal(writes.length, 1);
});
