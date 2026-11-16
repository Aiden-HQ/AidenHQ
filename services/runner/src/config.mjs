import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PRIVATE_BWRAP = "/opt/aidenhq/bwrap/bwrap";

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
  const agentsOrg = env.AIDENHQ_GITHUB_AGENTS_ORG || agentsOrgOf(inst && existsSync(inst) ? parseYaml(readFileSync(inst, "utf8"))?.settings : undefined);
  const githubApp = { appIdFile: join(secrets, "github-app", "app_id"), keyFile: join(secrets, "github-app", "key.pem") };
  const appOn = existsSync(githubApp.appIdFile) && existsSync(githubApp.keyFile);
  const allowed = [...(cfg.allowed_orgs ?? [])];
  if (appOn && agentsOrg && !allowed.some((o) => o.toLowerCase() === agentsOrg.toLowerCase())) allowed.push(agentsOrg); // the agents org is the runner's to change
  const stateDir = expand(cfg.state_dir ?? "~/.local/state/aidenhq-runner");
  const gcpCredentials =expand(cfg.gcp?.credentials ?? join(secrets, "gcloud/application_default_credentials.json"));
  return {
    ...cfg,
    allowed_orgs: allowed,
    githubApp: appOn ? githubApp : undefined,
    agentsOrg,
    file,
    companyId,
    selfName,
    paperclipUrl: env.PAPERCLIP_URL ?? cfg.paperclip_url ?? "http://localhost:3100",
    boardKeyFile: join(secrets, "paperclip_board_key"),
    boardTokenFile: join(secrets, "board_internal_token"),
    // The runner's own key to the board: files Tier 1, records Tier 0 runs, posts the reviewer's verdicts. Never a job's.
    reviewerKeyFile: join(secrets, "reviewer_key"),
    // The product repo (owner/name): AIDENHQ_PRODUCT_REPO, else this checkout's origin. Tiering treats it apart.
    productRepo: env.AIDENHQ_PRODUCT_REPO || productRepoOf(REPO_ROOT),
    /** GitHub token that adds deploy keys (modules/codehost-github/src/repos.ts); optional, never in an agent's sandbox. */
    githubAdminTokenFile: join(secrets, "github_admin_token"),
    repoAccessScript: join(REPO_ROOT, "ops/vm/add-deploy-key.sh"),
    boardInternalUrl: env.BOARD_INTERNAL_URL ?? cfg.recurring?.board_url ?? "http://127.0.0.1:3122",
    openrouterKeyFile: expand(cfg.engines?.openrouter?.key_file ?? join(secrets, "openrouter_key")),
    // The model gateway (kernel/src/gateway) on host loopback: opencode jobs, the AI reviewer and the intake call it with
    // tokens the runner signs with gateway_job_secret; only the gateway holds the OpenRouter key.
    gatewayUrl: cfg.gateway?.url ?? "http://127.0.0.1:8201",
    gatewayJobSecretFile: join(secrets, "gateway_job_secret"),
    // Box jobs (an Engineer with a computer, the App Engineer): the computer launcher's job routes and the key that opens only
    // them; the box reaches the model and its connections through the launcher's gateway.
    launcherUrl: env.AIDENHQ_LAUNCHER_URL ?? "http://10.231.0.1:8199",
    computersRunnerKeyFile: join(secrets, "computers_runner_key"),
    boxGatewayUrl: "http://10.231.2.1:8200",
    // The engine registry (compile writes it from the modules' providers.engine): kinds, their module, bin and data.
    enginesFile: join(configDir, "engines.json"),
    // The vault, for the files an engine gets as env (its secret_env): read before a job starts, never visible in one.
    secretsDir: secrets,
    // Jobs' reads of connections (compile writes it from the modules' jobcaps): through the gateway's /c/<connection>/mcp.
    jobcapsFile: join(configDir, "jobcaps.json"),
    // The kernel's backplane: the runner files a task's document there as a primer.publish record (main.mjs publishToPrimer).
    kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130",
    gcp: {
      credentialsFile: gcpCredentials,
      projects: (cfg.gcp?.projects ?? []).filter(Boolean),
      // Hidden from every job: the user's own gcloud sign-in, and AidenHQ's, whose refresh
      // token can be widened back to cloud-platform. And the secrets dir: the board key, the board's internal
      // token and the channels' module tokens live there; the runner reads what a job needs before it starts.
      // ~/.ssh too: the runner's write deploy keys are its own, never an agent's (it fetches and pushes for them).
      // The services' data dir: the board's account database holds sign-in sessions, and Paperclip's holds sessions and its
      // signing key. Sockets the runner's user may drive: Docker (its group is root on
      // the host: every container's secrets; /var/run is /run), tailscaled (it is the operator: serve and funnel) and the
      // user's own runtime dir (systemd --user and D-Bus: a unit started there runs outside the sandbox).
      // The user's gh sign-in (~/.config/gh): its OAuth token acts as the owner on GitHub; a job's gh reads with a
      // repo-narrowed GitHub App token instead (GH_TOKEN). And scripts/backup.sh's archives: copies of the data dir.
      // The runner's state db (+ WAL files) holds every run's helper token; the state dir itself stays readable because a
      // job's gcloud session lives under it (gcloud/<issue>), so only the db files are masked.
      hidden: [
        join(homedir(), ".config/gcloud"), dirname(gcpCredentials), secrets, join(homedir(), ".ssh"), resolve(REPO_ROOT, expand(env.AIDENHQ_DATA_DIR ?? "data")),
        join(homedir(), ".config/gh"), resolve(REPO_ROOT, "backups"),
        // The computer launcher's live run tokens (each one acts as an agent at the gateway).
        join(homedir(), ".local/state/aidenhq-computers"),
        ...["", "-wal", "-shm"].map((x) => join(stateDir, `state.sqlite${x}`)),
        "/run/docker.sock", "/run/tailscale/tailscaled.sock", `/run/user/${process.getuid()}`,
      ],
    },
    // Engineer jobs get a network namespace of their own through pasta (engines.mjs jailed); without it, the host's.
    // The private bwrap ops/vm/setup.sh installs with its own AppArmor profile (/usr/bin/bwrap keeps the release's
    // policy); a host set up before it has only the system's.
    bwrap: existsSync(PRIVATE_BWRAP) ? PRIVATE_BWRAP : "bwrap",
    pasta: (env.PATH ?? "").split(":").filter((d) => d.startsWith("/")).map((d) => join(d, "pasta")).find((p) => existsSync(p)),
    workDir: expand(cfg.work_dir ?? "~/aidenhq-work"),
    stateDir,
    // The monitoring module's textfile directory (node-exporter reads it): the runner's metrics (metrics.ts).
    metricsFile: join(resolve(REPO_ROOT, expand(env.AIDENHQ_DATA_DIR ?? "data")), "modules", "monitoring", "textfile", "runner.prom"),
    ghWrapperDir: join(REPO_ROOT, "services/runner/bin"),
    // agent-browser and its pinned Chrome (ops/vm/setup.sh, the browser image's build), read-only in jobs (bin/aidenhq-browse).
    browserDir: "/opt/aidenhq/browser",
  };
}
