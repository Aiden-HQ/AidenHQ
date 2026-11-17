import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorize } from "../src/api.js";
import { checkRemovable, isSensitive, loadRegistry, parseApp } from "../src/registry.js";
import { exposes } from "../src/tailnet.js";

const dir = mkdtempSync(join(tmpdir(), "reg-"));
const write = (name: string, body: string) => (writeFileSync(join(dir, name), body), join(dir, name));
const instance = write("apps.yaml", "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d }\n");
const modules = write("apps.modules.yaml", "apps:\n  - { name: warehouse, repo: example-org/aidenhq, path: modules/warehouse/apps/warehouse, owner: app-maintainer, description: d, module: warehouse }\n");

describe("two registries", () => {
  it("loads the instance apps and the module apps together; a missing module registry is empty", () => {
    expect(loadRegistry(instance, modules).map((a) => a.name)).toEqual(["notes", "warehouse"]);
    expect(loadRegistry(instance, join(dir, "absent.yaml")).map((a) => a.name)).toEqual(["notes"]);
  });
  it("refuses a name used in both", () => {
    const clash = write("clash.yaml", "apps:\n  - { name: warehouse, repo: example-org/x, owner: a, description: d }\n");
    expect(() => loadRegistry(clash, modules)).toThrow(/duplicate app warehouse/);
  });
  it("won't remove a module app", () => {
    const wh = loadRegistry(instance, modules).find((a) => a.name === "warehouse")!;
    expect(() => checkRemovable(wh)).toThrow("warehouse comes from module warehouse; disable the module instead");
  });
});

describe("a caller's exact routes, read from an apps.yaml", () => {
  // Written the way an instance writes it: the flow sequence is quoted because a route's space is ambiguous unquoted YAML.
  const file = write(
    "routes.yaml",
    `apps:
  - name: roadmap-keeper
    repo: example-org/roadmap-keeper
    owner: app-maintainer
    description: d
    health: { url: http://app:8080/api/health }
    api:
      callers:
        - roadmap-keeper
        - agent: roadmap-feedback
          paths: ["GET /api/agent/intake", "POST /api/agent/intake/{reference}/decision"]
      paths: [/api/agent/roadmap, /api/agent/intake]
`,
  );
  const rk = loadRegistry(file).find((a) => a.name === "roadmap-keeper")!;
  const verdict = (method: string, path: string, key = "roadmap-feedback") => {
    try {
      authorize(rk, key, path, method);
      return "allow";
    } catch {
      return "deny";
    }
  };
  it("keeps the two routes the caller names and refuses the rest", () => {
    expect(verdict("GET", "/api/agent/intake?status=received")).toBe("allow");
    expect(verdict("POST", "/api/agent/intake/AB12CD34/decision")).toBe("allow");
    for (const [m, p] of [
      ["DELETE", "/api/agent/intake"],
      ["POST", "/api/agent/intake"],
      ["GET", "/api/agent/intake/AB12CD34/decision"],
      ["HEAD", "/api/agent/intake"],
      ["POST", "/api/agent/intake/AB12CD34/decision/extra"],
      ["POST", "/api/agent/intake/decision"],
      ["GET", "/api/item"],
    ] as const)
      expect(verdict(m, p), `${m} ${p}`).toBe("deny");
  });
  it("leaves the app's own caller a prefix caller", () => {
    expect(verdict("GET", "/api/agent/roadmap/items/3", "roadmap-keeper")).toBe("allow");
    expect(verdict("DELETE", "/api/agent/intake/x", "roadmap-keeper")).toBe("allow");
    expect(verdict("GET", "/", "roadmap-keeper")).toBe("deny");
  });
  it("refuses a malformed route in the file", () => {
    for (const entry of ["PATCH /api/x/{a}{b}", "get /api/x", "GET /api/x/{a b}", "GET /api/x/", "GET /api/x?a=1", "GET /api/x y"])
      expect(() => loadRegistry(write("bad-routes.yaml", `apps:\n  - { name: broken, repo: example-org/x, owner: a, description: d, api: { callers: [{ agent: k, paths: [${JSON.stringify(entry)}] }], paths: [/api/x] } }\n`)), entry).toThrow();
  });
});

describe("module apps follow the product pin", () => {
  it("uses the pin as the app's head (no ls-remote)", async () => {
    const { remoteHead } = await import("../src/git.js");
    const { parseApp } = await import("../src/registry.js");
    const pin = "d".repeat(40);
    const app = parseApp({ name: "warehouse", repo: "example-org/aidenhq", owner: "a", description: "d", module: "warehouse", pin });
    expect(await remoteHead({ appsData: "/nonexistent", gitDir: "/nonexistent" }, app)).toBe(pin);
  });
  it("checks the pin out from the host's product checkout, only when it is on that checkout's origin/main", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const { checkout } = await import("../src/git.js");
    const root = mkdtempSync(join(tmpdir(), "product-"));
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
    // GitHub's copy, and the host's checkout of it: detached, with a commit that never reached origin.
    sh(root, "init", "-q", "-b", "main", "upstream");
    writeFileSync(join(root, "upstream/app.txt"), "v1\n");
    sh(`${root}/upstream`, "add", "app.txt");
    sh(`${root}/upstream`, "commit", "-q", "-m", "v1");
    sh(root, "clone", "-q", `${root}/upstream`, "product");
    const pin = sh(`${root}/product`, "rev-parse", "HEAD");
    sh(`${root}/product`, "checkout", "-q", "--detach");
    writeFileSync(join(root, "product/app.txt"), "local\n");
    sh(`${root}/product`, "commit", "-q", "-am", "local only");
    const local = sh(`${root}/product`, "rev-parse", "HEAD");
    // The repo is unreachable on purpose: the source must come from productDir.
    const env = { appsData: `${root}/apps`, gitDir: `${root}/git`, productDir: `${root}/product`, orgs: ["example-org"] };
    const app = (p: string) => parseApp({ name: "warehouse", repo: "example-org/no-such-repo", owner: "a", description: "d", module: "warehouse", pin: p });
    const co = await checkout(env, app(pin));
    expect(co.sha).toBe(pin);
    expect(readFileSync(join(co.dir, "app.txt"), "utf8")).toBe("v1\n");
    // Only origin/main's history is copied, so a commit off it isn't there to check out at all.
    await expect(checkout(env, app(local))).rejects.toThrow(/git rev-parse failed/);
    // A commit the bare repo already holds but that is no longer on the checkout's origin/main is refused too.
    writeFileSync(join(root, "upstream/app.txt"), "v2\n");
    sh(`${root}/upstream`, "commit", "-q", "-am", "v2");
    sh(`${root}/product`, "fetch", "-q", "origin");
    const v2 = sh(`${root}/product`, "rev-parse", "origin/main");
    expect((await checkout(env, app(v2))).sha).toBe(v2);
    sh(`${root}/product`, "update-ref", "refs/remotes/origin/main", pin);
    await expect(checkout(env, app(v2))).rejects.toThrow(/not reachable from origin\/main/);
    // Only the compiler's registry may name a module app: apps.yaml can't point an app at the product checkout.
    const forged = write("forged.yaml", `apps:\n  - { name: sneaky, repo: example-org/x, owner: a, description: d, module: warehouse, pin: "${pin}" }\n`);
    expect(() => loadRegistry(forged)).toThrow(/set by the compiler/);
  });
});

describe("secret names", () => {
  it("are env-style names only (they become file paths)", async () => {
    const { parseApp } = await import("../src/registry.js");
    const base = { name: "demo", repo: "example-org/x", owner: "a", description: "d" };
    expect(parseApp({ ...base, secrets: ["DB_PASSWORD"] }).secrets).toEqual(["DB_PASSWORD"]);
    expect(() => parseApp({ ...base, secrets: ["../x"] })).toThrow();
    expect(() => parseApp({ ...base, secrets: ["a/b"] })).toThrow();
  });
});

describe("share (shared access)", () => {
  const shared = (share: object) => parseApp({ name: "roadmap", repo: "example-org/roadmap", owner: "a", description: "d", port: 4100, share });
  it("is sensitive, and an app with share.host has no tailscale serve route", () => {
    const app = shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001", default_role: "member" });
    expect(isSensitive(app, [])).toBe(true);
    // The old per-email lists are refused with where admins are named now.
    expect(() => shared({ host: "roadmap.example.com", viewers: ["ann@example.com"] })).toThrow(/named on the board/);
    expect(() => shared({ host: "roadmap.example.com", default_role: "admin" })).toThrow(/never admin/);
    expect(exposes(app)).toBe(false);
    expect(exposes(shared({}))).toBe(true); // no host: no public route, the tailnet door stays
  });
  it("no app may connect to a shared app (the gate is its only caller); connecting is sensitive anyway", () => {
    const reg = write("shared.yaml", "apps:\n  - { name: roadmap, repo: example-org/roadmap, owner: a, description: d, port: 4100, share: { host: roadmap.example.com, aud: aud-roadmap-0001 } }\n  - { name: spy, repo: example-org/spy, owner: a, description: d, connects: [roadmap] }\n");
    expect(() => loadRegistry(reg)).toThrow("spy connects to roadmap, a shared app: shared apps are reached only through the gate");
    const roadmap = shared({ aud: "aud-roadmap-0001" });
    expect(isSensitive(parseApp({ name: "spy", repo: "example-org/spy", owner: "a", description: "d", connects: ["roadmap"] }), [roadmap])).toBe(true);
    expect(shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001" }).secrets).toEqual([]); // identity is the platform's (no per-app gate secret)
  });
  it("needs a port with a host (aud is compile's check: optional with app_login password), and keeps groups for phase 2", () => {
    expect(() => parseApp({ name: "roadmap", repo: "example-org/roadmap", owner: "a", description: "d", share: { host: "roadmap.example.com" } })).toThrow(/share.host needs a port/);
    expect(() => shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001", groups: ["eng"] })).toThrow(/phase 2/);
  });
});
