#!/usr/bin/env node
// A git credential helper for the host's checkout of the instance repo (the one ops/apply-config.sh fetches): the owner's
// GitHub sign-in, read from the token file the GitHub module's process keeps (modules/github/token.json under the vault).
// It reads the file directly so it works before any container starts (the apply fetches first). Set per checkout, never
// globally (ops/apply-config-work.sh does it):
//   git config credential.useHttpPath true
//   git config credential.helper '!node ~/aidenhq/ops/git-credential-github.mjs'
// `get` answers only for https://github.com/$AIDENHQ_INSTANCE_REPO (the environment, else the product's .env); any other
// repo or host, or a missing token file, gets nothing.
// `check` (the apply, after the instance fetch failed): asks GitHub's API for the instance repo with the same token and, when
// the owner can fix the refusal (not connected, a stale sign-in, the org's SSO or its OAuth App access restrictions), prints
// the cause and its one fix and sends the owner that alert through the kernel (POST /v1/notify, the board's key; the same
// dedupe key as the github module's need). Exits 1 when it named a cause, 0 when GitHub lets the token read the repo.
// Self-contained (node built-ins only): the apply fetches with it before the official modules are put at ./modules.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "get" && mode !== "check") process.exit(0);
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
const instance = process.env.AIDENHQ_INSTANCE_REPO || (existsSync(envFile) ? /^\s*AIDENHQ_INSTANCE_REPO\s*=\s*["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["']?\s*$/m.exec(readFileSync(envFile, "utf8"))?.[1] : undefined);
const secrets = process.env.AIDENHQ_SECRETS_DIR ?? join(homedir(), ".config/aidenhq");
const file = join(secrets, "modules/github/token.json");
const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
const token = typeof saved?.access_token === "string" ? saved.access_token : "";

if (mode === "get") {
  const input = Object.fromEntries(
    readFileSync(0, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.path ?? "");
  if (input.protocol !== "https" || input.host !== "github.com" || !m || !instance || `${m[1]}/${m[2]}`.toLowerCase() !== instance.toLowerCase()) process.exit(0);
  if (token) process.stdout.write(`username=x-access-token\npassword=${token}\n`);
  process.exit(0);
}

if (!instance) process.exit(0);
const org = instance.split("/")[0];
const need = await (async () => {
  const connections = "connect GitHub on the board (Settings, Connections)";
  if (!token) return { key: "github:not_connected", text: `GitHub isn't connected, so the apply can't fetch ${instance}: ${connections}` };
  const api = process.env.AIDENHQ_GITHUB_API ?? "https://api.github.com";
  const res = await fetch(`${api}/repos/${instance}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "aidenhq" }, signal: AbortSignal.timeout(20_000) })
    .catch((e) => { console.error(`apply stopped: GitHub's API didn't answer (${String(e?.message ?? e).slice(0, 200)}).`); process.exit(1); });
  if (res.ok) return undefined;
  const message = String((await res.json().catch(() => ({})))?.message ?? "");
  const sso = /^required;.*\burl=(\S+)/i.exec(res.headers.get("x-github-sso") ?? "")?.[1];
  if (res.status === 401) return { key: "github:expired", text: `GitHub's sign-in stopped working, so the apply can't fetch ${instance}: re${connections}` };
  if (res.status === 403 && sso) return { key: `github:sso:${org}`, text: `The ${org} organization needs you to authorize single sign-on for AidenHQ before the apply can fetch ${instance}: ${sso}` };
  if (res.status === 403 && /OAuth App access restrictions/i.test(message)) {
    const url = `https://github.com/settings/connections/applications/${saved.client_id}`;
    return { key: `github:restricted:${org}`, text: `The ${org} organization restricts OAuth apps, so GitHub hides ${instance} from AidenHQ's sign-in and the apply can't fetch it: open ${url} and press Grant next to ${org} (an owner of ${org} grants at once; anyone else presses Request and an owner approves), then run the apply again` };
  }
  console.error(`apply stopped: GitHub answered ${res.status} for ${instance} with AidenHQ's GitHub sign-in${message ? ` (${message.slice(0, 200)})` : ""}.`);
  process.exit(1);
})();
if (!need) process.exit(0);
console.error(`apply stopped: ${need.text}.`);
const boardKey = join(secrets, "gateway_board_key");
try {
  const r = await fetch(`http://${process.env.AIDENHQ_KERNEL_BACKPLANE || "10.231.0.1:3130"}/v1/notify`, {
    method: "POST",
    headers: { authorization: `Bearer ${readFileSync(boardKey, "utf8").trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "alert", text: `The latest instance change wasn't applied. ${need.text}.`, dedupe_key: need.key }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`the kernel answered ${r.status}`);
  console.error("the owner was sent this as an alert");
} catch (e) {
  console.error(`(the owner alert wasn't sent: ${String(e?.message ?? e).slice(0, 200)})`);
}
process.exit(1);
