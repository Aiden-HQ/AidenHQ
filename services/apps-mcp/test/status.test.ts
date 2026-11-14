import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlatform } from "../src/platform.js";

// The status row is what the board's grader reads for "deployed at the merged commit": it carries the running commit, who
// deployed it and the recent deploy history, so a reader can tell the platform's own auto-deploy from a hand deploy.
describe("status row", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const registryPath = join(dir, "apps.yaml");
    writeFileSync(registryPath, "apps:\n  - { name: notes, repo: example-org/notes, owner: a, description: d }\n");
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "", edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir } },
      { warn: () => {}, info: () => {} },
    );
    return p;
  };

  it("carries the running commit, who deployed it and the recent deploys", async () => {
    const p = setup();
    expect((await p.status(p.find("notes"))).deploys).toEqual([]);
    p.store.addDeploy({ app: "notes", sha: "a".repeat(40), images_json: "[]", by: "reconcile", at: 1, status: "healthy", detail: "" });
    p.store.addDeploy({ app: "notes", sha: "b".repeat(40), images_json: "[]", by: "auto-deploy", at: 2, status: "healthy", detail: "" });
    const row = await p.status(p.find("notes"));
    expect(row).toMatchObject({ name: "notes", repo: "example-org/notes", owner: "a", sha: "b".repeat(40), deployed_by: "auto-deploy", auto_deploy: true });
    expect(row.deploys?.map((d) => [d.sha.slice(0, 1), d.by, d.status])).toEqual([
      ["b", "auto-deploy", "healthy"],
      ["a", "reconcile", "healthy"],
    ]);
  });
});
