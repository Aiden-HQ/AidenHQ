// ops/git-credential-github.mjs answers with ./modules absent (the apply fetches the instance repo through it before the
// official modules are put at ./modules), for the instance repo alone, with the owner's token from the github module's file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));

test("credential-helper answers only the instance repo", () => {
  const d = mkdtempSync(join(tmpdir(), "cred-"));
  mkdirSync(join(d, "ops"));
  copyFileSync(join(repo, "ops/git-credential-github.mjs"), join(d, "ops/git-credential-github.mjs"));
  const secrets = join(d, "secrets");
  const run = (input: string) => execFileSync("node", [join(d, "ops/git-credential-github.mjs"), "get"], { input, encoding: "utf8", env: { ...process.env, AIDENHQ_SECRETS_DIR: secrets, AIDENHQ_INSTANCE_REPO: "acme/inst" } });
  // No token file yet (never connected): no answer.
  assert.equal(run("protocol=https\nhost=github.com\npath=acme/inst.git\n"), "");
  mkdirSync(join(secrets, "modules/github"), { recursive: true });
  writeFileSync(join(secrets, "modules/github/token.json"), JSON.stringify({ access_token: "gho_x" }));
  assert.equal(run("protocol=https\nhost=github.com\npath=acme/inst.git\n"), "username=x-access-token\npassword=gho_x\n");
  // Another repo (even in the same org) or another host gets nothing.
  assert.equal(run("protocol=https\nhost=github.com\npath=acme/other.git\n"), "");
  assert.equal(run("protocol=https\nhost=example.com\npath=acme/inst.git\n"), "");
});

test("credential-helper answers with the App's installation token where the App is installed with the push permissions, else the owner's; a broken App answers nothing", async () => {
  const { createServer } = await import("node:http");
  const { generateKeyPairSync } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const d = mkdtempSync(join(tmpdir(), "cred-app-"));
  mkdirSync(join(d, "ops"));
  copyFileSync(join(repo, "ops/git-credential-github.mjs"), join(d, "ops/git-credential-github.mjs"));
  const secrets = join(d, "secrets");
  mkdirSync(join(secrets, "modules/github/github-app"), { recursive: true });
  writeFileSync(join(secrets, "modules/github/token.json"), JSON.stringify({ access_token: "gho_x" }));
  writeFileSync(join(secrets, "modules/github/github-app/app_id"), "42\n");
  writeFileSync(join(secrets, "modules/github/github-app/key.pem"), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
  let installation: { status: number; body: unknown } = { status: 200, body: { id: 7, permissions: { contents: "write", workflows: "write", metadata: "read" } } };
  const server = createServer((req, res) => {
    if (req.url === "/repos/acme/inst/installation") return void res.writeHead(installation.status).end(JSON.stringify(installation.body));
    if (req.method === "POST" && req.url === "/app/installations/7/access_tokens") return void res.writeHead(201).end(JSON.stringify({ token: "ghs_app" }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const run = (input: string) => new Promise<{ code: number; out: string }>((ok) => {
    const c = execFile("node", [join(d, "ops/git-credential-github.mjs"), "get"], { encoding: "utf8", env: { ...process.env, AIDENHQ_SECRETS_DIR: secrets, AIDENHQ_INSTANCE_REPO: "acme/inst", AIDENHQ_GITHUB_API: `http://127.0.0.1:${port}` } }, (e, out) => ok({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out }));
    c.stdin!.end(input);
  });
  const ask = "protocol=https\nhost=github.com\npath=acme/inst.git\n";
  try {
    assert.deepEqual(await run(ask), { code: 0, out: "username=x-access-token\npassword=ghs_app\n" });
    installation = { status: 200, body: { id: 7, permissions: { contents: "write" } } }; // workflows not accepted yet
    assert.deepEqual(await run(ask), { code: 0, out: "username=x-access-token\npassword=gho_x\n" });
    installation = { status: 404, body: {} }; // not installed there
    assert.deepEqual(await run(ask), { code: 0, out: "username=x-access-token\npassword=gho_x\n" });
    installation = { status: 500, body: {} }; // broken: never the owner instead
    assert.deepEqual(await run(ask), { code: 1, out: "" });
  } finally { server.close(); }
});
