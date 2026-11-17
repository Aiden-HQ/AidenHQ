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

  // The row's list is bounded, so the grader looks a merge commit up by exact sha: that read is over every deploy the app
  // ever had, not the newest few, or a merge that deployed would stop being provable once later deploys pushed it out.
  it("looks one exact commit's deploys up over the whole table, past the row's bounded list", async () => {
    const p = setup();
    const old = "c".repeat(40);
    p.store.addDeploy({ app: "notes", sha: old, images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
    for (let i = 0; i < 10; i++) p.store.addDeploy({ app: "notes", sha: `${i}`.repeat(40), images_json: "[]", by: "auto-deploy", at: 100 + i, status: i === 9 ? "failed" : "healthy", detail: "" });
    expect(p.store.recentDeploys("notes", 20).some((d) => d.sha === old)).toBe(true);
    expect(p.store.recentDeploys("notes").map((d) => d.sha)).not.toContain(old);
    expect(p.store.deploysOf("notes", old).map((d) => [d.sha.slice(0, 1), d.by, d.status])).toEqual([["c", "auto-deploy", "healthy"]]);
    // A commit that was never deployed has no row at all: the reader can tell that from aged-out.
    expect(p.store.deploysOf("notes", "f".repeat(40))).toEqual([]);
  });
});
