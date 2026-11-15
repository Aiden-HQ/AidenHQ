import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffForDeploy, diffSince } from "../src/git.js";
import { parseApp } from "../src/registry.js";

// An app of a product repo: its own directory (apps/warehouse) beside everything else the repo holds.
const root = mkdtempSync(join(tmpdir(), "deploy-diff-"));
const src = join(root, "src");
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "advice.graftFileDeprecated=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path: string, body: string) => {
  mkdirSync(dirname(join(src, path)), { recursive: true });
  writeFileSync(join(src, path), body);
};

sh(root, "init", "-q", "-b", "main", "src");
write("apps/warehouse/compose.yaml", "services:\n  db:\n    image: postgres:17.12\n");
sh(src, "add", "-A");
sh(src, "commit", "-q", "-m", "base");
const base = sh(src, "rev-parse", "HEAD");

// The deploy that was refused: hundreds of unrelated files change repo-wide, the app gets one small change.
for (let i = 0; i < 500; i++) write(`unrelated/dir-${i % 20}/file-${i}.txt`, `${"unrelated change ".repeat(12)}${i}\n`);
write("apps/warehouse/compose.yaml", "services:\n  db:\n    image: postgres:17.12\n    restart: unless-stopped\n");
sh(src, "add", "-A");
sh(src, "commit", "-q", "-m", "repo-wide plus a small app change");
const mixed = sh(src, "rev-parse", "HEAD");

// A commit touching nothing of the app at all.
write("docs/notes.md", "outside the app\n");
sh(src, "add", "-A");
sh(src, "commit", "-q", "-m", "outside only");
const outside = sh(src, "rev-parse", "HEAD");

// More than the 60,000-character cap, all of it inside the app.
write("apps/warehouse/seed.sql", `${Array.from({ length: 2_000 }, (_, i) => `insert into t values (${i}, '${"x".repeat(30)}');`).join("\n")}\n`);
sh(src, "add", "-A");
sh(src, "commit", "-q", "-m", "an app change over the cap");
const huge = sh(src, "rev-parse", "HEAD");

sh(root, "init", "-q", "--bare", "warehouse.git");
sh(root, "--git-dir=warehouse.git", "fetch", "-q", src, "+refs/heads/*:refs/remotes/origin/*");
const env = { appsData: join(root, "data"), gitDir: root };
const app = parseApp({ name: "warehouse", repo: "example-org/aidenhq", owner: "a", description: "d", path: "apps/warehouse" });

describe("diffForDeploy", () => {
  it("measures only the app's own directory, so a repo-wide change doesn't trip the cap", async () => {
    const all = await diffSince(env, app, base, mixed);
    expect(all.truncated).toBe(true); // what refused the deploy before: the repo-wide diff is over the cap
    const d = await diffForDeploy(env, app, base, mixed);
    expect(d.truncated).toBe(false);
    expect(d.diff).toContain("apps/warehouse/compose.yaml");
    expect(d.diff).not.toContain("unrelated/");
    expect(d.diff.length).toBeLessThan(60_000);
  });
  it("still truncates a change under the app's directory that is over the cap", async () => {
    const d = await diffForDeploy(env, app, outside, huge);
    expect(d.truncated).toBe(true);
    expect(d.diff.length).toBe(60_000);
  });
  it("is empty for a commit that changes nothing of the app", async () => {
    expect(await diffForDeploy(env, app, mixed, outside)).toEqual({ diff: "", truncated: false });
  });
});
