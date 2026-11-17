import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { officialRepo } from "../../../scripts/official-repo.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const expand = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
}

/** The agents org from instance settings: github_agents_org, else aidenhq-<instance_name> (scripts/modules.mjs agrees). */
export const agentsOrgOf = (settings) => settings?.github_agents_org || (settings?.instance_name ? `aidenhq-${settings.instance_name}` : undefined);

/**
 * owner/name of a GitHub remote URL: https://github.com/o/r(.git)(/), git@github.com:o/r.git, ssh://git@github.com/o/r, or
 * an SSH alias (git@github-work:o/r.git). Undefined when it can't be told (tiering then fails closed: Tier 2).
 */
export function githubSlug(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/[^@/]+@[^/:]+(?::\d+)?\/|[^@\s/]+@[^:\s/]+:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** owner/name of a checkout's origin on GitHub, or undefined. */
function productRepoOf(dir) {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return githubSlug(url);
  } catch {
    return undefined;
  }
}

/** Whether the compiled module catalog (config/modules.json) has `name` enabled; false when it can't be read. */
function enabledIn(file, name) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).some((m) => m?.name === name && m.enabled === true);
  } catch {
    return false;
  }
}

/** Runner configuration: config/runner.yaml (or the example) plus .env and system.yaml. */
export function loadConfig() {
  const env = { ...loadEnv(process.env.AIDENHQ_ENV_FILE ?? join(REPO_ROOT, ".env")), ...process.env };
  const configDir = resolve(REPO_ROOT, env.AIDENHQ_CONFIG_DIR ?? "config");
  const file = existsSync(join(configDir, "runner.yaml")) ? join(configDir, "runner.yaml") : join(REPO_ROOT, "config/runner.example.yaml");
  const cfg = parseYaml(readFileSync(file, "utf8"));
  const system = readFileSync(join(configDir, "system.yaml"), "utf8");
  const companyId = /^\s*company_id:\s*"?([0-9a-f-]{36})"?/m.exec(system)?.[1];
  const selfName = /^\s*names:\s*\[\s*"([^"]+)"/m.exec(system)?.[1] ?? "the user";
  if (!companyId) throw new Error("paperclip.company_id missing in config/system.yaml (run scripts/paperclip-setup.mjs)");
  const secrets = expand(env.AIDENHQ_SECRETS_DIR ?? "~/.config/aidenhq");
  // The instance's GitHub App, from the vault; the agents org (where it may create repos): AIDENHQ_GITHUB_AGENTS_ORG,
  // else the instance's settings (github_agents_org, or aidenhq-<instance_name>).
  const inst = env.AIDENHQ_INSTANCE_DIR && join(expand(env.AIDENHQ_INSTANCE_DIR), "instance.yaml");
  const instance = inst && existsSync(inst) ? parseYaml(readFileSync(inst, "utf8")) : undefined;
  const agentsOrg = env.AIDENHQ_GITHUB_AGENTS_ORG || agentsOrgOf(instance?.settings);
  const githubApp = { appIdFile: join(secrets, "github-app", "app_id"), keyFile: join(secrets, "github-app", "key.pem") };
  const appOn = existsSync(githubApp.appIdFile) && existsSync(githubApp.keyFile);
  const allowed = [...(cfg.allowed_orgs ?? [])];
  if (appOn && agentsOrg && !allowed.some((o) => o.toLowerCase() === agentsOrg.toLowerCase())) allowed.push(agentsOrg); // the agents org is the runner's to change
  const stateDir = expand(cfg.state_dir ?? "~/.local/state/aidenhq-runner");
  // The on-server code host (codehost-local, enabled in the compiled catalog): its org `local` is an agents org too, and
  // its bare repos live under <data dir>/codehost (docs/design/codehost-local.md).
  const dataDir = resolve(REPO_ROOT, expand(env.AIDENHQ_DATA_DIR ?? "data"));
  const localHost = enabledIn(join(configDir, "modules.json"), "codehost-local");
  // GitHub is a code host unless the catalog has codehost-local on and codehost-github off (an instance with no GitHub).
  const githubHost = !localHost || enabledIn(join(configDir, "modules.json"), "codehost-github");
  if (localHost && !allowed.some((o) => o.toLowerCase() === "local")) allowed.push("local");
  const gcpCredentials =expand(cfg.gcp?.credentials ?? join(secrets, "gcloud/application_default_credentials.json"));
  return {
    ...cfg,
    allowed_orgs: allowed,
    githubApp: appOn ? githubApp : undefined,
    agentsOrg,
    // One agents org per enabled code host: tiering (tiers.mjs, plan.mjs) and the kernel (kinds.ts) take the list.
    agentsOrgs: [...(agentsOrg ? [agentsOrg] : []), ...(localHost ? ["local"] : [])],
    localHost,
    githubHost,
    // The orgs agents name new repos in (prompts, refusals): one per enabled code host.
    hostOrgs: [...(githubHost && agentsOrg ? [agentsOrg] : []), ...(localHost ? ["local"] : [])],
    dataDir,
    file,
    companyId,
    selfName,
    paperclipUrl: env.PAPERCLIP_URL ?? cfg.paperclip_url ?? "http://localhost:3100",
    boardKeyFile: join(secrets, "paperclip_board_key"),
    boardTokenFile: join(secrets, "board_internal_token"),
    // The runner's own key to the board: files Tier 1, records Tier 0 runs, posts the reviewer's verdicts. Never a job's.
    reviewerKeyFile: join(secrets, "reviewer_key"),
    runnerWritesKeyFile: join(secrets, "runner_writes_key"),
    // The product repo (owner/name): AIDENHQ_PRODUCT_REPO (setup records it; the kernel reads only that), else this
    // checkout's origin. Tiering treats it apart.
    productRepo: env.AIDENHQ_PRODUCT_REPO || productRepoOf(REPO_ROOT),
    // The official modules repository: part of the product (the reviewer's scope, the grader's repos).
    modulesRepo: officialRepo(instance, REPO_ROOT),
    /** GitHub token that adds deploy keys (modules/codehost-github/src/repos.ts); optional, never in an agent's sandbox. */
    githubAdminTokenFile: join(secrets, "github_admin_token"),
    repoAccessScript: join(REPO_ROOT, "ops/vm/add-deploy-key.sh"),
    boardInternalUrl: env.BOARD_INTERNAL_URL ?? cfg.recurring?.board_url ?? "http://127.0.0.1:3122",
    openrouterKeyFile: expand(cfg.engines?.openrouter?.key_file ?? join(secrets, "openrouter_key")),
    // The model gateway (kernel/src/gateway) on host loopback: opencode jobs, the AI reviewer and the intake call it with
    // tokens the runner signs with gateway_job_secret; only the gateway holds the OpenRouter key.
    gatewayUrl: cfg.gateway?.url ?? "http://127.0.0.1:8201",
    // The agents' `aidenhq` commands (repohelper.ts): a fixed loopback port, the only one besides 8201 a job reaches.
    helperPort: Number(cfg.helper_port ?? 3140),
    // Box jobs (an Engineer with a computer, the App Engineer): the computer launcher's job routes and the key that opens only
    // them; the box reaches the model and its connections through the launcher's gateway.
    launcherUrl: env.AIDENHQ_LAUNCHER_URL ?? "http://10.231.0.1:8199",
    computersRunnerKeyFile: join(secrets, "computers_runner_key"),
    // The engine registry (compile writes it from the modules' providers.engine): kinds, their module, bin and data.
    enginesFile: join(configDir, "engines.json"),
    // The vault (the job token's secret, for `aidenhq advise`; the engineering module's token for the kernel's job routes).
    secretsDir: secrets,
    // Jobs' reads of connections (compile writes it from the modules' jobcaps): through the gateway's /c/<connection>/mcp.
    jobcapsFile: join(configDir, "jobcaps.json"),
    // The kernel's backplane: the runner files a task's document there as a primer.publish record (main.mjs publishToPrimer).
    kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130",
    gcp: {
      credentialsFile: gcpCredentials,
      projects: (cfg.gcp?.projects ?? []).filter(Boolean),
    },
    workDir: expand(cfg.work_dir ?? "~/aidenhq-work"),
    stateDir,
    // The monitoring module's textfile directory (node-exporter reads it): the runner's metrics (metrics.ts).
    metricsFile: join(dataDir, "modules", "monitoring", "textfile", "runner.prom"),
  };
}
