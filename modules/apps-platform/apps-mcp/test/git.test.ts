import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkout, resolveCommit } from "../src/git.js";
import { parseApp } from "../src/registry.js";

const root = mkdtempSync(join(tmpdir(), "resolve-"));
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "advice.graftFileDeprecated=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A module app (like a product-pinned one) is fetched from the host's product checkout, which can lag GitHub. Its bare
// repo starts empty and that checkout stopped at the first commit: everything after is only on its own origin.
sh(root, "init", "-q", "-b", "main", "origin");
writeFileSync(join(root, "origin/app.txt"), "v1\n");
sh(`${root}/origin`, "add", "app.txt");
sh(`${root}/origin`, "commit", "-q", "-m", "v1");
const v1 = sh(`${root}/origin`, "rev-parse", "HEAD");
sh(root, "clone", "-q", `${root}/origin`, "checkout");
sh(`${root}/checkout`, "checkout", "-q", "--detach");
sh(`${root}/origin`, "checkout", "-q", "-b", "side");
writeFileSync(join(root, "origin/app.txt"), "side\n");
sh(`${root}/origin`, "commit", "-q", "-am", "side");
const side = sh(`${root}/origin`, "rev-parse", "HEAD");
sh(`${root}/origin`, "checkout", "-q", "main");
writeFileSync(join(root, "origin/app.txt"), "v2\n");
sh(`${root}/origin`, "commit", "-q", "-am", "v2");
const v2 = sh(`${root}/origin`, "rev-parse", "HEAD");

// The app's origin on disk stands in for https://github.com/example-org/aidenhq.git (a global url rewrite): offline.
const home = `${root}/home`;
mkdirSync(home);
writeFileSync(join(home, ".gitconfig"), `[url "${root}/origin/"]\n\tinsteadOf = https://github.com/example-org/aidenhq.git\n`);
const set = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
afterAll(() => {
  for (const [k, v] of Object.entries(set)) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

const env = { appsData: `${root}/apps`, gitDir: `${root}/git`, productDir: `${root}/checkout`, orgs: ["example-org"] };
const app = parseApp({ name: "warehouse", repo: "example-org/aidenhq", owner: "a", description: "d", module: "warehouse", pin: v1 });

describe("resolveCommit", () => {
  it("fetches origin/main from the app's own origin when the commit isn't in its bare repo yet", async () => {
    expect(await resolveCommit(env, app, v2)).toEqual({ sha: v2, subject: "v2" });
    expect(await resolveCommit(env, app, v2.slice(0, 7))).toEqual({ sha: v2, subject: "v2" });
    // The deploy's checkout follows: the stale checkout it is refetched from doesn't rewind origin/main off the commit.
    const co = await checkout(env, app, v2);
    expect(co.sha).toBe(v2);
    expect(readFileSync(join(co.dir, "app.txt"), "utf8")).toBe("v2\n");
  });
  it("keeps the error for a sha that is neither here nor on origin", async () => {
    const missing = "a".repeat(40);
    await expect(resolveCommit(env, app, missing)).rejects.toThrow(`no single commit ${missing} in example-org/aidenhq`);
  });
  it("doesn't fetch a commit that is only off origin/main, and refuses one no longer on it", async () => {
    await expect(resolveCommit(env, app, side)).rejects.toThrow(`no single commit ${side} in example-org/aidenhq`);
    // v2 is in the bare repo now, but main moved back off it: reachability still decides.
    sh(`${root}/origin`, "update-ref", "refs/heads/main", v1);
    await expect(resolveCommit(env, app, v2)).rejects.toThrow(`commit ${v2.slice(0, 12)} is not on origin/main`);
  });
});
