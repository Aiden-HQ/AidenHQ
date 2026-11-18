// The job settings as the host has them (sandbox.ts takes them as a SandboxConfig): config/runner.yaml's job keys and the vault
// dir. Apart from sandbox.ts so that what imports the sandbox needs no YAML parser.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SandboxConfig } from "./sandbox.ts";

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The job settings: the host's tuning (config/runner.yaml: work_dir, state_dir, timeout/stall/progress minutes, the gateway URL
 * a test points elsewhere) and the vault dir.
 */
export function sandboxConfig(env: (k: string) => string | undefined = (k) => process.env[k]): SandboxConfig {
  const configDir = resolve(repoRoot, env("AIDENHQ_CONFIG_DIR") ?? "config");
  const file = join(configDir, "runner.yaml");
  const y = ((existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : {}) ?? {}) as Record<string, any>;
  const secrets = expand(env("AIDENHQ_SECRETS_DIR") ?? "~/.config/aidenhq");
  const stateDir = expand(y.state_dir ?? "~/.local/state/aidenhq-runner");
  return {
    workDir: expand(y.work_dir ?? "~/aidenhq-work"),
    stateDir,
    logsDir: join(stateDir, "logs"),
    secretsDir: secrets,
    enginesFile: join(configDir, "engines.json"),
    gatewayUrl: y.gateway?.url ?? "http://127.0.0.1:8201",
    boxGatewayUrl: "http://10.231.2.1:8200",
    boxDir: join(homedir(), ".local/state/aidenhq-computers/jobs"),
    timeout_minutes: y.timeout_minutes ?? 60,
    stall_minutes: y.stall_minutes ?? 15,
    progress_minutes: y.progress_minutes ?? 35,
  };
}
