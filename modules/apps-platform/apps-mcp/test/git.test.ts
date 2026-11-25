// A module app's source is the host's product checkout at the instance's pin (git.ts fetchAll), never a GitHub repo the
// org allow-list (github_orgs) governs: on a stock install with no orgs, app_deploy/app_create must still accept it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { checkout } from "../src/git.js";
import { parseApp } from "../src/registry.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", input: "" }).trim();

/** A product checkout whose origin/main holds apps/warehouse; returns its dir and commit. */
function product() {
  const t = mkdtempSync(`${tmpdir()}/product-`);
  sh(t, "init", "-q", "-b", "main", "work");
  mkdirSync(`${t}/work/apps/warehouse`, { recursive: true });
  writeFileSync(`${t}/work/apps/warehouse/compose.yaml`, "services:\n  web:\n    image: x\n");
  sh(`${t}/work`, "add", "-A");
  sh(`${t}/work`, "commit", "-qm", "product");
  const sha = sh(`${t}/work`, "rev-parse", "HEAD");
  sh(`${t}/work`, "update-ref", "refs/remotes/origin/main", sha);
  return { t, dir: `${t}/work`, sha };
}

const moduleApp = (pin: string) =>
  parseApp({ name: "warehouse", repo: "Aiden-HQ/AidenHQ", module: "warehouse", pin, path: "apps/warehouse", owner: "a", description: "d", port: 8080 });

describe("module apps", () => {
  it("check out from the product pin on an install with no github_orgs", async () => {
    const p = product();
    const app = moduleApp(p.sha);
    const co = await checkout({ appsData: `${p.t}/apps`, gitDir: `${p.t}/git`, productDir: p.dir, orgs: [] }, app);
    expect(co.sha).toBe(p.sha);
    expect(readFileSync(`${co.dir}/apps/warehouse/compose.yaml`, "utf8")).toContain("services:");
  });

  it("are not what exempts a user app: the same repo without module still rejects", async () => {
    const p = product();
    const app = parseApp({ name: "warehouse", repo: "Aiden-HQ/AidenHQ", path: "apps/warehouse", owner: "a", description: "d", port: 8080 });
    const refused = checkout({ appsData: `${p.t}/apps`, gitDir: `${p.t}/git`, productDir: p.dir, orgs: [] }, app);
    await expect(refused).rejects.toThrow(/outside the allowed orgs/);
    // The refusal names the setting that fixes it.
    await expect(refused).rejects.toThrow(/github_orgs/);
  });
});
