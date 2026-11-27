import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { createPlatform } from "../src/platform.js";

// The apps node without a join key (tailscale mode, no TS_APPS_AUTHKEY): it is a door only once logged in; until then apps
// require a signed identity and get no URL. Once an app is served and the node says NeedsLogin, the owner gets one generic
// `decision` notice (no link: the login link is a bearer secret) and the link is on the board-only /internal/apps-node.
it("a keyless apps node is no door until it logs in, and its login link never goes through notify", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edge-login-"));
  const registryPath = join(dir, "apps.yaml");
  writeFileSync(registryPath, "apps:\n  - { name: notes, repo: local/notes, owner: a, description: d, port: 8123 }\n");
  writeFileSync(join(dir, "apps-node"), "tailnet\n");
  const sent: { text: string; key: string }[] = [];
  let state: { BackendState?: string; AuthURL?: string } = { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc123" };
  const p = createPlatform(
    { registryPath, modulesRegistryPath: join(dir, "apps.modules.yaml"), appsData: dir, secretsDir: dir, hostSecretsDir: dir, identityKeyFile: join(dir, "missing.pem"), identityKeysHostFile: join(dir, "keys.json"), dbPath: join(dir, "state.sqlite"), urlBase: "https://aidenhq-apps.example.ts.net", appsNodeFile: join(dir, "apps-node"), edgeDir: dir, healthImage: "none", git: { appsData: dir, gitDir: dir }, nodeStatus: async () => state, notify: async (text, key) => void sent.push({ text, key }) },
    { warn: () => {}, info: () => {} },
  );
  const edge = () => p.syncEdge().catch(() => {}); // no docker here: the node's status is read first
  await edge();
  expect(sent).toEqual([]); // nothing served yet: no door needed
  p.store.addDeploy({ app: "notes", sha: "a".repeat(40), images_json: "[]", by: "auto-deploy", at: 1, status: "healthy", detail: "" });
  p.store.setRunning("notes", "a".repeat(40));
  await edge();
  await edge();
  expect(sent).toEqual([{ text: expect.not.stringContaining("tailscale.com"), key: "apps-edge:login" }]);
  expect(p.nodeState()).toEqual({ up: false, login_url: "https://login.tailscale.com/a/abc123" });
  expect(p.node()).toBe(false); // not logged in: apps keep requiring a signed identity
  expect(await p.status(p.find("notes"))).toMatchObject({ url: undefined, unpublished: expect.stringMatching(/Tailscale sign-in/) });
  state = { BackendState: "Running" };
  await edge();
  expect(p.node()).toBe(true);
  expect(p.nodeState()).toEqual({ up: true });
  expect(await p.status(p.find("notes"))).toMatchObject({ url: "https://aidenhq-apps.example.ts.net:8123" });
});
