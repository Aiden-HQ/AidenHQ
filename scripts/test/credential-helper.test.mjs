// ops/git-credential-app.mjs answers with ./modules absent (the apply fetches the instance repo through it before the
// official modules are put at ./modules), for the instance repo alone and with exactly contents: read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));

test("the credential helper mints a contents-read token for the instance repo only, with no ./modules beside it", () => {
  const d = mkdtempSync(join(tmpdir(), "cred-"));
  mkdirSync(join(d, "ops"));
  copyFileSync(join(repo, "ops/git-credential-app.mjs"), join(d, "ops/git-credential-app.mjs"));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mkdirSync(join(d, "secrets/github-app"), { recursive: true });
  writeFileSync(join(d, "secrets/github-app/app_id"), "42\n");
  writeFileSync(join(d, "secrets/github-app/key.pem"), privateKey.export({ type: "pkcs1", format: "pem" }));
  // GitHub, stubbed in the helper's process: each call is logged with its JWT.
  writeFileSync(join(d, "fetch.mjs"), `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, o) => {
  appendFileSync(${JSON.stringify(join(d, "calls"))}, JSON.stringify({ url, method: o.method, auth: o.headers.authorization, body: o.body ?? null }) + "\\n");
  const json = url.endsWith("/installation") ? { id: 7 } : { token: "ghs_test" };
  return { ok: true, json: async () => json };
};`);
  const run = (input) => execFileSync("node", ["--import", join(d, "fetch.mjs"), join(d, "ops/git-credential-app.mjs"), "get"], { input, encoding: "utf8", env: { ...process.env, AIDENHQ_SECRETS_DIR: join(d, "secrets"), AIDENHQ_INSTANCE_REPO: "acme-agents/acme-instance" } });
  assert.equal(run("protocol=https\nhost=github.com\npath=acme-agents/acme-instance.git\n"), "username=x-access-token\npassword=ghs_test\n");
  const calls = execFileSync("cat", [join(d, "calls")], { encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET https://api.github.com/repos/acme-agents/acme-instance/installation", "POST https://api.github.com/app/installations/7/access_tokens"]);
  assert.deepEqual(JSON.parse(calls[1].body), { repositories: ["acme-instance"], permissions: { contents: "read" } });
  const [h, p, sig] = calls[0].auth.replace("Bearer ", "").split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url"), "the App JWT is signed with the App key");
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "42");
  // Another host, or another repo (even in the same org), gets no answer and mints nothing.
  assert.equal(run("protocol=https\nhost=example.com\npath=acme/x.git\n"), "");
  assert.equal(run("protocol=https\nhost=github.com\npath=acme-agents/app.git\n"), "");
  assert.equal(execFileSync("cat", [join(d, "calls")], { encoding: "utf8" }).trim().split("\n").length, 2);
});
