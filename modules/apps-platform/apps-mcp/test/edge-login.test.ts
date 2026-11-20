import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPlatform } from "../src/platform.js";

// The apps node without a join key (tailscale mode, no TS_APPS_AUTHKEY): once an app needs the door and the node says
// NeedsLogin, its login link goes to the owner as one `decision` notice.
it("a keyless apps node sends the owner its login link once an app is served", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-login-"));
  writeFileSync(join(dir, "docker"), `#!/bin/sh\ncase "$*" in *"status --json"*) echo '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/abc123"}';; *) echo '{}';; esac\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const registryPath = join(dir, "apps.yaml");
  writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d, port: 8123 }\n");
  writeFileSync(join(dir, "apps-node"), "tailnet\n");
  const sent: { text: string; key: string }[] = [];
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const p = createPlatform(
      { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "https://aidenhq-apps.example.ts.net", appsNodeFile: join(dir, "apps-node"), edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir }, notify: async (text, key) => void sent.push({ text, key }) },
      { warn: () => {}, info: () => {} },
    );
    await p.syncEdge();
    expect(sent).toEqual([]); // nothing served yet: no door needed
    p.store.addDeploy({ app: "notes", sha: "a".repeat(40), images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
    await p.syncEdge();
    await p.syncEdge();
    expect(sent).toEqual([{ text: expect.stringContaining("https://login.tailscale.com/a/abc123"), key: "apps-edge:login" }]);
  } finally {
    process.env.PATH = path;
  }
});
