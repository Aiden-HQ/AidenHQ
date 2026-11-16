import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { WEEKDAYS, type Weekday } from "./recurrence.js";

const SystemSchema = z.object({
  timezone: z.string().default("UTC"),
  /** The days Tomorrow rolls into Today. */
  workdays: z.array(z.enum(WEEKDAYS)).min(1).default(["monday", "tuesday", "wednesday", "thursday", "friday"]),
  paperclip: z.object({ company_id: z.string().uuid() }),
  /** Slack hosts → the ID the desktop app opens them with, so the board's Slack links open the app. */
  slack: z.object({ teams: z.record(z.string().regex(/^[a-z0-9.-]+\.slack\.com$/), z.string().regex(/^[TE][A-Z0-9]+$/)).default({}) }).default({ teams: {} }),
});

export interface Config {
  paperclipUrl: string;
  companyId: string;
  boardKey: string;
  /** The runner's reviewer key (reviewer_key): Tier 1 verdicts. None: the reviewer can't decide. */
  reviewerKey?: string;
  /** The operator's key (board_operator_key): ops/setup.sh's owner setup link, welcome chat and account resets, nothing else. */
  operatorKey?: string;
  /** The model gateway (kernel/src/gateway): its billed ledger is pulled from `url`; `token` (gateway_board_key) both ways (it files raise_cap). */
  gateway?: { url: string; token: string };
  timezone: string;
  workdays: Weekday[];
  /** Slack host → workspace or organization ID (E… on Enterprise Grid), for slack:// links. */
  slackTeams: Record<string, string>;
  dbPath: string;
  port: number;
  /** Host headers the board answers to (DNS-rebinding guard), e.g. localhost:3120. */
  allowedHosts: string[];
  staticDir: string;
  logLevel: string;
  /**
   * The second listener (3121): the board's https address behind `tailscale serve`, and phones on the home network, under
   * these host names; signed-in admins only, like the local one. `url`: the board's https address (BOARD_LAN_URL).
   */
  lan: { port: number; hosts: string[]; url: string; googleConnect?: boolean };
  /**
   * The listener for the tasks bridge and the runner, with a bearer token: off unless the
   * token file exists.
   */
  internal?: { port: number; hosts: string[]; token: string };
  /** google-workspace-mcp's sign-in endpoints: off unless the token file exists. */
  google?: { url: string; token: string };
  /** glean-mcp's sign-in endpoints: off unless the token file exists. */
  glean?: { url: string; token: string };
  /** grafana-mcp's sign-in endpoints: off unless the token file exists. */
  grafana?: { url: string; token: string };
  /** clickhouse-mcp's sign-in endpoints: off unless the token file exists. */
  clickhouse?: { url: string; token: string };
  /** jira-mcp's sign-in endpoints: off unless the jira module mounts its token. */
  jira?: { url: string; token: string };
  /** Where Paperclip keeps its Codex session logs (read-only mount), and the computer launcher for agents in their own computers. */
  sessions?: { dir?: string; launcher?: { url: string; token: string } };
  /**
   * Board accounts: Better Auth in auth.db beside the board's database, and the gate-facing sign-in listener (3129) at
   * `signin.hosts` (loopback; the gate calls it). `gateFile`: config/gate.json (the sign-in host, app hosts, login mode); `gateAccountsFile`: data/gate/accounts.json, which the board writes.
   */
  accounts: { dbPath: string; boardUrl: string; gateFile: string; gateAccountsFile?: string; gateSecret?: string; edgeSecret?: string; linkTtlHours?: number; ownerEmail?: string; signin: { port: number; hosts: string[] } };
}

/** A key file's value, at least 32 characters, else undefined (not configured). */
function keyFile(f: string): string | undefined {
  const k = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  return k.length >= 32 ? k : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const system = SystemSchema.parse(parseYaml(readFileSync(env.BOARD_SYSTEM_CONFIG ?? "/config/system.yaml", "utf8")));
  const port = Number(env.BOARD_PORT ?? 3120);
  const hosts = hostList(env.BOARD_ALLOWED_HOSTS ?? `localhost:${port},127.0.0.1:${port}`);
  return {
    paperclipUrl: env.PAPERCLIP_URL ?? "http://paperclip:3100",
    companyId: system.paperclip.company_id,
    boardKey: readFileSync(env.BOARD_KEY_FILE ?? "/run/secrets/paperclip_board_key", "utf8").trim(),
    reviewerKey: keyFile(env.BOARD_REVIEWER_KEY_FILE ?? "/run/secrets/reviewer_key"),
    operatorKey: keyFile(env.BOARD_OPERATOR_KEY_FILE ?? "/run/secrets/board_operator_key"),
    timezone: system.timezone,
    workdays: system.workdays,
    slackTeams: system.slack.teams,
    dbPath: env.BOARD_DB ?? "/data/board/board.sqlite",
    port,
    allowedHosts: hosts,
    staticDir: env.BOARD_STATIC_DIR ?? new URL("../web", import.meta.url).pathname,
    logLevel: env.LOG_LEVEL ?? "info",
    lan: lanConfig(env),
    internal: internalConfig(env),
    google: signIn(env.GOOGLE_AUTH_TOKEN_FILE ?? "/run/secrets/google_auth_token", env.GOOGLE_WORKSPACE_URL ?? "http://google-workspace-mcp:8081"),
    glean: signIn(env.GLEAN_AUTH_TOKEN_FILE ?? "/run/secrets/glean_auth_token", env.GLEAN_SERVICE_URL ?? "http://glean-mcp:8085"),
    grafana: signIn(env.GRAFANA_AUTH_TOKEN_FILE ?? "/run/secrets/grafana_auth_token", env.GRAFANA_SERVICE_URL ?? "http://grafana-mcp:8087"),
    clickhouse: signIn(env.CLICKHOUSE_AUTH_TOKEN_FILE ?? "/run/secrets/clickhouse_auth_token", env.CLICKHOUSE_SERVICE_URL ?? "http://clickhouse-mcp:8088"),
    jira: signIn(env.JIRA_AUTH_TOKEN_FILE ?? "/run/secrets/jira_auth_token", env.JIRA_SERVICE_URL ?? "http://jira-mcp:8091"),
    sessions: sessionsConfig(env),
    gateway: env.AIDENHQ_GATEWAY_URL && keyFile(env.GATEWAY_BOARD_KEY_FILE ?? "/run/secrets/gateway_board_key") ? { url: env.AIDENHQ_GATEWAY_URL.replace(/\/+$/, ""), token: keyFile(env.GATEWAY_BOARD_KEY_FILE ?? "/run/secrets/gateway_board_key")! } : undefined,
    accounts: accountsConfig(env, port, hosts),
  };
}

function accountsConfig(env: NodeJS.ProcessEnv, port: number, hosts: string[]): Config["accounts"] {
  const dbPath = env.BOARD_AUTH_DB ?? join(dirname(env.BOARD_DB ?? "/data/board/board.sqlite"), "auth.db");
  const signinPort = Number(env.BOARD_SIGNIN_PORT ?? 3129);
  // Admin links open on the board's https address (the tailnet name), else its first host.
  const boardUrl = (env.BOARD_LAN_URL || `http://${hosts[0] ?? `localhost:${port}`}`).replace(/\/+$/, "");
  const gateFile = env.BOARD_GATE_CONFIG ?? "/config/gate.json";
  // Written only where its directory is mounted (with settings.edge); without shared apps there's no gate to tell.
  const accountsFile = env.BOARD_GATE_ACCOUNTS ?? "/data/gate/accounts.json";
  const gateAccountsFile = existsSync(dirname(accountsFile)) ? accountsFile : undefined;
  // The gate's shared secret (gate_board_secret): a sign-in request carrying it may name the client's address.
  const gateSecret = keyFile(env.BOARD_GATE_SECRET_FILE ?? "/run/secrets/gate_board_secret");
  // The front door's shared secret (edge_board_secret): a board request carrying it may name the client's address.
  const edgeSecret = keyFile(env.BOARD_EDGE_SECRET_FILE ?? "/run/secrets/edge_board_secret");
  // Setup, invite and reset links' lifetime in hours (default 72; the exposure setting makes it 24 when public, D9).
  const linkTtlHours = Number(env.BOARD_LINK_TTL_HOURS) > 0 ? Number(env.BOARD_LINK_TTL_HOURS) : undefined;
  // settings.owner_email: the only email setup makes the owner's account (the gate makes the same email admin of every app).
  const ownerEmail = env.BOARD_OWNER_EMAIL?.trim().toLowerCase() || undefined;
  return { dbPath, boardUrl, gateFile, gateAccountsFile, gateSecret, edgeSecret, linkTtlHours, ownerEmail, signin: { port: signinPort, hosts: hostList(env.BOARD_SIGNIN_HOSTS ?? `localhost:${signinPort},127.0.0.1:${signinPort}`) } };
}

function sessionsConfig(env: NodeJS.ProcessEnv): Config["sessions"] {
  const dir = env.PAPERCLIP_COMPANIES_DIR && existsSync(env.PAPERCLIP_COMPANIES_DIR) ? env.PAPERCLIP_COMPANIES_DIR : undefined;
  const file = env.COMPUTER_PROGRESS_TOKEN_FILE ?? "/run/secrets/computer_progress_token";
  const launcher = env.AIDENHQ_LAUNCHER_URL && existsSync(file) ? { url: env.AIDENHQ_LAUNCHER_URL.replace(/\/+$/, ""), token: readFileSync(file, "utf8").trim() } : undefined;
  return dir || launcher ? { dir, launcher } : undefined;
}

/** A sign-in proxy's endpoints and its auth token: off unless the token file exists. */
function signIn(file: string, url: string): { url: string; token: string } | undefined {
  return existsSync(file) ? { url: url.replace(/\/+$/, ""), token: readFileSync(file, "utf8").trim() } : undefined;
}

const hostList = (s: string) => s.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

function internalConfig(env: NodeJS.ProcessEnv): Config["internal"] {
  const file = env.BOARD_INTERNAL_TOKEN_FILE ?? "/run/secrets/board_internal_token";
  if (!existsSync(file)) return undefined;
  const token = readFileSync(file, "utf8").trim();
  if (token.length < 32) throw new Error(`${file}: token too short`);
  const port = Number(env.BOARD_INTERNAL_PORT ?? 3122);
  const hosts = hostList(env.BOARD_INTERNAL_HOSTS ?? `board:${port},localhost:${port},127.0.0.1:${port}`);
  return { port, hosts, token };
}

export function lanConfig(env: NodeJS.ProcessEnv): Config["lan"] {
  const hosts = hostList(env.BOARD_LAN_HOSTS ?? "aidenhq.local");
  return { port: Number(env.BOARD_LAN_PORT ?? 3121), hosts, url: (env.BOARD_LAN_URL || `http://${hosts[0]}`).replace(/\/+$/, ""), googleConnect: env.BOARD_GOOGLE_CONNECT === "1" };
}
