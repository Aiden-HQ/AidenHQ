// codex-native sends the patch itself (patchGroups), one request for an ordinary change; the review is clean only when every group
// came back. Run against the pinned Codex (0.166.0, the engineer image's) and a recording model endpoint: the outbound request holds the
// exact patch, its last hunk included, and a failed group blocks clean. Codex is the PATH's when it is that version, else installed once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { patchGroups, runEngine } from "../recipe/engines.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const PIN = "0.166.0";

function codexDir() {
  const ver = (bin: string) => { try { return execFileSync(bin, ["--version"], { encoding: "utf8" }).includes(PIN); } catch { return false; } };
  if (ver("codex")) return undefined;
  const prefix = join(tmpdir(), `codex-${PIN}`), bin = join(prefix, "node_modules", ".bin");
  if (!existsSync(join(bin, "codex"))) { mkdirSync(prefix, { recursive: true }); execFileSync("npm", ["i", "--silent", "--prefix", prefix, `@openai/codex@${PIN}`], { stdio: "inherit" }); }
  return bin;
}

/** A model endpoint that records each request and answers with a review (a verdict of "patch is correct"), or fails the ones in `fail`. */
async function endpoint(fail: number[] = []) {
  const requests: any[] = [];
  const verdict = JSON.stringify({ findings: [], overall_correctness: "patch is correct", overall_explanation: "ok", overall_confidence_score: 0.9 });
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      requests.push(JSON.parse(b || "{}"));
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
  sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  for (const v of [0, 1]) {
    for (const [p, make] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), make(v)); }
    sh(repo, "add", "."); sh(repo, "commit", "-qm", `v${v}`);
    if (!v) sh(repo, "tag", "base");
  }
  return { dir, repo, base: sh(repo, "rev-parse", "base") };
}
const lines = (n: number, v: number, step: number, width = 60) => Array.from({ length: n }, (_, i) => (i % step === 0 && v ? `changed ${i} ${"x".repeat(width)}` : `line ${i}`)).join("\n") + "\n";
const patchOf = (repo: string, base: string, p: string) => execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", base, "HEAD", "--", p], { cwd: repo, encoding: "utf8" });
const sent = (r: any) => JSON.stringify(r.input);

async function review(repo: string, base: string, files: string[], model: Awaited<ReturnType<typeof endpoint>>) {
  const dir = codexDir();
  if (dir) process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.OPENROUTER_BASE_URL = model.url;
  process.env.OPENROUTER_API_KEY = "test-token";
  return runEngine("codex-native", { prompt: "", instructions: "x", model: "m/m", effort: "low", root: repo, base, files, minutes: 3, scratch: mkdtempSync(join(tmpdir(), "native-scratch-")), own: true });
}

test("an ordinary change goes out in one request holding the exact patch, its last hunk included", { timeout: 240_000 }, async () => {
  const { repo, base } = repoWith({ "big.txt": (v) => lines(300, v, 25), "s.txt": (v) => `s${v}\n`, "gone.txt": (v) => (v ? "" : "x\n") });
  const model = await endpoint();
  try {
    const r = await review(repo, base, ["big.txt", "s.txt", "gone.txt"], model);
    assert.equal(model.requests.length, 1);
    assert.equal(r.incomplete, undefined);
    assert.equal(JSON.parse(r.message).findings.length, 0);
    const body = JSON.parse(sent(model.requests[0]!)) as unknown; // the request as JSON text, decoded once
    const text = JSON.stringify(body).replaceAll("\\n", "\n").replaceAll('\\"', '"');
    for (const p of ["big.txt", "s.txt"]) assert.ok(text.includes(patchOf(repo, base, p).trimEnd()), `${p}'s exact patch was sent`);
    assert.ok(text.includes("changed 275 "), "the last hunk of big.txt was sent");
  } finally { model.close(); }
});

test("a group that failed blocks clean and is named", { timeout: 240_000 }, async () => {
  const { repo, base } = repoWith({ "a.txt": (v) => lines(6000, v, 100, 1500), "b.txt": (v) => lines(6000, v, 100, 1500) });
  const model = await endpoint([2]);
  try {
    const r = await review(repo, base, ["a.txt", "b.txt"], model);
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
