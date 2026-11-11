#!/usr/bin/env node
// A git credential helper for the host's own checkouts of repos in the agents org (e.g. the instance repo that
// ops/apply-config.sh pulls): a read-only GitHub App token for that one repo, minted from the vault's App key.
// Set per checkout, never globally:  git config credential.useHttpPath true
//   git config credential.helper '!node ~/aidenhq/ops/git-credential-app.mjs'
// Answers only `get` for https://github.com/<org>/<repo>; anything else gets nothing (git falls back or fails).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appClient } from "../services/runner/src/github-app.mjs";

if (process.argv[2] !== "get") process.exit(0);
const input = Object.fromEntries(
  readFileSync(0, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.path ?? "");
if (input.protocol !== "https" || input.host !== "github.com" || !m) process.exit(0);
const dir = join(process.env.AIDENHQ_SECRETS_DIR ?? join(homedir(), ".config/aidenhq"), "github-app");
const app = appClient({ appId: readFileSync(join(dir, "app_id"), "utf8").trim(), key: readFileSync(join(dir, "key.pem"), "utf8") });
const token = await app.token(m[1], { repositories: [m[2]], permissions: { contents: "read" } });
process.stdout.write(`username=x-access-token\npassword=${token}\n`);
