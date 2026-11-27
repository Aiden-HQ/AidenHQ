// AidenHQ's GitHub App: the manifest asks for the fleet's writes and reads (never administration or runners), and the App goes into the github module's own
// vault dir, 0600, from GitHub's answer alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, manifest, saveApp } from "../src/github-app.ts";

test("the manifest is public and asks for the fleet's writes and reads, never administration or runners", () => {
  const m = manifest("AidenHQ review", "https://k.example/setup/github-app/s");
  assert.equal(m.public, true);
  assert.deepEqual(m.default_permissions, { contents: "write", workflows: "write", pull_requests: "write", issues: "write", statuses: "write", actions: "write", checks: "read", metadata: "read", organization_projects: "write" });
});

test("GitHub's answer becomes the vault's github-app/{app_id,key.pem}, 0600", async () => {
  const pem = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----\nx\n"].join(" ");
  const app = await convert("c0de", (async () => new Response(JSON.stringify({ id: 7, slug: "aidenhq-review", pem, owner: { login: "acme" } }), { status: 201 })) as typeof fetch);
  const dir = mkdtempSync(join(tmpdir(), "gh-app-"));
  saveApp(app, dir);
  assert.equal(statSync(join(dir, "github-app", "key.pem")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "github-app", "app_id"), "utf8"), "7\n");
  assert.equal(existsSync(join(dir, "github-app", "slug")), false, "who the App is is read from GitHub, never stored");
  await assert.rejects(convert("c0de", (async () => new Response(JSON.stringify({ message: "expired" }), { status: 404 })) as typeof fetch), /404 expired/);
});
