#!/usr/bin/env node
// Compile modules + the instance (AIDENHQ_INSTANCE_DIR) into the generated files the stack reads:
//   config/paperclip.yaml      → scripts/paperclip-setup.mjs
//   config/apps.modules.yaml   → apps-mcp (module apps, read-only; agent-created apps live in the instance's apps.yaml)
//   compose.modules.yaml       → docker compose (COMPOSE_FILE in .env)
//   config/modules.json        → the module catalog (setup adds it to the capabilities catalog)
//   config/computers.json      → the computer launcher (images by content hash, connections it may proxy; services/computer)
//   config/gateway.json        → the model gateway (kernel/src/gateway): enforce_caps, from settings.spend_caps (the kill switch)
//   config/engines.json        → the runner: each engine kind's module, bin and data (modules' providers.engine)
//   config/jobcaps.json        → the kernel (job tokens on /c/<connection>/mcp) and the runner: what jobs may read (modules' jobcaps:)
//   config/kernel/connections.json → the kernel's tool proxy: each connection's endpoint, service key secret, module and tool tags
//   config/gate.json, config/cloudflared.yml → the gate and the tunnel (shared access; only with settings.edge, scripts/edge.mjs)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, ensureOptionalSecrets, hostMounts } from "./modules.mjs";
import { computersConfig } from "./computers.mjs";
import { checkIngress } from "./edge.mjs";
import { ensureIdentityKeys } from "./identity.mjs";
import { checkOn, report, staticCheck } from "./agent-check.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = {};
if (existsSync(join(repo, ".env"))) {
  for (const line of readFileSync(join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k) => process.env[k] ?? dotenv[k];
const die = (msg) => { console.error(`compile: ${msg}`); process.exit(1); };

const instanceDir = env("AIDENHQ_INSTANCE_DIR");
if (!instanceDir || !existsSync(join(instanceDir, "instance.yaml"))) die("set AIDENHQ_INSTANCE_DIR to your instance checkout (see docs/USAGE.md)");
let revision;
try { revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}

let out, computers;
try { out = compile(repo, instanceDir, { revision }); computers = computersConfig(out.paperclip, repo); } catch (e) { die(e.message); }
// The pre-launch agent check (scripts/agent-check.mjs): before anything is written, so a failing agent never launches.
if (checkOn(instanceDir) && report("agent-check", staticCheck(out.paperclip))) die("the agent check failed (above); fix the agent, or set settings.agent_check: off");

// Host paths come from the host's .env, never from instance.yaml (agents can edit that through apply): ops-mcp's config,
// transcripts, vault folders and knowledge bases. A module can't declare a host mount; these are the host's own.
const ops = out.compose.services["meetings-ops-mcp"];
if (ops) {
  const own = ["${AIDENHQ_CONFIG_DIR:-./config}/system.yaml:/config/system.yaml:ro", "${TRANSCRIPTS_DIR:?set TRANSCRIPTS_DIR in .env}:/sources/transcripts"];
  try { ops.volumes = [...(ops.volumes ?? []), ...own, ...hostMounts({ VAULT_DIR: env("VAULT_DIR"), VAULT_FOLDERS: env("VAULT_FOLDERS"), KNOWLEDGE_BASES: env("KNOWLEDGE_BASES") })]; } catch (e) { die(e.message); }
}

// Secrets of channels the owner may not use start as empty files, so compose can start (empty = not configured).
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (secretsDir) ensureOptionalSecrets(secretsDir, out.optionalSecrets, "paperclip_auth_secret");
if (secretsDir) for (const n of ensureOptionalSecrets(secretsDir, out.generatedSecrets, "paperclip_auth_secret", true)) console.log(`  created secret ${n}`);
// App identity keys (docs/design/app-identity.md): the gate's and apps-mcp's signing keys and the public keys.json every app
// mounts. Before compose: a missing bind source would become a directory.
if (secretsDir) for (const n of ensureIdentityKeys(secretsDir)) console.log(`  created key ${n}`);

// The grants table's directory exists before compose mounts it (Docker would create a root-owned one setup can't write).
mkdirSync(join(resolve(repo, env("AIDENHQ_CONFIG_DIR") ?? "config"), "grants"), { recursive: true });
// Likewise the apps node's state and serve config (compose.yaml apps-edge; apps-mcp writes the serve config). Here, not in
// apply-config.sh: the apply that brings this in still runs the old script, which then runs this compile.
const dataDir = resolve(repo, env("AIDENHQ_DATA_DIR") ?? "data");
for (const d of ["apps-edge/state", "apps-edge/serve", "previews", ...out.dataDirs]) mkdirSync(join(dataDir, d), { recursive: true });
// The security scanner's copy of the app registry (its data dir, read-only there): no module mounts the instance checkout.
if (out.compose.services["security-scanner"]) writeFileSync(join(dataDir, "modules/security/registry/apps.yaml"), existsSync(join(instanceDir, "apps.yaml")) ? readFileSync(join(instanceDir, "apps.yaml")) : "apps: []\n");

const header ="# Generated by scripts/compile.mjs from modules/ and the instance. Do not edit; edit the module or instance.yaml.\n";
const dump = (v) => header + YAML.stringify(v, { lineWidth: 0 });
writeFileSync(join(repo, "config/paperclip.yaml"), dump(out.paperclip));
writeFileSync(join(repo, "config/apps.modules.yaml"), dump(out.apps));
const compose = Object.fromEntries(Object.entries(out.compose).filter(([k, v]) => k === "services" || Object.keys(v).length));
writeFileSync(join(repo, "compose.modules.yaml"), dump(compose));
writeFileSync(join(repo, "config/modules.json"), JSON.stringify(out.catalog, null, 2) + "\n");
writeFileSync(join(repo, "config/computers.json"), JSON.stringify(computers, null, 2) + "\n");
writeFileSync(join(repo, "config/gateway.json"), JSON.stringify(out.gateway, null, 2) + "\n");
writeFileSync(join(repo, "config/jobcaps.json"), JSON.stringify(out.jobcaps, null, 2) + "\n");
mkdirSync(join(repo, "config/kernel"), { recursive: true });
writeFileSync(join(repo, "config/kernel/connections.json"), JSON.stringify(out.connections, null, 2) + "\n");
writeFileSync(join(repo, "config/engines.json"), JSON.stringify(out.engines, null, 2) + "\n");
if (out.edge) {
  if (out.edge.cloudflared) try { checkIngress(out.edge.cloudflared, { login: out.edge.gate.login }); } catch (e) { die(e.message); }
  // The board's account map for the gate: the board rewrites it on every account change. It starts
  // empty so compose can bind it (a missing bind source becomes a directory); the gate refuses everyone it can't read.
  const accounts = join(resolve(repo, env("AIDENHQ_DATA_DIR") ?? "./data"), "gate", "accounts.json");
  if (existsSync(accounts) && !statSync(accounts).isFile()) die(`${accounts} is not a file (remove it and apply again)`);
  if (!existsSync(accounts)) {
    mkdirSync(dirname(accounts), { recursive: true, mode: 0o755 });
    writeFileSync(accounts, JSON.stringify({ accounts: [] }) + "\n", { mode: 0o644 });
  }
  // The gate's signing key is made with the other identity keys above, before compose binds it.
  if (!secretsDir) die("AIDENHQ_SECRETS_DIR is needed with settings.edge (the tunnel credentials and the gate's signing key)");
  const creds = join(secretsDir, "cloudflared_credentials.json");
  if (out.edge.cloudflared && (!existsSync(creds) || !statSync(creds).isFile() || !statSync(creds).size)) die(`settings.edge is set, but ${creds} is missing or empty: put the tunnel's credentials file there (docs/setup.md, Shared access)`);
  writeFileSync(join(repo, "config/gate.json"), JSON.stringify(out.edge.gate, null, 2) + "\n");
  if (out.edge.cloudflared) writeFileSync(join(repo, "config/cloudflared.yml"), dump(out.edge.cloudflared));
  else rmSync(join(repo, "config/cloudflared.yml"), { force: true }); // header-jwt: a front door, no tunnel
} else for (const f of ["config/gate.json", "config/cloudflared.yml"]) rmSync(join(repo, f), { force: true });
for (const w of out.warnings) console.log(`  warning: ${w}`);
const on = out.catalog.filter((m) => m.enabled).map((m) => m.name);
console.log(`compiled ${on.length} modules (${on.join(", ")}): ${Object.keys(out.paperclip.agents).length} agents, ${Object.keys(out.paperclip.routines).length} routines, ${out.apps.apps.length} apps, ${Object.keys(out.compose.services).length} compose services`);
