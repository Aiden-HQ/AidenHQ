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
    /** GitHub token that adds deploy keys (src/repos.mjs); optional, never in an agent's sandbox. */
    githubAdminTokenFile: join(secrets, "github_admin_token"),
    repoAccessScript: join(REPO_ROOT, "ops/vm/add-deploy-key.sh"),
    boardInternalUrl: env.BOARD_INTERNAL_URL ?? cfg.recurring?.board_url ?? "http://127.0.0.1:3122",
    openrouterKeyFile: expand(cfg.engines?.openrouter?.key_file ?? join(secrets, "openrouter_key")),
    // The model gateway (services/gateway) on host loopback: opencode jobs, the AI reviewer and the intake call it with
    // tokens the runner signs with gateway_job_secret; only the gateway holds the OpenRouter key.
    gatewayUrl: cfg.gateway?.url ?? "http://127.0.0.1:8201",
    gatewayJobSecretFile: join(secrets, "gateway_job_secret"),
    // Box jobs (an Engineer with a computer, the App Engineer): the computer launcher's job routes and the key that opens only
    // them; the box reaches the model and its connections through the launcher's gateway.
    launcherUrl: env.AIDENHQ_LAUNCHER_URL ?? "http://10.231.0.1:8199",
    computersRunnerKeyFile: join(secrets, "computers_runner_key"),
    boxGatewayUrl: "http://10.231.2.1:8200",
    claudeTokenFile: expand(cfg.engines?.claude?.token_file ?? join(secrets, "claude_oauth_token")),
    // codex-openrouter's Codex homes, one per task (engines.mjs codexHome): never the host's ~/.codex.
    codexOpenrouterHome: expand(cfg.engines?.["codex-openrouter"]?.home ?? join(cfg.state_dir ?? "~/.local/state/aidenhq-runner", "codex-openrouter")),
    claudeConfigDir: expand(cfg.engines?.claude?.config_dir ?? join(cfg.state_dir ?? "~/.local/state/aidenhq-runner", "claude")),
    // Primer for every Engineer job, read-only: primer-mcp's loopback port.
    primerMcpUrl: env.PRIMER_RUNNER_URL ?? cfg.primer?.url ?? "http://127.0.0.1:3123/mcp/read",
    // The runner itself publishes a task's document there; jobs never get this endpoint.
    primerPublishUrl: env.PRIMER_RUNNER_PUBLISH_URL ?? "http://127.0.0.1:3123/mcp/publish", // not runner.yaml: old copies say /mcp
    primerPublishTokenFile: join(secrets, "primer_mcp_publish_token"),
    // Jobs hold their own token, which /mcp (publishing) refuses.
    primerTokenFile: join(secrets, "primer_mcp_read_token"),
    // Grafana and Google Cloud reads for Claude Code and Codex jobs.
    grafanaMcpUrl: env.GRAFANA_RUNNER_URL ?? cfg.grafana?.url ?? "http://127.0.0.1:3124/mcp",
    grafanaTokenFile: join(secrets, "grafana_mcp_token"),
    // Slack and Glean reads for Claude Code and Codex jobs: /mcp/read with tokens of their own.
    slackMcpUrl: env.SLACK_RUNNER_URL ?? cfg.slack?.url ?? "http://127.0.0.1:3125/mcp/read",
    slackTokenFile: join(secrets, "slack_mcp_read_token"),
    gleanMcpUrl: env.GLEAN_RUNNER_URL ?? cfg.glean?.url ?? "http://127.0.0.1:3126/mcp/read",
    gleanTokenFile: join(secrets, "glean_mcp_read_token"),
    // ClickHouse reads for Claude Code and Codex jobs: clickhouse-mcp's loopback port.
    clickhouseMcpUrl: env.CLICKHOUSE_RUNNER_URL ?? cfg.clickhouse?.url ?? "http://127.0.0.1:3127/mcp",
    clickhouseTokenFile: join(secrets, "clickhouse_mcp_token"),
    gcp: {
      credentialsFile: gcpCredentials,
      projects: (cfg.gcp?.projects ?? []).filter(Boolean),
      // Hidden from every job: the user's own gcloud sign-in, and AidenHQ's, whose refresh
      // token can be widened back to cloud-platform. And the secrets dir: the board key, the board's internal
      // token and owner_decide_key live there; the runner reads what a job needs before it starts.
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
    // The monitoring module's textfile directory (node-exporter reads it): the runner's metrics (metrics.mjs).
    metricsFile: join(resolve(REPO_ROOT, expand(env.AIDENHQ_DATA_DIR ?? "data")), "monitoring", "textfile", "runner.prom"),
    ghWrapperDir: join(REPO_ROOT, "services/runner/bin"),
    // The pinned Chromium headless shell and playwright-core (ops/vm/setup.sh), read-only in jobs (bin/aidenhq-browse).
    browserDir: "/opt/aidenhq/browser",
  };
}
