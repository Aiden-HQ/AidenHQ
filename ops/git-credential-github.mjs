#!/usr/bin/env node
// A git credential helper for the host's checkout of the instance repo (the one ops/apply-config.sh fetches): the owner's
// GitHub sign-in, read from the token file the GitHub module's process keeps (modules/github/token.json under the vault).
// It reads the file directly so it works before any container starts (the apply fetches first). Set per checkout, never
// globally (ops/apply-config-work.sh does it):
//   git config credential.useHttpPath true
//   git config credential.helper '!node ~/aidenhq/ops/git-credential-github.mjs'
// Answers only `get` for https://github.com/$AIDENHQ_INSTANCE_REPO (the environment, else the product's .env); any other
// repo or host, or a missing token file, gets nothing.
// Self-contained (node built-ins only): the apply fetches with it before the official modules are put at ./modules.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] !== "get") process.exit(0);
const input = Object.fromEntries(
  readFileSync(0, "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.path ?? "");
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
const instance = process.env.AIDENHQ_INSTANCE_REPO || (existsSync(envFile) ? /^\s*AIDENHQ_INSTANCE_REPO\s*=\s*["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']?\s*$/m.exec(readFileSync(envFile, "utf8"))?.[1] : undefined);
if (input.protocol !== "https" || input.host !== "github.com" || !m || !instance || `${m[1]}/${m[2]}`.toLowerCase() !== instance.toLowerCase()) process.exit(0);
const file = join(process.env.AIDENHQ_SECRETS_DIR ?? join(homedir(), ".config/aidenhq"), "modules/github/token.json");
if (!existsSync(file)) process.exit(0);
const token = JSON.parse(readFileSync(file, "utf8")).access_token;
if (typeof token === "string" && token) process.stdout.write(`username=x-access-token\npassword=${token}\n`);
