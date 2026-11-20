// The GitHub App's save: the key into the vault (0600), the agents org into the host's .env once; only an App the named org owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, saveApp } from "../src/github-app.ts";

test("the App goes into the vault and the agents org into .env, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-app-")), envFile = join(dir, ".env");
  writeFileSync(envFile, "AIDENHQ_DIR=/x");
  saveApp({ id: 7, slug: "aidenhq-acme", pem: "test PRIVATE KEY placeholder\n", owner: "acme-agents" }, { secretsDir: dir, envFile });
  assert.equal(statSync(join(dir, "github-app", "key.pem")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, "github-app", "app_id"), "utf8"), "7\n");
  saveApp({ id: 8, slug: "aidenhq-acme-2", pem: "test PRIVATE KEY placeholder\n", owner: "other-org" }, { secretsDir: dir, envFile });
  assert.equal(readFileSync(envFile, "utf8"), "AIDENHQ_DIR=/x\nAIDENHQ_GITHUB_AGENTS_ORG=acme-agents\n");
});

test("an App another org owns is refused", async () => {
  const fake = async () => new Response(JSON.stringify({ id: 1, slug: "x", pem: "test PRIVATE KEY placeholder", owner: { login: "mallory" } }), { status: 201 });
  await assert.rejects(convert("c0de", "acme-agents", fake), /owned by mallory/);
  const ok = await convert("c0de", "Acme-Agents", async () => new Response(JSON.stringify({ id: 1, slug: "x", pem: "test PRIVATE KEY placeholder", owner: { login: "acme-agents" } }), { status: 201 }));
  assert.equal(ok.id, 1);
});
