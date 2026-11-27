#!/usr/bin/env node
// A git credential helper for the host's checkout of the instance repo (the one ops/apply-config.sh fetches and the updater and
// setup push to), by the one rule (docs/design/github-identity.md): the instance's GitHub App where it is installed on the
// instance repo and its installation has accepted the `push` op's permissions (contents and workflows write; git's `get` can't
// tell a fetch from a push, so it always asks for those), a fresh installation token; else the owner's GitHub sign-in, read from
// the token file the GitHub module's process keeps (modules/github/token.json under the vault). A broken App (its saved files,
// GitHub refusing it) answers nothing and says why: never the owner instead. It reads the vault directly so it works before any
// container starts (the apply fetches first). Set per checkout, never globally (ops/apply-config-work.sh does it):
//   git config credential.useHttpPath true
//   git config credential.helper '!node ~/aidenhq/ops/git-credential-github.mjs'
// `get` answers only for https://github.com/$AIDENHQ_INSTANCE_REPO (the environment, else the product's .env); any other
// repo or host, or a missing token file, gets nothing.
// `check` (the apply, after the instance fetch failed): asks GitHub's API for the instance repo with the same token and, when
// the owner can fix the refusal (not connected, a stale sign-in, the org's SSO or its OAuth App access restrictions), prints
// the cause and its one fix and sends the owner that alert through the kernel (POST /v1/notify, the board's key; the same
// dedupe key as the github module's need). Exits 1 when it named a cause, 0 when GitHub lets the token read the repo.
// Self-contained (node built-ins only): the apply fetches with it before the official modules are put at ./modules.
import { createSign } from "node:crypto";
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

const api = process.env.AIDENHQ_GITHUB_API ?? "https://api.github.com";
/** The App's installation token for the instance repo where the rule picks the App; undefined: the owner's. Throws when the App is broken. */
async function appToken(repo) {
  const dir = join(secrets, "modules/github/github-app");
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : undefined);
  const id = read("app_id"), key = read("key.pem");
  if (id === undefined && key === undefined) return undefined;
  if (!/^[0-9]{1,12}$/.test(id ?? "") || !key?.includes("PRIVATE KEY")) throw new Error("the GitHub App's saved id or key is missing or unreadable");
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000) - 60;
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 540, iss: id })}`;
  const jwt = `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
  const call = async (method, path) => {
    const r = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "aidenhq" }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const inst = await call("GET", `/repos/${repo}/installation`);
  if (inst.status === 404) return undefined;
  if (inst.status !== 200 || !Number.isInteger(inst.body?.id)) throw new Error(`GitHub answered ${inst.status} looking up the App's installation on ${repo}`);
  const p = inst.body.permissions ?? {};
  if (!["contents", "workflows"].every((k) => p[k] === "write" || p[k] === "admin")) return undefined;
  const t = await call("POST", `/app/installations/${inst.body.id}/access_tokens`);
  if (t.status !== 201 || typeof t.body?.token !== "string") throw new Error(`GitHub answered ${t.status} for the App's installation token`);
  return t.body.token;
}

if (mode === "get") {
  const input = Object.fromEntries(
    readFileSync(0, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input.path ?? "");
  if (input.protocol !== "https" || input.host !== "github.com" || !m || !instance || `${m[1]}/${m[2]}`.toLowerCase() !== instance.toLowerCase()) process.exit(0);
  const app = await appToken(`${m[1]}/${m[2]}`).catch((e) => { console.error(`AidenHQ's GitHub App isn't working, so git gets no credential: ${String(e?.message ?? e).slice(0, 200)}`); process.exit(1); });
  const answer = app ?? token;
  if (answer) process.stdout.write(`username=x-access-token\npassword=${answer}\n`);
  process.exit(0);
}

if (!instance) process.exit(0);
const org = instance.split("/")[0];
const need = await (async () => {
  const connections = "connect GitHub on the board (Settings, Connections)";
  if (!token) return { key: "github:not_connected", text: `GitHub isn't connected, so the apply can't fetch ${instance}: ${connections}` };
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
