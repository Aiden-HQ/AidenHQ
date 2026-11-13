// The image-scan check's selection step (the product's CI and the app CI template), run for real on a scratch repo: a
// Dockerfile a PR changes is always selected, whatever its FROM (a `FROM $X` image is built and fails if it can't
// resolve; it is never skipped), and a change that touches no image selects nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dirname, "../..");
const findStep = (file) => parse(readFileSync(join(root, file), "utf8")).jobs["image-changes"].steps.find((s) => s.id === "find").run;

for (const file of [".github/workflows/ci.yml", "modules/core/templates/ci/.github/workflows/ci.yml"]) {
  test(`${file}: image-changes selects every changed image, FROM an ARG included`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "image-scan-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...a) => execFileSync("git", a, { cwd: dir, env, stdio: "pipe" }).toString().trim();
    const put = (path, text) => (mkdirSync(join(dir, dirname(path)), { recursive: true }), writeFileSync(join(dir, path), text));
    git("init", "-q", "-b", "main");
    put("web/Dockerfile", "FROM node:24@sha256:" + "0".repeat(64) + "\n");
    put("tool/Dockerfile", "ARG BASE=example/base\nFROM $BASE\n");
    put("README.md", "x\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const select = () => {
      const out = join(dir, "out");
      writeFileSync(out, "");
      const head = git("rev-parse", "HEAD");
      execFileSync("bash", ["-c", findStep(file)], { cwd: dir, env: { ...env, BASE_SHA: base, PR_BASE: base, HEAD_SHA: head, GITHUB_OUTPUT: out }, stdio: "pipe" });
      return readFileSync(out, "utf8").trim();
    };
    put("README.md", "y\n");
    git("commit", "-qam", "docs");
    assert.equal(select(), "dockerfiles=");
    put("tool/Dockerfile", "ARG BASE=example/other\nFROM $BASE\n");
    put("web/package-lock.json", "{}\n");
    git("add", "-A");
    git("commit", "-qm", "images");
    assert.equal(select(), "dockerfiles=tool/Dockerfile web/Dockerfile");
  });
}
