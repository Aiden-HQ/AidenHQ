// A missing program fails the one job with a reason; it never crashes the runner (2026-11-10: bwrap not installed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/engines.mjs";

test("a program that isn't installed ends the job with the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-"));
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const r = await runAgent({ cfg: { ghWrapperDir: dir, timeout_minutes: 1 }, engine: { kind: "codex" }, worktree: dir, prompt: "hi", logPath: join(dir, "log") });
    assert.notEqual(r.code, 0);
    assert.match(r.lastMessage, /couldn't start \S+: ENOENT/);
  } finally {
    process.env.PATH = path;
  }
});

test("the runner's own GitHub token never reaches the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-"));
  writeFileSync(join(dir, "codex"), '#!/bin/sh\necho "GH=[$GH_TOKEN][$GITHUB_TOKEN]"\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.GH_TOKEN = "runner-secret";
  try {
    await runAgent({ cfg: { ghWrapperDir: dir, timeout_minutes: 1 }, engine: { kind: "codex" }, worktree: dir, prompt: "hi", logPath: join(dir, "log") });
    assert.match(readFileSync(join(dir, "log"), "utf8"), /GH=\[\]\[\]/);
    // The job's own: the App's read token for the task's repos.
    await runAgent({ cfg: { ghWrapperDir: dir, timeout_minutes: 1 }, engine: { kind: "codex" }, worktree: dir, prompt: "hi", logPath: join(dir, "log2"), ghToken: "job-read" });
    assert.match(readFileSync(join(dir, "log2"), "utf8"), /GH=\[job-read\]\[\]/);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved.GH_TOKEN;
  }
});
