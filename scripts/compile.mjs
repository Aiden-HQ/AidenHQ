#!/usr/bin/env node
// Compile modules + the instance (AIDENHQ_INSTANCE_DIR) into the generated files the stack reads:
//   config/paperclip.yaml      → scripts/paperclip-setup.mjs
//   config/apps.modules.yaml   → apps-mcp (module apps, read-only; agent-created apps live in the instance's apps.yaml)
//   compose.modules.yaml       → docker compose (COMPOSE_FILE in .env)
//   config/modules.json        → the module catalog (setup adds it to the capabilities catalog)
//   config/computers.json      → the computer launcher (images by content hash, connections it may proxy; services/computer)
//   config/gateway.json        → the model gateway (kernel/src/gateway): model prices (modules' models:) and CI review
//   config/engines.json        → the runner: each engine kind's module, bin and data (modules' providers.engine)
//   config/jobcaps.json        → the kernel (job tokens on /c/<connection>/mcp) and the runner: what jobs may read (modules' jobcaps:)
//   config/kernel/connections.json → the kernel's tool proxy: each connection's endpoint, service key secret, module and tool tags
//   config/kernel/writes.json  → the kernel's write kinds (modules' `writes:`): floor, card, args schema, executor, routed tools
//   config/kernel/checks.json  → the kernel's finish gate: modules' task.finish checks (url, key secret, label, scope)
//   config/kernel/modules.json → the kernel: modules' kernel roles, privileged entries, own tokens and channels (stamp, settings),
//                                each enabled module's compose services and its setup secrets
//   config/exposure           → ops/vm/setup.sh (root) and verify-security: settings.exposure, one word
//   config/Caddyfile           → the `caddy` service, the public front door (only with exposure public, scripts/front-door.mjs)
//   config/module-data.json    → the apply (ops/lib/generations.sh): each data module's data_version and services digest
//   config/points/<module>.json → that module's own services only: the contributions to its points (spec §3.6)
//   config/gate.json, config/cloudflared.yml → the gate and the tunnel (shared access; only with settings.edge, scripts/edge.mjs)
// `--sizes`: compile, print each crew agent's handbook bytes per section (scripts/handbook.mjs) and write nothing.
// Staging (`--stage`, or AIDENHQ_COMPILE_STAGE=1; ops/apply-config-work.sh validates a generation with it before anything
// restarts): the same files go to config.next/ and compose.modules.next.yaml, and nothing else on the host is touched (no
// secrets, keys, data dirs or account files are created). The apply then compiles for real and checks the two agree.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, composeSecretFiles, ensureMountedSecrets, ensureOptionalSecrets, hostMounts } from "./modules.mjs";
import { computersConfig } from "./computers.mjs";
import { checkIngress } from "./edge.mjs";
import { caddyfile, caddyService, publicUrls } from "./front-door.mjs";
import { ensureIdentityKeys } from "./identity.mjs";
import { report, staticCheck } from "./agent-check.mjs";
import { sizesReport } from "./handbook.mjs";
import { checkDataVersion } from "../kernel/src/loader/data-version.ts";
import { hostFetch } from "../kernel/src/loader/sources.ts";
import { readRelease } from "../kernel/src/loader/release.ts";
import { computerPulls, useReleaseImages } from "./release-images.mjs";

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
const stage = process.argv.includes("--stage") || process.env.AIDENHQ_COMPILE_STAGE === "1";
const cfgOut = join(repo, stage ? "config.next" : "config");
const composeOut = join(repo, stage ? "compose.modules.next.yaml" : "compose.modules.yaml");
if (stage) { rmSync(cfgOut, { recursive: true, force: true }); mkdirSync(cfgOut, { recursive: true }); }

const instanceDir = env("AIDENHQ_INSTANCE_DIR");
if (!instanceDir || !existsSync(join(instanceDir, "instance.yaml"))) die("set AIDENHQ_INSTANCE_DIR to your instance checkout (see docs/USAGE.md)");
let revision;
try { revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}

let out, computers;
try { out = compile(repo, instanceDir, { revision }); computers = computersConfig(out.paperclip, repo); } catch (e) { die(e.message); }
if (process.argv.includes("--sizes")) {
  try { console.log(sizesReport(out.paperclip, { repo, instanceDir, engines: out.engines })); } catch (e) { die(e.message); }
  process.exit(0);
}
// The pre-launch agent check (scripts/agent-check.mjs): before anything is written, so a failing agent never launches.
if (report("agent-check", staticCheck(out.paperclip))) die("the agent check failed (above); fix the agent");

// Host paths come from the host's .env, never from instance.yaml (agents can edit that through apply): ops-mcp's config,
// transcripts, vault folders and knowledge bases. A module can't declare a host mount; these are the host's own.
const ops = out.compose.services["meetings-ops-mcp"];
if (ops) {
  const own = ["${AIDENHQ_CONFIG_DIR:-./config}/system.yaml:/config/system.yaml:ro", "${TRANSCRIPTS_DIR:?set TRANSCRIPTS_DIR in .env}:/sources/transcripts"];
  try { ops.volumes = [...(ops.volumes ?? []), ...own, ...hostMounts({ VAULT_DIR: env("VAULT_DIR"), VAULT_FOLDERS: env("VAULT_FOLDERS"), KNOWLEDGE_BASES: env("KNOWLEDGE_BASES") })]; } catch (e) { die(e.message); }
}

// Secrets of channels the owner may not use start as empty files, so compose can start (empty = not configured).
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (secretsDir && !stage) ensureOptionalSecrets(secretsDir, out.optionalSecrets, "paperclip_auth_secret");
if (secretsDir && !stage) for (const n of ensureOptionalSecrets(secretsDir, out.generatedSecrets, "paperclip_auth_secret", true)) console.log(`  created secret ${n}`);
// App identity keys (docs/design/app-identity.md): the gate's and apps-mcp's signing keys and the public keys.json every app
// mounts. Before compose: a missing bind source would become a directory.
if (secretsDir && !stage) for (const n of ensureIdentityKeys(secretsDir)) console.log(`  created key ${n}`);
// Last: every other secret file a service mounts must exist before compose. The optional and owner-provided ones start empty
// (not set up yet: the model key before the first-run page); a missing auth or signing secret stops here, never empty.
if (secretsDir && !stage) {
  const mounts = composeSecretFiles(YAML.parse(readFileSync(join(repo, "compose.yaml"), "utf8")), out.compose);
  const { missing } = ensureMountedSecrets(secretsDir, mounts, [...out.optionalSecrets, ...out.askedSecrets], "paperclip_auth_secret");
  if (missing.length) die(`missing secret files in ${secretsDir}: ${missing.map((m) => `${m.secret} (mounted by ${m.services.join(", ")})`).join("; ")}. Run scripts/bootstrap.sh, or put the secret there.`);
}

// The grants table's directory exists before compose mounts it (Docker would create a root-owned one setup can't write).
if (!stage) mkdirSync(join(resolve(repo, env("AIDENHQ_CONFIG_DIR") ?? "config"), "grants"), { recursive: true });
// Likewise the apps node's state and serve config (compose.yaml apps-edge; apps-mcp writes the serve config), and the
// on-server code host's repos (apps-mcp mounts them read-only; the runner, as the host user, creates repos in them). Here,
// not in apply-config.sh: the apply that brings this in still runs the old script, which then runs this compile.
const dataDir = resolve(repo, env("AIDENHQ_DATA_DIR") ?? "data");
if (!stage) for (const d of ["apps-edge/state", "apps-edge/serve", "previews", "codehost", ...out.dataDirs]) mkdirSync(join(dataDir, d), { recursive: true });
// Code never starts on data newer than it (spec §6.4.1): staged, only checked (the apply snapshots the data after this); for
// real, each data module's marker is set to its data_version before compose starts it.
try { for (const [m, d] of Object.entries(out.dataModules)) checkDataVersion(m, d.data_version, join(dataDir, "modules", m), !stage); } catch (e) { die(e.message); }
// The security scanner's copy of the app registry (its data dir, read-only there): no module mounts the instance checkout.
if (!stage && out.compose.services["security-scanner"]) writeFileSync(join(dataDir, "modules/security/registry/apps.yaml"), existsSync(join(instanceDir, "apps.yaml")) ? readFileSync(join(instanceDir, "apps.yaml")) : "apps: []\n");

// The public front door (exposure public): Caddy for the host's public IPv4, from .env (ops/setup.sh writes it with the board's
// and the admin listener's URLs, which the kernel reads there too). Its service is named exactly `caddy`: ops/vm/setup.sh
// opens 443 and 8446 only once compose.modules.yaml has it.
let caddy;
if (out.exposure === "public") {
  const ip = env("AIDENHQ_PUBLIC_IP"), urls = publicUrls(ip);
  try { caddy = caddyfile(ip); } catch (e) { die(`exposure public: AIDENHQ_PUBLIC_IP in .env: ${e.message} (sudo ops/setup.sh sets it)`); }
  if (env("BOARD_LAN_URL") !== urls.board || env("AIDENHQ_ADMIN_URL") !== urls.admin) die(`exposure public: .env needs BOARD_LAN_URL=${urls.board} and AIDENHQ_ADMIN_URL=${urls.admin} (sudo ops/setup.sh sets them)`);
  out.compose.services.caddy = caddyService(caddy);
  if (!stage) mkdirSync(join(dataDir, "caddy"), { recursive: true, mode: 0o700 });
}

const header ="# Generated by scripts/compile.mjs from modules/ and the instance. Do not edit; edit the module or instance.yaml.\n";
const dump = (v) => header + YAML.stringify(v, { lineWidth: 0 });
writeFileSync(join(cfgOut, "paperclip.yaml"), dump(out.paperclip));
writeFileSync(join(cfgOut, "apps.modules.yaml"), dump(out.apps));
// A pinned release's prebuilt images (scripts/release-images.mjs): its digests run instead of local builds.
let images = {};
try { images = readRelease(YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8")) ?? {}, hostFetch(repo))?.images ?? {}; } catch (e) { die(e.message); }
if (Object.keys(images).length) {
  out.compose = useReleaseImages(out.compose, YAML.parse(readFileSync(join(repo, "compose.yaml"), "utf8")), images);
  computers.pull = computerPulls(computers.images, images);
}
const compose = Object.fromEntries(Object.entries(out.compose).filter(([k, v]) => k === "services" || Object.keys(v).length));
writeFileSync(composeOut, dump(compose));
writeFileSync(join(cfgOut, "modules.json"), JSON.stringify(out.catalog, null, 2) + "\n");
writeFileSync(join(cfgOut, "computers.json"), JSON.stringify(computers, null, 2) + "\n");
writeFileSync(join(cfgOut, "gateway.json"), JSON.stringify(out.gateway, null, 2) + "\n");
writeFileSync(join(cfgOut, "jobcaps.json"), JSON.stringify(out.jobcaps, null, 2) + "\n");
mkdirSync(join(cfgOut, "kernel"), { recursive: true });
writeFileSync(join(cfgOut, "kernel/connections.json"), JSON.stringify(out.connections, null, 2) + "\n");
writeFileSync(join(cfgOut, "kernel/writes.json"), JSON.stringify(out.writes, null, 2) + "\n");
// Always written ({} when no module checks): the kernel's finish gate refuses every close when it is missing.
writeFileSync(join(cfgOut, "kernel/checks.json"), JSON.stringify(out.checks, null, 2) + "\n");
writeFileSync(join(cfgOut, "kernel/modules.json"), JSON.stringify(out.kernelModules, null, 2) + "\n");
writeFileSync(join(cfgOut, "engines.json"), JSON.stringify(out.engines, null, 2) + "\n");
writeFileSync(join(cfgOut, "exposure"), `${out.exposure}\n`);
if (caddy) writeFileSync(join(cfgOut, "Caddyfile"), caddy);
else rmSync(join(cfgOut, "Caddyfile"), { force: true });
writeFileSync(join(cfgOut, "module-data.json"), JSON.stringify(out.dataModules, null, 2) + "\n");
mkdirSync(join(cfgOut, "points"), { recursive: true });
for (const [m, p] of Object.entries(out.points)) writeFileSync(join(cfgOut, "points", `${m}.json`), JSON.stringify(p, null, 2) + "\n");
if (out.edge) {
  if (out.edge.cloudflared) try { checkIngress(out.edge.cloudflared, { login: out.edge.gate.login }); } catch (e) { die(e.message); }
  // The kernel's account map for the gate: the kernel rewrites it on every account change. It starts
  // empty so compose can bind it (a missing bind source becomes a directory); the gate refuses everyone it can't read.
  const accounts = join(resolve(repo, env("AIDENHQ_DATA_DIR") ?? "./data"), "gate", "accounts.json");
  if (!stage && existsSync(accounts) && !statSync(accounts).isFile()) die(`${accounts} is not a file (remove it and apply again)`);
  if (!stage && !existsSync(accounts)) {
    mkdirSync(dirname(accounts), { recursive: true, mode: 0o755 });
    writeFileSync(accounts, JSON.stringify({ accounts: [] }) + "\n", { mode: 0o644 });
  }
  // cloudflared's socket directory (the gate and cloudflared mount it), made here so it is the owner's and not root's.
  if (!stage && out.edge.cloudflared) mkdirSync(join(dirname(accounts), "socket"), { recursive: true, mode: 0o700 });
  // The gate's signing key is made with the other identity keys above, before compose binds it.
  if (!secretsDir) die("AIDENHQ_SECRETS_DIR is needed with settings.edge (the tunnel credentials and the gate's signing key)");
  const creds = join(secretsDir, "cloudflared_credentials.json");
  if (out.edge.cloudflared && (!existsSync(creds) || !statSync(creds).isFile() || !statSync(creds).size)) die(`settings.edge is set, but ${creds} is missing or empty: put the tunnel's credentials file there (docs/setup.md, Shared access)`);
  writeFileSync(join(cfgOut, "gate.json"), JSON.stringify(out.edge.gate, null, 2) + "\n");
  if (out.edge.cloudflared) writeFileSync(join(cfgOut, "cloudflared.yml"), dump(out.edge.cloudflared));
  else rmSync(join(cfgOut, "cloudflared.yml"), { force: true }); // header-jwt: a front door, no tunnel
} else for (const f of ["gate.json", "cloudflared.yml"]) rmSync(join(cfgOut, f), { force: true });
for (const w of out.warnings) console.log(`  warning: ${w}`);
const on = out.catalog.filter((m) => m.enabled).map((m) => m.name);
console.log(`${stage ? "staged" : "compiled"} ${on.length} modules (${on.join(", ")}): ${Object.keys(out.paperclip.agents).length} agents, ${Object.keys(out.paperclip.routines).length} routines, ${out.apps.apps.length} apps, ${Object.keys(out.compose.services).length} compose services`);
