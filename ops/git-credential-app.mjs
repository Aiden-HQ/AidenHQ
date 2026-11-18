#!/usr/bin/env node
// A git credential helper for the host's checkout of the instance repo (the one ops/apply-config.sh pulls): a token for that
// one repo with exactly {contents: read}, minted from the vault's App key. Among services and modules only codehost-github
// holds the App key; the host's apply may mint this read-only instance-repo token, nothing else (instance pushes are
// codehost writes). Set per checkout, never globally:  git config credential.useHttpPath true
//   git config credential.helper '!node ~/aidenhq/ops/git-credential-app.mjs'
// Answers only `get` for https://github.com/$AIDENHQ_INSTANCE_REPO (the environment, else the product's .env); any other
// repo or host gets nothing.
// Self-contained (node built-ins only): the apply fetches with it before the official modules are put at ./modules.
import { createSign } from "node:crypto";
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
const dir = join(process.env.AIDENHQ_SECRETS_DIR ?? join(homedir(), ".config/aidenhq"), "github-app");
const appId = readFileSync(join(dir, "app_id"), "utf8").trim();
const key = readFileSync(join(dir, "key.pem"), "utf8");
// An RS256 App JWT (issued 60s back for clock drift, valid 9 minutes), then the org's installation and a token for the one repo.
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const iat = Math.floor(Date.now() / 1000) - 60;
const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 600, iss: appId })}`;
const jwt = `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
const api = async (method, path, payload) => {
  const r = await fetch(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) process.exit(0); // not installed there, or GitHub refused: no answer, git falls back
  return r.json();
};
const { id } = await api("GET", `/repos/${m[1]}/${m[2]}/installation`);
const { token } = await api("POST", `/app/installations/${id}/access_tokens`, { repositories: [m[2]], permissions: { contents: "read" } });
process.stdout.write(`username=x-access-token\npassword=${token}\n`);
