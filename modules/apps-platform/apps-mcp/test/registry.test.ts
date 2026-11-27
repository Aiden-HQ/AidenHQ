import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSensitive, loadRegistry, parseApp } from "../src/registry.js";

const dir = mkdtempSync(join(tmpdir(), "reg-"));
const write = (name: string, body: string) => (writeFileSync(join(dir, name), body), join(dir, name));
const instance = write("apps.yaml", "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d }\n");
const modules = write("apps.modules.yaml", "apps:\n  - { name: warehouse, repo: example-org/aidenhq, path: modules/warehouse/apps/warehouse, owner: app-maintainer, description: d, module: warehouse }\n");

describe("two registries", () => {
  it("loads the instance apps and the module apps together; a missing module registry is empty", () => {
    expect(loadRegistry(instance, modules).map((a) => a.name)).toEqual(["notes", "warehouse"]);
    expect(loadRegistry(instance, join(dir, "absent.yaml")).map((a) => a.name)).toEqual(["notes"]);
  });
});

describe("share (shared access)", () => {
  const shared = (share: object) => parseApp({ name: "roadmap", repo: "example-org/roadmap", owner: "a", description: "d", port: 4100, share });
  it("no app may connect to a shared app (the gate is its only caller); connecting is sensitive anyway", () => {
    const reg = write("shared.yaml", "apps:\n  - { name: roadmap, repo: example-org/roadmap, owner: a, description: d, port: 4100, share: { host: roadmap.example.com, aud: aud-roadmap-0001 } }\n  - { name: spy, repo: example-org/spy, owner: a, description: d, connects: [roadmap] }\n");
    expect(() => loadRegistry(reg)).toThrow("spy connects to roadmap, a shared app: shared apps are reached only through the gate");
    const roadmap = shared({ aud: "aud-roadmap-0001" });
    expect(isSensitive(parseApp({ name: "spy", repo: "example-org/spy", owner: "a", description: "d", connects: ["roadmap"] }), [roadmap])).toBe(true);
    expect(shared({ host: "roadmap.example.com", aud: "aud-roadmap-0001" }).secrets).toEqual([]); // identity is the platform's (no per-app gate secret)
  });
});
