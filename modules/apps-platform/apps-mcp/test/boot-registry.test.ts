import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeHostOps } from "../src/codehost.js";
import { bootRegistry } from "../src/git.js";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const env = { appsData: "/a", gitDir: "/g" };
const sleep = () => Promise.resolve();
const root = () => mkdtempSync(join(tmpdir(), "boot-"));

/** A bare repo holding apps.yaml, made by cloning (no push needed). */
const remoteWithRegistry = (dir: string): string => {
  sh(dir, "init", "-q", "work");
  writeFileSync(`${dir}/work/apps.yaml`, "apps:\n  - name: demo\n");
  sh(`${dir}/work`, "add", "apps.yaml");
  sh(`${dir}/work`, "commit", "-qm", "init");
  sh(dir, "clone", "-q", "--bare", "work", "remote.git");
  return `${dir}/remote.git`;
};

afterEach(() => vi.restoreAllMocks());

describe("bootRegistry", () => {
  it("serves the registry already on disk when every attempt fails", async () => {
    const dir = root();
    const registry = `${dir}/registry`;
    mkdirSync(registry);
    writeFileSync(`${registry}/apps.yaml`, "apps:\n  - name: demo\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tries = vi.fn(sleep);
    // A fetch op that fails every time, as the kernel answering 500 did in production.
    const appToken = vi.fn(async () => {
      throw new Error("the kernel said 500 to fetch: example-org/aidenhq-instance");
    });
    await expect(bootRegistry({ ...env, ops: { fetch: appToken } as unknown as CodeHostOps }, registry, "https://github.com/example-org/aidenhq-instance.git", { attempts: 3, baseDelayMs: 1, sleep: tries })).resolves.toBeUndefined();
    expect(appToken).toHaveBeenCalledTimes(3);
    expect(tries).toHaveBeenCalledTimes(2); // no wait after the last attempt
    expect(readFileSync(`${registry}/apps.yaml`, "utf8")).toContain("demo");
    expect(warn).toHaveBeenCalledTimes(4); // one per attempt, then the on-disk registry
    expect(warn.mock.calls.slice(0, 3).map(([m]) => m)).toEqual([1, 2, 3].map((n) => `registry sync attempt ${n}/3 failed (the kernel said 500)`));
    expect(String(warn.mock.calls[3]![0])).toContain("serving the registry already on disk");
    // The error names the registry's repo; the log must not.
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/example-org|aidenhq-instance/);
  });

  it("fails closed after the configured attempts when there is no registry", async () => {
    const dir = root();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tries = vi.fn(sleep);
    const attempt = vi.fn(async () => {
      throw new Error("git fetch failed: no such repo");
    });
    await expect(bootRegistry({ ...env, ops: { fetch: attempt } as unknown as CodeHostOps }, `${dir}/registry`, "https://github.com/example-org/aidenhq-instance.git", { attempts: 4, baseDelayMs: 1, sleep: tries })).rejects.toThrow("git fetch failed");
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(tries).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.some(([m]) => String(m).includes("already on disk"))).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/no such repo/);
  });

  it("backs off exponentially between attempts, so a bound is reached quickly", async () => {
    const dir = root();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits: number[] = [];
    const appToken = vi.fn(async () => {
      throw new Error("the kernel said 500");
    });
    await expect(bootRegistry({ ...env, ops: { fetch: appToken } as unknown as CodeHostOps }, `${dir}/registry`, "https://github.com/example-org/aidenhq-instance.git", { attempts: 4, baseDelayMs: 10, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow("the kernel said 500");
    expect(waits).toEqual([10, 20, 40]);
  });

  it("resolves on a later attempt when the fetch succeeds then", async () => {
    const dir = root();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = `${dir}/registry`;
    // The remote only appears while the first attempt waits, so attempt 1 fails and attempt 2 fetches it.
    await bootRegistry(env, registry, `${dir}/remote.git`, { attempts: 3, baseDelayMs: 1, sleep: async () => void remoteWithRegistry(dir) });
    expect(readFileSync(`${registry}/apps.yaml`, "utf8")).toContain("demo");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
