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
