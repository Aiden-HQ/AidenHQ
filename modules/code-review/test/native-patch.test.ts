// codex-native sends the patch itself (patchGroups), one request for an ordinary change; the review is clean only when every group
// came back. Run against the pinned Codex (0.166.0, the engineer image's) and a recording model endpoint: the outbound request holds the
// exact patch, its last hunk included, and a failed group blocks clean. Codex is the PATH's when it is that version, else installed once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { patchGroups, runEngine, snapshot } from "../recipe/engines.ts";
import { place } from "../recipe/scope.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const PIN = "0.166.0";

/** The directory of the pinned codex to put on PATH ("" when PATH's is it); null when it is not there and can't be fetched (offline). */
function codexDir() {
  const ver = (bin: string) => { try { return execFileSync(bin, ["--version"], { encoding: "utf8" }).includes(PIN); } catch { return false; } };
  if (ver("codex")) return "";
  const prefix = join(tmpdir(), `codex-${PIN}`), bin = join(prefix, "node_modules", ".bin");
  if (!existsSync(join(bin, "codex"))) {
    mkdirSync(prefix, { recursive: true });
    try { execFileSync("npm", ["i", "--silent", "--prefer-offline", "--fetch-retries=0", "--fetch-timeout=30000", "--prefix", prefix, `@openai/codex@${PIN}`], { stdio: "inherit" }); } catch { return null; }
  }
  return bin;
}

/** A model endpoint that records each request and answers with a review (a verdict of "patch is correct"), or fails the ones in `fail`. */
async function endpoint(fail: number[] = [], found?: string, verdictOverride?: object, onRequest?: () => void) {
  const requests: any[] = [];
  const verdict = JSON.stringify(verdictOverride ?? { findings: found ? [{ title: "[P1] it breaks", body: "Failure scenario: a(1) returns 2", confidence_score: 0.9, priority: 1, code_location: { absolute_file_path: found, line_range: { start: 1, end: 1 } } }] : [], overall_correctness: found ? "patch is incorrect" : "patch is correct", overall_explanation: "ok", overall_confidence_score: 0.9 });
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      requests.push(JSON.parse(b || "{}"));
      onRequest?.();
      if (fail.includes(requests.length)) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "rejected" } })); }
      const sse = (type: string, d: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      const item = { type: "message", role: "assistant", id: `m${requests.length}`, content: [{ type: "output_text", text: verdict }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse("response.created", { response: { id: `r${requests.length}` } }); sse("response.output_item.added", { output_index: 0, item }); sse("response.output_item.done", { output_index: 0, item });
      sse("response.completed", { response: { id: `r${requests.length}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`, close: () => server.close() };
}

function repoWith(files: Record<string, (v: number) => string>) {
  const dir = mkdtempSync(join(tmpdir(), "native-patch-")), repo = join(dir, "repo");
  mkdirSync(repo);
  sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "commit.gpgsign", "false"); sh(repo, "config", "tag.gpgsign", "false");
  for (const v of [0, 1]) {
    for (const [p, make] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), make(v)); }
    sh(repo, "add", "."); sh(repo, "commit", "-q", "--allow-empty", "-m", `v${v}`);
    if (!v) sh(repo, "tag", "base");
  }
  return { dir, repo, base: sh(repo, "rev-parse", "base") };
}
const lines = (n: number, v: number, step: number, width = 60) => Array.from({ length: n }, (_, i) => (i % step === 0 && v ? `changed ${i} ${"x".repeat(width)}` : `line ${i}`)).join("\n") + "\n";
const patchOf = (repo: string, base: string, p: string) => execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", p], { cwd: repo, encoding: "utf8" });
const sent = (r: any) => JSON.stringify(r.input);

async function review(repo: string, base: string, files: string[], model: Awaited<ReturnType<typeof endpoint>>, left: string[] = []) {
  const dir = codexDir();
  if (dir === null) return null;
  if (dir) process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.OPENROUTER_BASE_URL = model.url;
  process.env.OPENROUTER_API_KEY = "test-token";
  return runEngine("codex-native", { prompt: "", instructions: "x", model: "m/m", effort: "low", root: repo, base, files, left, minutes: 3, scratch: mkdtempSync(join(tmpdir(), "native-scratch-")), own: true });
}

test("an ordinary change goes out in one request holding the exact patch, its last hunk included", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "big.txt": (v) => lines(300, v, 25), "s.txt": (v) => `s${v}\n`, "gone.txt": (v) => (v ? "" : "x\n") });
  const model = await endpoint();
  try {
    const r = await review(repo, base, ["big.txt", "s.txt", "gone.txt"], model);
    if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    assert.equal(model.requests.length, 1);
    assert.equal(r.incomplete, undefined);
    assert.equal(JSON.parse(r.message).findings.length, 0);
    const body = JSON.parse(sent(model.requests[0]!)) as unknown; // the request as JSON text, decoded once
    const text = JSON.stringify(body).replaceAll("\\n", "\n").replaceAll('\\"', '"');
    for (const p of ["big.txt", "s.txt"]) assert.ok(text.includes(patchOf(repo, base, p).trimEnd()), `${p}'s exact patch was sent`);
    assert.ok(text.includes("changed 275 "), "the last hunk of big.txt was sent");
  } finally { model.close(); }
});

test("a group that failed blocks clean and is named", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => lines(6000, v, 100, 1500), "b.txt": (v) => lines(6000, v, 100, 1500) });
  const model = await endpoint([2]);
  try {
    const r = await review(repo, base, ["a.txt", "b.txt"], model);
    if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    assert.ok(model.requests.length >= 2, "split into groups");
    assert.match(String(r.incomplete), /part 2 of \d+ \((a|b)\.txt/);
  } finally { model.close(); }
});

test("patchGroups packs whole files, splits a big file at hunks with its header repeated, and names a hunk that can't fit", () => {
  const { repo, base } = repoWith({ "a.txt": (v) => lines(200, v, 50), "b.txt": (v) => lines(200, v, 50), "c.txt": (v) => (v ? `${"y".repeat(5000)}\n` : "z\n") });
  const a = patchOf(repo, base, "a.txt").length;
  const together = patchGroups(repo, base, ["a.txt", "b.txt"], a * 3);
  assert.equal(together.groups.length, 1);
  const apart = patchGroups(repo, base, ["a.txt", "b.txt"], a + 10);
  assert.deepEqual(apart.groups.map((g) => g.files), [["a.txt"], ["b.txt"]]);
  const split = patchGroups(repo, base, ["a.txt"], Math.floor(a / 2));
  assert.ok(split.groups.length >= 2 && split.groups.every((g) => g.text.startsWith("diff --git a/a.txt b/a.txt")));
  assert.equal(split.groups.map((g) => g.text).join("").match(/^@@ /gm)?.length, patchOf(repo, base, "a.txt").match(/^@@ /gm)?.length, "every hunk is sent once");
  const big = patchGroups(repo, base, ["c.txt"], 1000);
  assert.deepEqual(big.groups, []);
  assert.match(big.oversize[0]!, /^c\.txt \(a hunk of \d+ characters\)$/);
});

test("a file that became a directory: the path's patch is its own, not what lies under it", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-dir-")), repo = join(dir, "r");
  mkdirSync(repo); sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "config"), "x\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "a"); const base = sh(repo, "rev-parse", "HEAD");
  sh(repo, "rm", "-q", "config"); mkdirSync(join(repo, "config")); writeFileSync(join(repo, "config", "settings.ts"), "y\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "b");
  const g = patchGroups(repo, base, ["config"]);
  assert.equal(g.groups.length, 1);
  assert.ok(g.groups[0]!.text.startsWith("diff --git a/config b/config\n") && !g.groups[0]!.text.includes("settings.ts"));
});

test("names git quotes (a space, a non-ASCII letter, a double quote) keep their patch", () => {
  const names = ['caf\u00e9 x.txt', 'we"ird \u00e9.txt'];
  const { repo, base } = repoWith(Object.fromEntries(names.map((n) => [n, (v: number) => `v${v}\n`])));
  const g = patchGroups(repo, base, names);
  assert.deepEqual(g.oversize, []);
  assert.equal(g.groups.length, 1);
  for (const n of names) assert.ok(g.groups[0]!.text.includes("+v1") && g.groups[0]!.files.includes(n), n);
  assert.equal((g.groups[0]!.text.match(/^diff --git /gm) ?? []).length, 2);
});

test("self-review exits 2 when some part of the patch could not be reviewed, whatever was found", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => lines(6000, v, 100, 1500), "b.txt": (v) => lines(6000, v, 100, 1500) });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint([2], join(realpathSync(repo), "a.txt")); // the first part finds an important bug, the second fails
  try {
    const dir = codexDir();
    if (dir === null) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const env = { ...process.env, PATH: dir ? `${dir}:${process.env.PATH}` : process.env.PATH, AIDENHQ_GATEWAY_URL: model.url.replace(/\/api\/v1$/, ""), AIDENHQ_RUN_TOKEN: "test-token" };
    // Asynchronous: the model endpoint is this process's.
    const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string }>((ok) => {
      const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stdout += d));
      c.on("close", (status) => ok({ status, stdout }));
    });
    const r = await run("main", branch);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /it breaks/, "the finding is still printed");
    assert.match(r.stdout, new RegExp(`^self-review: branch ${branch} base \\w+ \\(merge base\\) head \\w+: incomplete$`, "m"));
    assert.equal((await run("main", "some-other-branch")).status, 2, "a branch that isn't checked out is not reviewed");
  } finally { model.close(); }
});

test("a verdict of incorrect with no finding to show for it is incomplete, not clean", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "s.txt": (v) => `s${v}\n` });
  const model = await endpoint([], undefined, { findings: [], overall_correctness: "patch is incorrect", overall_explanation: "x", overall_confidence_score: 0.9 });
  try {
    const r = await review(repo, base, ["s.txt"], model);
    if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    assert.match(String(r.incomplete), /part 1 of 1: .*(incorrect|usable location)/);
  } finally { model.close(); }
});

test("a patch with no hunk to split at, over the budget, is named, not cut or dropped", () => {
  const { repo } = repoWith({ "x.sh": () => "echo\n" });
  const base = sh(repo, "rev-parse", "HEAD");
  sh(repo, "update-index", "--chmod=+x", "x.sh"); sh(repo, "commit", "-qm", "mode");
  const g = patchGroups(repo, base, ["x.sh"], 20);
  assert.deepEqual(g.groups, []);
  assert.match(g.oversize[0]!, /^x\.sh \(a patch of \d+ characters with no hunk to split at\)$/);
});

test("an important finding at a place the review would drop (a file that isn't there) is incomplete, not clean", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "s.txt": (v) => `s${v}\n` });
  const model = await endpoint([], join(realpathSync(repo), "nowhere.txt"));
  try {
    const r = await review(repo, base, ["s.txt"], model);
    if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    assert.match(String(r.incomplete), /part 1 of 1: 1 important finding at a place that is not in the change/);
  } finally { model.close(); }
});

test("self-review counts what the PR check would: an important finding in a file its scope leaves out is not one", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n`, "package-lock.json": (v) => `{"v":${v}}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint([], "package-lock.json"); // a path as the reviewer gives it, relative to the copy it works in
  try {
    const dir = codexDir();
    if (dir === null) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const env = { ...process.env, PATH: dir ? `${dir}:${process.env.PATH}` : process.env.PATH, AIDENHQ_GATEWAY_URL: model.url.replace(/\/api\/v1$/, ""), AIDENHQ_RUN_TOKEN: "test-token" };
    const out = await new Promise<{ status: number | null; stdout: string }>((ok) => {
      const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", branch], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stdout += d));
      c.on("close", (status) => ok({ status, stdout }));
    });
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /: clean \(/);
  } finally { model.close(); }
});

test("an important finding in a file the scope leaves out (here a deleted lockfile) is dropped by design, not lost", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "s.txt": (v) => `s${v}\n`, "package-lock.json": (v) => (v ? "" : "{}\n") });
  sh(repo, "rm", "-q", "--ignore-unmatch", "package-lock.json");
  const model = await endpoint([], join(realpathSync(repo), "package-lock.json"));
  try {
    const r = await review(repo, base, ["s.txt"], model, ["package-lock.json"]);
    if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    assert.equal(JSON.parse(r.message).findings[0].path, "package-lock.json", "the review came back with the finding");
    assert.equal(r.incomplete, undefined);
  } finally { model.close(); }
});

test("self-review records nothing for a commit that was not the one it reviewed: the checkout moved during the review", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  // While the model answers, the Engineer's checkout gains a commit.
  const model = await endpoint([], undefined, undefined, () => { writeFileSync(join(repo, "a.txt"), "moved\n"); sh(repo, "commit", "-qam", "moved"); });
  try {
    const dir = codexDir();
    if (dir === null) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const env = { ...process.env, PATH: dir ? `${dir}:${process.env.PATH}` : process.env.PATH, AIDENHQ_GATEWAY_URL: model.url.replace(/\/api\/v1$/, ""), AIDENHQ_RUN_TOKEN: "test-token" };
    const out = await new Promise<{ status: number | null; stdout: string }>((ok) => {
      const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", branch], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stdout += d));
      c.on("close", (status) => ok({ status, stdout }));
    });
    assert.equal(out.status, 2, out.stdout);
    assert.match(out.stdout, /^self-review: .*: incomplete$/m);
    assert.match(out.stdout, /the checkout changed during the review/);
    assert.equal(existsSync(join(repo, ".git", "self-review.json")), false, "no record for the commit that wasn't reviewed");
  } finally { model.close(); }
});

test("findings are validated against the reviewed commit's tree, not the work tree", () => {
  const { repo, base } = repoWith({ "a.txt": (v) => (v ? "1\n2\n3\n" : "x\n") });
  const head = sh(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "1\n"); // the work tree moved on: one line
  const f = { severity: "nit" as const, path: "a.txt", line: 3, title: "t", why: "w", evidence: "", fix_brief: "" };
  assert.equal(place([f], repo, new Set(["a.txt"])).length, 0, "against the work tree line 3 is gone");
  assert.equal(place([f], repo, new Set(["a.txt"]), undefined, undefined, head).length, 1, "against the commit it is there");
});

test("with a commit to review at, codex works in a copy of its files, not the live checkout", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  const head = sh(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "edited later\n"); // the Engineer keeps editing
  // A smudge filter the clone selects locally must not run when the copy is made.
  const marker = join(repo, "..", "filter-ran");
  sh(repo, "config", "filter.evil.smudge", `touch ${marker}`); sh(repo, "config", "filter.evil.required", "false");
  writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
  const model = await endpoint();
  try {
    const dir = codexDir();
    if (dir === null) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
    if (dir) process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.OPENROUTER_BASE_URL = model.url; process.env.OPENROUTER_API_KEY = "test-token";
    const scratch = mkdtempSync(join(tmpdir(), "native-scratch-"));
    const r = await runEngine("codex-native", { prompt: "", instructions: "x", model: "m/m", effort: "low", root: repo, base, files: ["a.txt"], head, minutes: 3, scratch, own: true });
    assert.equal(r.incomplete, undefined);
    const text = JSON.stringify(model.requests[0]);
    assert.ok(text.includes(join(realpathSync(scratch), "tree")) || text.includes(join(scratch, "tree")), "codex's cwd is the copy");
    assert.ok(!text.includes(`<cwd>${repo}`), "not the live checkout");
    assert.equal(execFileSync("cat", [join(scratch, "tree", "a.txt")], { encoding: "utf8" }), "a1\n", "the copy holds the reviewed commit's file");
    assert.equal(existsSync(marker), false, "no filter of the clone ran");
  } finally { model.close(); }
});

test("snapshot writes a commit's regular files exactly (binary, executable, nested), and makes the directory even for a commit with none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snap-")), repo = join(dir, "r");
  mkdirSync(join(repo, "d"), { recursive: true }); sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "commit.gpgsign", "false");
  const bin = Buffer.from([0, 1, 2, 255, 10, 13, 0]);
  writeFileSync(join(repo, "d", "b.bin"), bin); writeFileSync(join(repo, "x.sh"), "echo\n"); writeFileSync(join(repo, "empty"), "");
  sh(repo, "add", "."); sh(repo, "update-index", "--chmod=+x", "x.sh"); sh(repo, "commit", "-qm", "files");
  const full = sh(repo, "rev-parse", "HEAD");
  sh(repo, "rm", "-rqf", "."); sh(repo, "commit", "-qm", "none");
  const out = join(dir, "out");
  await snapshot(repo, full, out);
  assert.deepEqual(readFileSync(join(out, "d", "b.bin")), bin);
  assert.equal(readFileSync(join(out, "x.sh"), "utf8"), "echo\n");
  assert.ok((statSync(join(out, "x.sh")).mode & 0o111) !== 0, "the executable bit");
  assert.equal(readFileSync(join(out, "empty"), "utf8"), "");
  const none = join(dir, "none");
  await snapshot(repo, sh(repo, "rev-parse", "HEAD"), none);
  assert.ok(existsSync(none));
});
