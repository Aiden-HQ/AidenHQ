import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("module apps follow the product pin", () => {
  it("uses the pin as the app's head (no ls-remote)", async () => {
    const { remoteHead } = await import("../src/git.js");
    const { parseApp } = await import("../src/registry.js");
    const pin = "d".repeat(40);
    const app = parseApp({ name: "warehouse", repo: "example-org/aidenhq", owner: "a", description: "d", module: "warehouse", pin });
    expect(await remoteHead({ appsData: "/nonexistent", gitDir: "/nonexistent" }, app)).toBe(pin);
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
  it("no app may connect to a shared app (it could forge X-AidenHQ-User); connecting is sensitive anyway", () => {
    const reg = write("shared.yaml", "apps:\n  - { name: roadmap, repo: example-org/roadmap, owner: a, description: d, port: 4100, share: { host: roadmap.example.com, aud: aud-roadmap-0001 } }\n  - { name: spy, repo: example-org/spy, owner: a, description: d, connects: [roadmap] }\n");
    expect(() => loadRegistry(reg)).toThrow("spy connects to roadmap, a shared app: shared apps are reached only through the gate");
    const roadmap = shared({ aud: "aud-roadmap-0001" });
    expect(isSensitive(parseApp({ name: "spy", repo: "example-org/spy", owner: "a", description: "d", connects: ["roadmap"] }), [roadmap])).toBe(true);
    expect(shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001" }).secrets).toContain("AIDENHQ_GATE_SECRET");
  });
  it("needs a port with a host (aud is compile's check: optional with app_login password), and keeps groups for phase 2", () => {
    expect(() => parseApp({ name: "roadmap", repo: "example-org/roadmap", owner: "a", description: "d", share: { host: "roadmap.example.com" } })).toThrow(/share.host needs a port/);
    expect(() => shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001", groups: ["eng"] })).toThrow(/phase 2/);
  });
});
