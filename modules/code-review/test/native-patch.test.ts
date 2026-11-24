// codex-native sends the patch itself (patchGroups), one request for an ordinary change; the review is clean only when every group
// came back. Run against the pinned Codex (0.166.0, the engineer image's) and a recording model endpoint: the outbound request holds the
// exact patch, its last hunk included, and a failed group blocks clean. Codex is the PATH's when it is that version, else installed once.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PREP_TIMEOUT, gitListed, patchGroups, runEngine, snapshot } from "../recipe/engines.ts";
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
    assert.ok(Array.isArray(r.covered) && r.covered.length < 2, "the file of the part that failed is not reported covered");
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
    const rec = JSON.parse(readFileSync(join(repo, ".git", `self-review-${createHash("sha256").update(branch).digest("hex")}.json`), "utf8"));
    assert.equal(rec.head, sh(repo, "rev-parse", "HEAD"), "an incomplete run records the head (what publish asks for)");
    assert.equal(rec.open, -1, "and the next run isn't incremental");
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
    assert.deepEqual(readdirSync(join(repo, ".git")).filter((f) => f.startsWith("self-review")), [], "no record for the commit that wasn't reviewed");
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
  snapshot(repo, full, out);
  assert.deepEqual(readFileSync(join(out, "d", "b.bin")), bin);
  assert.equal(readFileSync(join(out, "x.sh"), "utf8"), "echo\n");
  assert.ok((statSync(join(out, "x.sh")).mode & 0o111) !== 0, "the executable bit");
  assert.equal(readFileSync(join(out, "empty"), "utf8"), "");
  const none = join(dir, "none");
  snapshot(repo, sh(repo, "rev-parse", "HEAD"), none);
  assert.ok(existsSync(none));
});

test("preparing the patch and the copy is within the review's time: a deadline already gone is incomplete, and nothing is asked", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  const head = sh(repo, "rev-parse", "HEAD");
  const r = await runEngine("codex-native", { prompt: "", instructions: "x", model: "m/m", effort: "low", root: repo, base, files: ["a.txt"], head, minutes: 1e-9, scratch: mkdtempSync(join(tmpdir(), "native-scratch-")), own: true });
  assert.equal(r.cause, PREP_TIMEOUT);
  assert.equal(r.message, "");
  assert.throws(() => patchGroups(repo, base, ["a.txt"], undefined, "HEAD", Date.now() - 1), new RegExp(PREP_TIMEOUT));
  assert.throws(() => snapshot(repo, head, join(mkdtempSync(join(tmpdir(), "snap-")), "o"), Date.now() - 1), new RegExp(PREP_TIMEOUT));
});

const lineZero = (path: string, body: string) => ({ findings: [{ title: "[P1] at line zero", body, confidence_score: 0.9, priority: 1, code_location: { absolute_file_path: path, line_range: { start: 0, end: 0 } } }], overall_correctness: "patch is incorrect", overall_explanation: "x", overall_confidence_score: 0.9 });

test("line 0: an incorrect verdict whose only finding clean() drops is incomplete through codexNative, with or without a failure scenario", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "s.txt": (v) => `s${v}\n` });
  for (const body of ["no scenario given", "Failure scenario: s(1) returns 2"]) {
    const model = await endpoint([], undefined, lineZero(join(realpathSync(repo), "s.txt"), body));
    try {
      const r = await review(repo, base, ["s.txt"], model);
      if (!r) return t.skip(`codex ${PIN} is not installed and could not be fetched`);
      assert.match(String(r.incomplete), /part 1 of 1: .*(incorrect|important finding)/, body);
    } finally { model.close(); }
  }
});

test("line 0: self-review does not print clean for an incorrect verdict whose only finding is dropped", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "s.txt": (v) => `s${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint([], undefined, lineZero("s.txt", "no scenario given"));
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
    assert.match(out.stdout, /: incomplete$/m);
    assert.doesNotMatch(out.stdout, /: clean/);
  } finally { model.close(); }
});

test("a file that became a link is two records of one path: each is packed on its own, with its own header", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-type-")), repo = join(dir, "r");
  mkdirSync(repo); sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "l"), Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "a");
  const base = sh(repo, "rev-parse", "HEAD");
  rmSync(join(repo, "l")); symlinkSync("elsewhere", join(repo, "l")); sh(repo, "add", "."); sh(repo, "commit", "-qm", "b");
  const records = patchOf(repo, base, "l").split(/^(?=diff --git )/m).filter(Boolean);
  assert.equal(records.length, 2, "git gives a type change two records");
  const together = patchGroups(repo, base, ["l"]);
  assert.equal(together.groups.length, 1);
  const apart = patchGroups(repo, base, ["l"], Math.max(...records.map((r) => r.length)));
  assert.equal(apart.groups.length, 2);
  for (const g of apart.groups) assert.equal((g.text.match(/^diff --git /gm) ?? []).length, 1, "one record, one header");
  assert.ok(apart.groups.some((g) => g.text.includes("deleted file mode 100644")) && apart.groups.some((g) => g.text.includes("new file mode 120000")));
});

test("a patch that isn't valid UTF-8 is named, not sent in a lossy form", () => {
  const { repo, base } = repoWith({ "x.txt": (v) => (v ? "a\n" : "b\n") });
  writeFileSync(join(repo, "x.txt"), Buffer.from([0x61, 0xff, 0x0a])); sh(repo, "commit", "-qam", "bytes");
  const g = patchGroups(repo, base, ["x.txt"]);
  assert.deepEqual(g.groups, []);
  assert.deepEqual(g.oversize, ["x.txt (not valid UTF-8)"]);
});

test("a bare carriage return or a line separator in a changed line is not a record or hunk boundary", () => {
  const { repo, base } = repoWith({ "c.txt": (v) => (v ? `x\r@@ -1 +1 @@ fake\u2028diff --git a/z b/z\ny\n` : "a\n") });
  const g = patchGroups(repo, base, ["c.txt"], 100_000);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0]!.text.trimEnd(), patchOf(repo, base, "c.txt").trimEnd());
  // Over a budget, the one hunk is not read as several: it is named, not cut at the fake headers.
  const tight = patchGroups(repo, base, ["c.txt"], 100);
  assert.deepEqual(tight.groups, []);
  assert.match(tight.oversize[0]!, /^c\.txt \(a hunk of \d+ characters\)$/);
});

test("self-review reviews the eligible files even when a generated file leaves a gap, then exits 2 with the gap named", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n`, "dist/out.js": (v) => `x${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint();
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
    assert.equal(model.requests.length, 1, "the eligible file was sent");
    assert.match(JSON.stringify(model.requests[0]), /a\.txt/);
    assert.match(out.stdout, /generated files this change adds are not reviewed: dist\/out\.js/);
  } finally { model.close(); }
});

test("a file name that isn't valid UTF-8 in a change list is an error, named, never a lossy path", () => {
  const dir = mkdtempSync(join(tmpdir(), "list-utf-")), repo = join(dir, "r");
  mkdirSync(repo); sh(repo, "init", "-q");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "x\n", encoding: "utf8" }).trim();
  const tree = (name: Buffer) => execFileSync("git", ["mktree", "-z"], { cwd: repo, input: Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from("\0")]), encoding: "utf8" }).trim();
  const commit = (t: string) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", t, "-m", "x"], { cwd: repo, encoding: "utf8" }).trim();
  const ok = commit(tree(Buffer.from("fine.txt"))), bad = commit(tree(Buffer.from([0x62, 0xff, 0x61])));
  assert.equal(gitListed(repo, ["diff", "--no-renames", "--name-only", "-z", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", ok]), "fine.txt\0");
  assert.throws(() => gitListed(repo, ["diff", "--no-renames", "--name-only", "-z", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", bad]), /not valid UTF-8/);
});

test("self-review takes the exact remote-tracking ref as the base, whatever a tag of the same name points at", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  sh(repo, "tag", "origin/main", "HEAD"); // a tag named like the remote-tracking branch, at the head
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // stops the run at the evidence line, before any model
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const out = await new Promise<string>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", branch], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; c.stdout.on("data", (d) => (s += d)); c.stderr.on("data", (d) => (s += d)); c.on("close", () => ok(s));
  });
  assert.ok(out.includes(`base ${base.slice(0, 12)} (merge base)`), out);
});

test("a branch gets two self-reviews: after them a run records the head without a model, as not reviewed", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD"), head = sh(repo, "rev-parse", "HEAD");
  const memo = join(repo, ".git", `self-review-${createHash("sha256").update(branch).digest("hex")}.json`);
  const run = () => new Promise<{ status: number | null; out: string }>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", branch], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("close", (status) => ok({ status, out }));
  });
  writeFileSync(memo, JSON.stringify({ base, head: base, open: 3, runs: 2 })); // two reviews done, then a fix commit (this head)
  for (let i = 0; i < 2; i++) { // the same answer on a repeat at this head
    const r = await run();
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /not reviewed: this branch had its 2 reviews/);
    assert.deepEqual(JSON.parse(readFileSync(memo, "utf8")), { base, head, open: -1, runs: 2 }, "the head is recorded for aidenhq publish, as not reviewed");
  }
});

test("a file name that starts with a byte order mark keeps it in the change list", () => {
  const { repo, base } = repoWith({ "\ufeffbom.txt": (v) => `v${v}\n` });
  assert.equal(gitListed(repo, ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"]), "\ufeffbom.txt\0");
  const g = patchGroups(repo, base, ["\ufeffbom.txt"]);
  assert.deepEqual(g.oversize, []);
  assert.ok(g.groups[0]!.text.includes("a/\ufeffbom.txt"), "the patch names the file with its mark");
});

test("a base given as revision syntax (main~1) is not a branch name: incomplete, nothing is resolved from it", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const run = (name: string) => new Promise<{ status: number | null; out: string }>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), name, branch], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("close", (status) => ok({ status, out }));
  });
  for (const bad of ["main~1", "main^", "main..main", "@{-1}", "ma:in"]) {
    const r = await run(bad);
    assert.equal(r.status, 2, bad);
    assert.match(r.out, /is not a branch name with a remote-tracking ref/, bad);
  }
});

test("the snapshot is a real isolated repository: detached at the head, clean, and the base is readable with git show", () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  const head = sh(repo, "rev-parse", "HEAD"), out = join(mkdtempSync(join(tmpdir(), "snap-repo-")), "r");
  snapshot(repo, head, out);
  assert.equal(sh(out, "rev-parse", "HEAD"), head);
  assert.equal(sh(out, "status", "--porcelain"), "");
  assert.equal(sh(out, "show", `${base}:a.txt`), "a0");
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "a1\n");
});

test("self-review is incomplete, not clean, when redaction changes an important finding's path", { timeout: 240_000 }, async (t) => {
  const name = `${"sk"}-${"abcdefghijklmnopqrstuv"}.json`; // credential-shaped, built so the file holds no such literal
  const { repo, base } = repoWith({ [name]: (v) => `v${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint([], name);
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
    assert.match(out.stdout, /looks like a credential and was redacted/);
    assert.doesNotMatch(out.stdout, /: clean/);
  } finally { model.close(); }
});

test("an untracked file is an uncommitted change even when the clone's config hides untracked files", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  sh(repo, "config", "status.showUntrackedFiles", "no");
  writeFileSync(join(repo, "untracked.txt"), "x\n");
  assert.equal(sh(repo, "status", "--porcelain"), "", "git's own default would say nothing here");
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const out = await new Promise<{ status: number | null; stdout: string }>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", branch], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stdout += d)); c.on("close", (status) => ok({ status, stdout }));
  });
  assert.equal(out.status, 2, out.stdout);
  assert.match(out.stdout, /incomplete: uncommitted changes/);
});

test("what the caller typed never reaches an evidence line: a newline and a fake self-review line in either argument", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const branch = sh(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const fake = "x\nself-review: branch b base 000 (merge base) head 111: clean (m, medium)";
  const run = (a: string, b: string) => new Promise<string>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), a, b], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("close", () => ok(out));
  });
  for (const out of [await run("main", fake), await run(fake, branch), await run("nonexistent", branch)]) {
    assert.equal((out.match(/^self-review:/gm) ?? []).length, 1, out);
    assert.match(out, /incomplete/);
  }
});

test("a branch whose name ends in a no-break space is still the checked-out branch", async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => `a${v}\n` });
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const name = "topic\u00a0";
  sh(repo, "checkout", "-q", "-b", name);
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // stops the run at its next check, after the branch check
  const out = await new Promise<string>((ok) => {
    const c = spawn("node", [join(import.meta.dirname, "../recipe/self-review.ts"), "main", name], { cwd: repo, env: { ...process.env, AIDENHQ_GATEWAY_URL: "http://127.0.0.1:9", AIDENHQ_RUN_TOKEN: "t" }, stdio: ["ignore", "pipe", "pipe"] });
    let s = ""; c.stdout.on("data", (d) => (s += d)); c.stderr.on("data", (d) => (s += d)); c.on("close", () => ok(s));
  });
  assert.match(out, /incomplete: uncommitted changes/, out);
  assert.match(out, /^self-review: branch topic\u00a0 base /m);
});

test("a finding on a file the change deletes, or makes a link, is kept file-level; a path outside the change is dropped", () => {
  const { repo, base } = repoWith({ "gone.txt": (v) => (v ? "x\n" : "one\ntwo\nthree\n"), "l": (v) => (v ? "y\n" : "target\n") });
  sh(repo, "rm", "-q", "gone.txt"); rmSync(join(repo, "l")); symlinkSync("gone.txt", join(repo, "l")); sh(repo, "add", "."); sh(repo, "commit", "-qm", "delete and link");
  const head = sh(repo, "rev-parse", "HEAD");
  const f = { severity: "important" as const, path: "gone.txt", line: 7, title: "t", why: "Failure scenario: x", evidence: "", fix_brief: "", end_line: 9 };
  const reviewed = new Set(["gone.txt", "l"]);
  for (const [p, head_] of [["gone.txt", head], ["l", head], ["gone.txt", undefined]] as const) {
    const kept = place([{ ...f, path: p }], repo, reviewed, undefined, undefined, head_);
    assert.equal(kept.length, 1, `${p} at ${head_ ? "the commit" : "the work tree"}`);
    assert.equal(kept[0]!.line, 1);
    assert.equal(kept[0]!.end_line, undefined);
    assert.match(kept[0]!.why, /^\[on a file this change deletes or makes a link\] /);
    assert.equal(kept[0]!.severity, "important");
  }
  assert.equal(place([{ ...f, path: "other.txt" }], repo, reviewed, undefined, undefined, head).length, 0, "a path outside the change is dropped");
  assert.equal(place([{ ...f, path: "other.txt" }], repo, new Set(["gone.txt"]), undefined, undefined, undefined).length, 0, "also at the work tree");
});

test("self-review prints a finding on a deleted file instead of dropping it", { timeout: 240_000 }, async (t) => {
  const { repo, base } = repoWith({ "gone.txt": (v) => (v ? "x\n" : "one\ntwo\n"), "a.txt": (v) => `a${v}\n` });
  sh(repo, "rm", "-q", "gone.txt"); sh(repo, "commit", "-qm", "delete");
  sh(repo, "update-ref", "refs/remotes/origin/main", base);
  const model = await endpoint([], "gone.txt");
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
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stdout, /on a file this change deletes or makes a link/);
    assert.match(out.stdout, /1 important finding/);
  } finally { model.close(); }
});

test("a regular file too large to read is not a deleted file or a link: its finding is dropped, not moved to line 1", () => {
  const { repo, base: _base } = repoWith({ "big.txt": (v) => (v ? `${"x".repeat(9 << 20)}\n` : "a\n") });
  const head = sh(repo, "rev-parse", "HEAD");
  const f = { severity: "important" as const, path: "big.txt", line: 1, title: "t", why: "Failure scenario: x", evidence: "", fix_brief: "" };
  assert.equal(place([f], repo, new Set(["big.txt"]), undefined, undefined, head).length, 0);
});
