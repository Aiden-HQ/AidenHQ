// The sandbox settings as the host has them (sandbox.ts takes them as a SandboxConfig): config/runner.yaml's job keys, the vault
// and data dirs, and what no job may see. Apart from sandbox.ts so that what imports the sandbox needs no YAML parser.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SandboxConfig } from "./sandbox.ts";

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const repoRoot = resolve(import.meta.dirname, "../..");
const PRIVATE_BWRAP = "/opt/aidenhq/bwrap/bwrap";

/**
 * The sandbox settings: the host's tuning (config/runner.yaml: work_dir, state_dir, timeout/stall/progress minutes, sandbox, the
 * gateway URL a test points elsewhere) and the vault and data dirs. `hidden` is what no job may see even inside an allowed path.
 */
export function sandboxConfig(env: (k: string) => string | undefined = (k) => process.env[k]): SandboxConfig {
  const configDir = resolve(repoRoot, env("AIDENHQ_CONFIG_DIR") ?? "config");
  const file = existsSync(join(configDir, "runner.yaml")) ? join(configDir, "runner.yaml") : join(repoRoot, "config/runner.example.yaml");
  const y = (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, any>;
  const secrets = expand(env("AIDENHQ_SECRETS_DIR") ?? "~/.config/aidenhq");
  const stateDir = expand(y.state_dir ?? "~/.local/state/aidenhq-runner");
  const credentials = expand(y.gcp?.credentials ?? join(secrets, "gcloud/application_default_credentials.json"));
  const dataDir = resolve(repoRoot, expand(env("AIDENHQ_DATA_DIR") ?? "data"));
  const path = env("PATH") ?? "";
  return {
    bwrap: existsSync(PRIVATE_BWRAP) ? PRIVATE_BWRAP : "bwrap",
    pasta: path.split(":").filter((d) => d.startsWith("/")).map((d) => join(d, "pasta")).find((p) => existsSync(p)),
    // Hidden from every job: the user's own cloud sign-in and AidenHQ's (its refresh token can be widened again); the vault
    // (the board key, the internal token, module tokens); ~/.ssh (write deploy keys); the services' data dir (sessions, signing
    // keys, kernel.db); the user's gh sign-in (it acts as the owner); backups (copies of the data dir); the computer launcher's
    // live run tokens; the runner's state db (every run's helper token); the sockets the host user may drive: Docker (root on
    // the host), tailscaled (the operator: serve and funnel) and the user's runtime dir (systemd --user, D-Bus).
    hidden: [
      join(homedir(), ".config/gcloud"), dirname(credentials), secrets, join(homedir(), ".ssh"), dataDir,
      join(homedir(), ".config/gh"), resolve(repoRoot, "backups"), join(homedir(), ".local/state/aidenhq-computers"),
      ...["", "-wal", "-shm"].map((x) => join(stateDir, `state.sqlite${x}`)),
      "/run/docker.sock", "/run/tailscale/tailscaled.sock", `/run/user/${process.getuid?.() ?? 0}`,
    ],
    sandbox: y.sandbox,
    binDir: join(repoRoot, "services/runner/bin"),
    browserDir: "/opt/aidenhq/browser",
    workDir: expand(y.work_dir ?? "~/aidenhq-work"),
    stateDir,
    logsDir: join(stateDir, "logs"),
    secretsDir: secrets,
    enginesFile: join(configDir, "engines.json"),
    jobcapsFile: join(configDir, "jobcaps.json"),
    gatewayUrl: y.gateway?.url ?? "http://127.0.0.1:8201",
    helperPort: Number(y.helper_port ?? 3140),
    boxGatewayUrl: "http://10.231.2.1:8200",
    boxDir: join(homedir(), ".local/state/aidenhq-computers/jobs"),
    timeout_minutes: y.timeout_minutes ?? 60,
    stall_minutes: y.stall_minutes ?? 15,
    progress_minutes: y.progress_minutes ?? 35,
  };
}
