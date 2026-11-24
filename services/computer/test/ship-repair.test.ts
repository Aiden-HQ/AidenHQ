// `aidenhq ship repair`: ship's deterministic repair in the task's computer, against a fake gateway whose clone serves an "origin"
// repo. A conflict only in generated paths is merged, regenerated and pushed as one commit from the PR's head; a whitespace-only
// lockfile change is put back; a conflict in source is left for the Engineer (exit 3, `leftover: <path>`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../images/engineer/bin/aidenhq");
const run = promisify(execFile);

test("ship repair: generated conflicts are regenerated into one pushed commit; a source conflict is left over", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ship-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  const git = (...a) => execFileSync("git", ["-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { encoding: "utf8" }).trim();
  const put = (p, text) => { mkdirSync(dirname(join(origin, p)), { recursive: true }); writeFileSync(join(origin, p), text); };
  // gen/out.txt is generated from src/*.txt; package-lock.json is re-indented by the generator.
  const GEN = "cat src/*.txt > gen/out.txt && node -e \"const f='package-lock.json';require('fs').writeFileSync(f, JSON.stringify(JSON.parse(require('fs').readFileSync(f,'utf8')), null, 4))\"";
  const regen = () => execFileSync("sh", ["-c", "cat src/*.txt > gen/out.txt"], { cwd: origin });
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  put(".gitattributes", "gen/** linguist-generated\n");
  put("src/a.txt", "a\n");
  put("package-lock.json", '{\n  "lockfileVersion": 3\n}\n');
  mkdirSync(join(origin, "gen"));
  regen();
  git("add", "-A"); git("commit", "-qm", "init");
  // The PR: adds b, regenerated. Main meanwhile changes a, regenerated: gen/out.txt conflicts.
  git("checkout", "-qb", "feature"); put("src/b.txt", "b\n"); regen(); git("add", "-A"); git("commit", "-qm", "feat: b");
  const head = git("rev-parse", "HEAD");
  // A second PR that also changes a: a source conflict.
  git("checkout", "-qb", "clash", "main"); put("src/a.txt", "a from the PR\n"); regen(); git("add", "-A"); git("commit", "-qm", "feat: a");
  const clash = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); put("src/a.txt", "a2\n"); regen(); git("add", "-A"); git("commit", "-qm", "main: a2");
  const bundle = join(root, "origin.bundle");
  git("bundle", "create", "-q", bundle, "--branches");

  const writes = [];
  const kernel = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const json = (o) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/v1/jobtools/clone") return res.writeHead(200).end(readFileSync(bundle));
      if (req.url === "/v1/writes") { writes.push(JSON.parse(b)); return json({ id: "k-1", state: "claimed" }); }
      if (req.url.startsWith("/v1/writes/")) return json({ id: "k-1", state: "done", outcome: { ok: true, text: "written" } });
      res.writeHead(404).end("{}");
    });
  });
  await new Promise((r) => kernel.listen(0, "127.0.0.1", r));
  t.after(() => kernel.close());
  const ws = join(root, "ws");
  mkdirSync(ws);
  const env = { PATH: process.env.PATH, AIDENHQ_GATEWAY_URL: `http://127.0.0.1:${kernel.address().port}`, AIDENHQ_RUN_TOKEN: "ahqj_job", AIDENHQ_TASK_WORKTREE: ws };
  const plan = Buffer.from(JSON.stringify({ globs: ["gen/**", "**/package-lock.json"], commands: [{ dir: ".", cmd: GEN }] })).toString("base64url");
  const repair = (sha) => run(process.execPath, [CLI, "ship", "repair", "https://github.com/acme/app/pull/7", sha, "2", "main", plan], { env, cwd: ws });

  const out = (await repair(head)).stdout;
  assert.match(out, /pull\/7: k-1: done/);
  assert.equal(writes.length, 1);
  const w = writes[0];
  assert.equal(w.kind, "codehost.push");
  assert.deepEqual({ ...w.args, only: undefined }, { only: undefined, pr: { repo: "acme/app", number: 7 }, expected: head, generation: 2 });
  assert.equal(w.args.only[0].branch, "feature");
  const app = join(ws, "app");
  const at = (...a) => execFileSync("git", ["-C", app, ...a], { encoding: "utf8" }).trim();
  const sha = w.args.only[0].sha;
  // One commit on top of the head: the base merged in, generated output regenerated, the re-spaced lockfile put back.
  assert.equal(at("rev-list", "--count", `${head}..${sha}`, "--first-parent"), "1");
  assert.equal(at("show", `${sha}:gen/out.txt`), "a2\nb");
  assert.equal(at("show", `${sha}:package-lock.json`), '{\n  "lockfileVersion": 3\n}');

  // A conflict outside the generated paths is the Engineer's: listed, nothing pushed.
  await assert.rejects(repair(clash), (e) => e.code === 3 && /^leftover: src\/a\.txt$/m.test(e.stdout) && !/gen\/out\.txt/.test(e.stdout));
  assert.equal(writes.length, 1);
});
