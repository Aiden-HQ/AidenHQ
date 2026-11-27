// ensureEventsPlugin decides a reinstall on the plugin directory's content, not only the manifest version: Paperclip's
// GET /api/plugins reports the version, and post.js has changed without a bump before (#1986: evidence/source scopes).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { dirHash } from "../dir-hash.ts";
import { ensureEventsPlugin, pluginVersion } from "../paperclip-events.ts";

/** A plugin dir as mounted (package.json + manifest.js + post.js) and the Paperclip API that answers with an install. */
function fixture(post: string) {
  const root = mkdtempSync(join(tmpdir(), "pce-"));
  const pluginDir = join(root, "plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "aidenhq-paperclip-events", version: "0.4.0", type: "module" }));
  writeFileSync(join(pluginDir, "manifest.js"), `export default { id: "aidenhq.events", version: "0.4.0" };\n`);
  writeFileSync(join(pluginDir, "post.js"), post);
  const calls: { method: string; path: string }[] = [];
  const api = async (method: string, path: string) => {
    calls.push({ method, path });
    if (method === "GET" && path === "/api/plugins") return { json: [{ id: "p1", pluginKey: "aidenhq.events", version: "0.4.0", status: "active" }] };
    return { json: {} };
  };
  return { root, pluginDir, stateFile: join(root, "state", "installed.json"), calls, api };
}

test("ensureEventsPlugin reinstalls when the installed plugin's hash differs from the directory's", async () => {
  const f = fixture("export const SCOPES = ['own'];\n");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(f.stateFile, "0".repeat(64));
  const steps: string[] = [];
  await ensureEventsPlugin({ api: f.api as any, step: (m) => steps.push(m), pluginDir: f.pluginDir, stateFile: f.stateFile });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/plugins", "DELETE /api/plugins/p1", "POST /api/plugins/install"]);
  assert.equal(steps.length, 1);
});

test("ensureEventsPlugin does not reinstall when version, status and hash all match", async () => {
  const f = fixture("export const SCOPES = ['own'];\n");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(f.stateFile, dirHash(f.pluginDir));
  const steps: string[] = [];
  await ensureEventsPlugin({ api: f.api as any, step: (m) => steps.push(m), pluginDir: f.pluginDir, stateFile: f.stateFile });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/plugins"]);
  assert.deepEqual(steps, []);
});

test("ensureEventsPlugin reinstalls a plugin whose content changed while its version stayed the same", async () => {
  const f = fixture("export const SCOPES = ['own'];\n");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(f.stateFile, dirHash(f.pluginDir));
  writeFileSync(join(f.pluginDir, "post.js"), "export const SCOPES = ['own', 'evidence'];\n"); // no bump
  await ensureEventsPlugin({ api: f.api as any, step: () => {}, pluginDir: f.pluginDir, stateFile: f.stateFile });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/plugins", "DELETE /api/plugins/p1", "POST /api/plugins/install"]);
});

test("pluginVersion fails when manifest.js and package.json disagree", () => {
  const f = fixture("export const SCOPES = [];\n");
  writeFileSync(join(f.pluginDir, "manifest.js"), `export default { id: "aidenhq.events", version: "0.4.1" };\n`);
  assert.throws(() => pluginVersion(f.pluginDir), /keep them equal/);
});

test("pluginVersion reads manifest.js as text, never executing it on the host", () => {
  const f = fixture("export const SCOPES = [];\n");
  const marker = join(f.root, "executed");
  writeFileSync(join(f.pluginDir, "manifest.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default { id: "aidenhq.events", version: "0.4.0" };\n`);
  assert.equal(pluginVersion(f.pluginDir), "0.4.0");
  assert.equal(existsSync(marker), false, "a manifest import runs inside Paperclip, never as the host's deploy user");
});

test("ensureEventsPlugin drops the stamp before reinstalling, so an interrupted install is retried", async () => {
  const f = fixture("export const SCOPES = ['own'];\n");
  mkdirSync(join(f.root, "state"), { recursive: true });
  writeFileSync(f.stateFile, dirHash(f.pluginDir));
  writeFileSync(join(f.pluginDir, "post.js"), "export const SCOPES = ['own', 'evidence'];\n"); // no bump
  const stampAt = (method: string) => (method === "DELETE" ? (existsSync(f.stateFile) ? "kept" : "dropped") : "n/a");
  const seen: string[] = [];
  const api = async (method: string, path: string) => {
    seen.push(`${method} ${path} ${stampAt(method)}`);
    f.calls.push({ method, path });
    if (method === "GET") return { json: [{ id: "p1", pluginKey: "aidenhq.events", version: "0.4.0", status: "active" }] };
    if (method === "POST") throw new Error("install connection dropped");
    return { json: {} };
  };
  await assert.rejects(ensureEventsPlugin({ api: api as any, step: () => {}, pluginDir: f.pluginDir, stateFile: f.stateFile }), /connection dropped/);
  assert.deepEqual(seen, ["GET /api/plugins n/a", "DELETE /api/plugins/p1 dropped", "POST /api/plugins/install n/a"]);
  assert.equal(existsSync(f.stateFile), false, "no stamp is left for a generation the install did not confirm");
});

test("the repository's own plugin has equal manifest.js and package.json versions", async () => {
  const pluginDir = fileURLToPath(new URL("../../services/paperclip-events", import.meta.url));
  assert.match(await pluginVersion(pluginDir), /^\d+\.\d+\.\d+$/);
});
