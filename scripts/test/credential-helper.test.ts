// ops/git-credential-github.mjs answers with ./modules absent (the apply fetches the instance repo through it before the
// official modules are put at ./modules), for the instance repo alone, with the owner's token from the github module's file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

test("credential-helper check names an org's OAuth App restriction, its grant link, and alerts the owner", async () => {
  const d = mkdtempSync(join(tmpdir(), "cred-"));
  const secrets = join(d, "secrets");
  mkdirSync(join(secrets, "modules/github"), { recursive: true });
  writeFileSync(join(secrets, "modules/github/token.json"), JSON.stringify({ access_token: "gho_x", client_id: "Ov23test" }));
  writeFileSync(join(secrets, "gateway_board_key"), "boardkey\n");
  const notices: { auth?: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      if (req.url === "/v1/notify") { notices.push({ auth: req.headers.authorization, body: JSON.parse(body) }); return void res.end("{}"); }
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited." }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const at = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const out = await new Promise<{ code: number | null; stderr: string }>((r) => {
    const c = execFile("node", [join(repo, "ops/git-credential-github.mjs"), "check"], { env: { ...process.env, AIDENHQ_SECRETS_DIR: secrets, AIDENHQ_INSTANCE_REPO: "acme/inst", AIDENHQ_GITHUB_API: `http://${at}`, AIDENHQ_KERNEL_BACKPLANE: at } }, (_e, _o, stderr) => r({ code: c.exitCode, stderr }));
  });
  server.close();
  assert.equal(out.code, 1);
  assert.match(out.stderr, /apply stopped: The acme organization restricts OAuth apps.*https:\/\/github\.com\/settings\/connections\/applications\/Ov23test and press Grant next to acme/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.auth, "Bearer boardkey");
  assert.equal(notices[0]!.body.dedupe_key, "github:restricted:acme");
  assert.ok(!out.stderr.includes("gho_x"));
});
