#!/usr/bin/env node
// Compile modules + the instance (AIDENHQ_INSTANCE_DIR) into the generated files the stack reads:
//   config/paperclip.yaml      → scripts/paperclip-setup.ts
//   config/apps.modules.yaml   → apps-mcp (module apps, read-only; agent-created apps live in the instance's apps.yaml)
//   compose.modules.yaml       → docker compose (COMPOSE_FILE in .env)
//   config/modules.json        → the module catalog (setup adds it to the capabilities catalog)
//   config/computers.json      → the computer launcher (images by content hash, connections it may proxy; services/computer)
//   config/gateway.json        → the model gateway (kernel/src/gateway): CI review, the install spend limits and the task cap
//   config/engines.json        → the runner: each engine kind's module, bin and data (modules' providers.engine)
//   config/jobcaps.json        → the kernel (job tokens on /c/<connection>/mcp) and the runner: what jobs may read (modules' jobcaps:)
//   config/kernel/connections.json → the kernel's tool proxy: each connection's endpoint, service key secret, module and tool tags
//   config/kernel/writes.json  → the kernel's write kinds (modules' `writes:`): floor, card, args schema, executor, routed tools
//   config/kernel/checks.json  → the kernel: modules' task.finish checks (url, key secret, label, scope) and write.filed ones (kinds)
//   config/kernel/modules.json → the kernel: modules' kernel roles, privileged entries, own tokens and channels (settings),
//                                each enabled module's compose services and its setup secrets
//   config/exposure           → ops/vm/setup.sh (root) and verify-security: settings.exposure, one word
//   config/apps-node          → apps-mcp: `tailnet` in tailscale mode, where the apps' tailnet node is the instance's door, else `none`
//   config/Caddyfile           → the `caddy` service, the public front door (only with exposure public, scripts/front-door.ts)
//   config/module-data.json    → the apply (ops/lib/generations.sh): each data module's data_version
//   config/points/<module>.json → that module's own services only: the contributions to its points (spec §3.6)
//   config/gate.json, config/cloudflared.yml → the gate and the tunnel (shared access; only with settings.edge, scripts/edge.ts)
// `--sizes`: compile, print each crew agent's handbook bytes per section (scripts/handbook.ts) and write nothing.
// Staging (`--stage`, or AIDENHQ_COMPILE_STAGE=1; ops/apply-config-work.sh validates a generation with it before anything
// restarts): the same files go to config.next/ and compose.modules.next.yaml, and nothing else on the host is touched (no
// secrets, keys, data dirs or account files are created). The apply then compiles for real and checks the two agree.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { Obj } from "./modules.ts";
import { compile, composeSecretFiles, ensureMountedSecrets, ensureOptionalSecrets, hostMounts, hostDirs, migrateSettings } from "./modules.ts";
import { computersConfig } from "./computers.ts";
import { checkIngress } from "./edge.ts";
import { caddyfile, caddyService, publicUrls } from "./front-door.ts";
import { ensureIdentityKeys } from "./identity.ts";
import { report, staticCheck } from "./agent-check.ts";
import { sizesReport } from "./handbook.ts";
import { checkDataVersion } from "./compiler/data-version.ts";
import { hostFetch } from "./compiler/sources.ts";
import { readRelease } from "./compiler/release.ts";
import { hostEnv, loadInputs } from "./compiler/inputs.ts";
import { computerPulls, useReleaseImages } from "./release-images.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = hostEnv(repo);
const die: (msg: string) => never = (msg) => { console.error(`compile: ${msg}`); process.exit(1); };
const stage = process.argv.includes("--stage") || process.env.AIDENHQ_COMPILE_STAGE === "1";
const cfgOut = join(repo, stage ? "config.next" : "config");
const composeOut = join(repo, stage ? "compose.modules.next.yaml" : "compose.modules.yaml");
if (stage) { rmSync(cfgOut, { recursive: true, force: true }); mkdirSync(cfgOut, { recursive: true }); }

const instanceDir = env("AIDENHQ_INSTANCE_DIR");
if (!instanceDir || !existsSync(join(instanceDir, "instance.yaml"))) die("set AIDENHQ_INSTANCE_DIR to your instance checkout (see docs/USAGE.md)");
const bundleFile = join(repo, "data", "bundle-state.json");
// DELETE in the release after #1065: the retired GitHub App's id, which the github process looks for in the repos' rules
// (migrate.ts). Apply removes the vault's github-app dir after the first good generation, so the id is kept beside it first.
// A staged compile reads only; the switch's compile (before apply's retireUnits) keeps it.
const secrets = env("AIDENHQ_SECRETS_DIR");
if (secrets && !stage && !existsSync(join(secrets, "github_retired_app_id")) && existsSync(join(secrets, "github-app", "app_id"))) writeFileSync(join(secrets, "github_retired_app_id"), `${readFileSync(join(secrets, "github-app", "app_id"), "utf8").trim()}\n`, { mode: 0o600 });
// The host's inputs (scripts/compiler/inputs.ts): the kernel compiles an agent's prospective change with the same ones.
const inputs = loadInputs(repo, env);
let out!: ReturnType<typeof compile>, computers!: ReturnType<typeof computersConfig> & { pull?: ReturnType<typeof computerPulls> };
try { out = compile(repo, instanceDir, inputs); computers = computersConfig(out.paperclip, repo, out.computersMax, out.checkComputersMax); } catch (e) { die((e as Error).message); }
if (!stage) { mkdirSync(dirname(bundleFile), { recursive: true }); writeFileSync(bundleFile, JSON.stringify(out.bundleState)); }
if (process.argv.includes("--sizes")) {
  try { console.log(sizesReport(out.paperclip, { repo, instanceDir, engines: out.engines })); } catch (e) { die((e as Error).message); }
  process.exit(0);
}
// The pre-launch agent check (scripts/agent-check.ts): before anything is written, so a failing agent never launches.
if (report("agent-check", staticCheck(out.paperclip))) die("the agent check failed (above); fix the agent");

// Host paths come from the host's .env, never from instance.yaml (agents can edit that through apply): ops-mcp's config and routing rules,
// transcripts, vault folders and knowledge bases. A module can't declare a host mount; these are the host's own.
const ops = out.compose.services["meetings-ops-mcp"];
if (ops) {
  // The config directory, not its files: a file saved by rename (an editor, setup.sh) would stay the old inode in a single-file bind mount.
  const own = ["${AIDENHQ_CONFIG_DIR:-./config}:/config:ro", "${TRANSCRIPTS_DIR:?set TRANSCRIPTS_DIR in .env}:/sources/transcripts"];
  // A bind source that is missing becomes a directory: an install from before routing.yaml was mounted gets the example's empty rules (scripts/bootstrap.sh does the same).
  const routing = join(resolve(repo, env("AIDENHQ_CONFIG_DIR") || "config"), "routing.yaml");
  if (!stage && !existsSync(routing)) { writeFileSync(routing, readFileSync(join(repo, "config", "routing.example.yaml"))); console.log(`  created ${routing}`); }
  try { ops.volumes = [...(ops.volumes ?? []), ...own, ...hostMounts({ VAULT_DIR: env("VAULT_DIR"), VAULT_FOLDERS: env("VAULT_FOLDERS"), KNOWLEDGE_BASES: env("KNOWLEDGE_BASES") })]; } catch (e) { die((e as Error).message); }
}

// Secrets of channels the owner may not use start as empty files, so compose can start (empty = not configured).
const secretsDir = env("AIDENHQ_SECRETS_DIR");
// An upgrade moves a removed setting's value into its secret (before the empty files below) and names every dropped key.
if (!stage) for (const l of migrateSettings(YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8"))?.settings, secretsDir, out.secretPatterns)) console.log(`  ${l}`);
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

// A module's own vault folder (secrets.state) too: the secrets dir is a FUSE mount, so Docker (root) can't create its bind source.
if (secretsDir && !stage) for (const d of new Set(out.stateDirs)) mkdirSync(join(secretsDir, d), { recursive: true, mode: 0o700 });

// The grants table's directory exists before compose mounts it (Docker would create a root-owned one setup can't write).
if (!stage) mkdirSync(join(resolve(repo, env("AIDENHQ_CONFIG_DIR") ?? "config"), "grants"), { recursive: true });
// Likewise the apps node's state and serve config (compose.yaml apps-edge; apps-mcp writes the serve config), and the
// on-server code host's repos (apps-mcp mounts them read-only; the runner, as the host user, creates repos in them). Here,
// not in apply-config.sh: the apply that brings this in still runs the old script, which then runs this compile.
const dataDir = resolve(repo, env("AIDENHQ_DATA_DIR") ?? "data");
if (!stage) for (const d of ["apps-edge/state", "apps-edge/serve", "previews", "codehost", ...out.dataDirs]) mkdirSync(join(dataDir, d), { recursive: true });
// The job workspaces, before compose bind-mounts them into the code host (Docker would make a missing one as root).
if (!stage) mkdirSync(join(hostDirs(repo).work_dir, "tasks"), { recursive: true });
// Code never starts on data newer than it (spec §6.4.1): staged, only checked (the apply snapshots the data after this); for
// real, each data module's marker is set to its data_version before compose starts it.
try { for (const [m, d] of Object.entries(out.dataModules)) checkDataVersion(m, d.data_version, join(dataDir, "modules", m), !stage); } catch (e) { die((e as Error).message); }
// The security scanner's copy of the app registry (its data dir, read-only there): no module mounts the instance checkout.
if (!stage && out.compose.services["security-scanner"]) writeFileSync(join(dataDir, "modules/security/registry/apps.yaml"), existsSync(join(instanceDir, "apps.yaml")) ? readFileSync(join(instanceDir, "apps.yaml")) : "apps: []\n");

// The public front door (exposure public): Caddy for the host's public IPv4, from .env (ops/setup.sh writes it with the board's
// and the admin listener's URLs, which the kernel reads there too). Its service is named exactly `caddy`: ops/vm/setup.sh
// opens 443 and 8446 only once compose.modules.yaml has it.
// The mode is the host's: ops/setup.sh --exposure writes it into .env beside the URLs it derives, so an instance edit alone
// (an agent's, through an apply) can't move the board's door. A host set up before the line was written has none: no check.
const hostMode = env("AIDENHQ_EXPOSURE");
if (hostMode && hostMode !== out.exposure) die(`settings.exposure is ${out.exposure}, but this host is set up for ${hostMode}: switch with sudo ops/setup.sh --unattended --exposure ${out.exposure}`);
let caddy: string | undefined;
if (out.exposure === "public") {
  const ip = env("AIDENHQ_PUBLIC_IP"), urls = publicUrls(ip);
  try { caddy = caddyfile(ip, undefined, out.edge?.gate?.doors?.base); } catch (e) { die(`exposure public: AIDENHQ_PUBLIC_IP in .env: ${(e as Error).message} (sudo ops/setup.sh sets it)`); }
  if (env("BOARD_LAN_URL") !== urls.board || env("AIDENHQ_ADMIN_URL") !== urls.admin) die(`exposure public: .env needs BOARD_LAN_URL=${urls.board} and AIDENHQ_ADMIN_URL=${urls.admin} (sudo ops/setup.sh sets them)`);
  out.compose.services.caddy = caddyService(caddy);
  if (!stage) mkdirSync(join(dataDir, "caddy"), { recursive: true, mode: 0o700 });
}

const header ="# Generated by scripts/compile.ts from modules/ and the instance. Do not edit; edit the module or instance.yaml.\n";
const dump = (v: unknown) => header + YAML.stringify(v, { lineWidth: 0 });
writeFileSync(join(cfgOut, "paperclip.yaml"), dump(out.paperclip));
writeFileSync(join(cfgOut, "apps.modules.yaml"), dump(out.apps));
// A pinned release's prebuilt images (scripts/release-images.ts): its digests run instead of local builds.
let images = {};
try { images = readRelease(YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8")) ?? {}, hostFetch(repo))?.images ?? {}; } catch (e) { die((e as Error).message); }
if (Object.keys(images).length) {
  out.compose = useReleaseImages(out.compose, YAML.parse(readFileSync(join(repo, "compose.yaml"), "utf8")), images);
  computers.pull = computerPulls(computers.images, images);
}
// The apps' tailnet node is the door in tailscale mode (compose.yaml apps-edge): only there may apps-mcp let token-less callers
// into an app as anonymous (AIDENHQ_ANONYMOUS; docs/design/app-identity.md). Anywhere else the way in is the host's loopback,
// so every app requires a signed identity. It joins with the vault's tailscale_apps_authkey when that has a key; without one
// it signs in once through a link on the board's Apps page (platform.ts refreshNode), and /state keeps the node. apps-mcp
// treats it as a door only once it is logged in.
const appsKey = secretsDir && join(secretsDir, "tailscale_apps_authkey");
const appsNode = out.exposure === "tailscale";
const appsKeyed = !!appsKey && existsSync(appsKey) && readFileSync(appsKey, "utf8").trim() !== "";
// Off tailscale mode compose.yaml's apps-edge must not run: an inactive profile takes it out of the stack, and the apply
// removes a container left from before. Keyless, the key's secret and variable go (a missing secret file fails compose).
if (!appsNode) out.compose.services["apps-edge"] = { profiles: ["off"] };
else if (!appsKeyed && out.compose.services["apps-edge"]) {
  const edge = out.compose.services["apps-edge"];
  delete edge.environment.TS_AUTHKEY;
  edge.secrets = edge.secrets.filter((s: string) => s !== "tailscale_apps_authkey");
  if (!edge.secrets.length) delete edge.secrets;
  delete out.compose.secrets?.tailscale_apps_authkey;
}
const compose = Object.fromEntries(Object.entries(out.compose).filter(([k, v]) => k === "services" || Object.keys(v).length));
writeFileSync(composeOut, dump(compose));
writeFileSync(join(cfgOut, "modules.json"), JSON.stringify(out.catalog, null, 2) + "\n");
writeFileSync(join(cfgOut, "computers.json"), JSON.stringify({ ...computers, ...hostDirs(repo) }, null, 2) + "\n");
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
writeFileSync(join(cfgOut, "apps-node"), `${appsNode ? "tailnet" : "none"}\n`);
if (caddy) writeFileSync(join(cfgOut, "Caddyfile"), caddy);
else rmSync(join(cfgOut, "Caddyfile"), { force: true });
writeFileSync(join(cfgOut, "module-data.json"), JSON.stringify(out.dataModules, null, 2) + "\n");
mkdirSync(join(cfgOut, "points"), { recursive: true });
for (const [m, p] of Object.entries(out.points)) writeFileSync(join(cfgOut, "points", `${m}.json`), JSON.stringify(p, null, 2) + "\n");
if (out.edge) {
  if (out.edge.cloudflared) try { checkIngress(out.edge.cloudflared, { login: out.edge.gate.login }); } catch (e) { die((e as Error).message); }
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
