// The codex-native engine counts the change as read only when commands that name the requested base (its sha, the merge base's, or
// `git merge-base`) printed the diff of every file it touches: `git show HEAD`, or one file of two, is a part of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine } from "../recipe/engines.ts";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

async function readOf(command: (base: string) => string, opts: { files?: boolean; badBase?: boolean; lockOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-read-"));
  const repo = join(dir, "repo"), bin = join(dir, "bin");
  mkdirSync(repo); mkdirSync(bin);
  sh(repo, "init", "-q"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a"), "1\n"); sh(repo, "add", "a"); sh(repo, "commit", "-qm", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  if (opts.lockOnly) { writeFileSync(join(repo, "package-lock.json"), "{}\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "lock"); }
  else {
  writeFileSync(join(repo, "a"), "2\n"); sh(repo, "commit", "-qam", "one");
  writeFileSync(join(repo, "b"), "3\n"); sh(repo, "add", "b"); sh(repo, "commit", "-qm", "two");
  }
  if (opts.files) {
    // A quoted path (non-ASCII, a space) and a rename that git pairs in one header.
    writeFileSync(join(repo, "café x.txt"), "4\n"); writeFileSync(join(repo, "old.txt"), "line1\nline2\nline3\nline4\n");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "three", "--no-verify");
    sh(repo, "mv", "old.txt", "new.txt"); writeFileSync(join(repo, "new.txt"), "line1\nline2\nline3\nline4 changed\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "four");
  }
  const cmd = command(base);
  const asked = opts.badBase ? "deadbeefdeadbeef" : base;
  const out = execFileSync("sh", ["-c", cmd], { cwd: repo, encoding: "utf8" });
  const events = [{ type: "item.completed", item: { type: "command_execution", command: cmd, aggregated_output: out } }, { type: "turn.completed" }];
  const rollout = JSON.stringify({ payload: { item: { type: "ExitedReviewMode", review_output: { findings: [], overall_correctness: "patch is correct" } } } });
  // A stand-in codex: prints the events and leaves the review in the session rollouts.
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions"\ncat > "$CODEX_HOME/sessions/s.jsonl" <<'EOF2'\n${rollout}\nEOF2\ncat <<'EOF2'\n${events.map((e) => JSON.stringify(e)).join("\n")}\nEOF2\n`);
  chmodSync(join(bin, "codex"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
  const r = await runEngine("codex-native", { prompt: "", instructions: "x", model: "m/m", effort: "low", root: repo, base: asked, minutes: 1, scratch: dir, own: true });
  return r.read;
}

test("the diff by the base's sha counts as read", async () => assert.equal(await readOf((b) => `git diff ${b} HEAD`), true));
test("the diff by `git merge-base` counts as read", async () => assert.equal(await readOf(() => "git diff $(git merge-base HEAD~2 HEAD) HEAD"), true));
test("git show HEAD is a part of the change, not the read", async () => assert.equal(await readOf(() => "git show HEAD"), false));
test("one file of two is not the read", async () => assert.equal(await readOf((b) => `git diff ${b} HEAD -- a`), false));
test("quoted paths and a rename in git's default diff are covered", async () => assert.equal(await readOf((b) => `git diff ${b} HEAD`, { files: true }), true));
test("a changed-file list that can't be made is not clean", async () => assert.equal(await readOf((b) => `git diff ${b} HEAD`, { badBase: true }), false));
test("headers without a hunk (a cut-off output) are not the read", async () => assert.equal(await readOf((b) => `git diff ${b} HEAD | grep -v '^@@\\|^[-+ ]'`), false));
test("only a lockfile changed: there is nothing to require", async () => assert.equal(await readOf(() => "true", { lockOnly: true }), true));
