import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { organisationPoints, type OrganisationPoint } from "./organisations.js";
import { setupFlowPoints, type SetupFlowPoint } from "./setup-flows.js";
import { WEEKDAYS, type Weekday } from "./dates.js";
import { pagePoints, type PagePoint } from "./module-views.js";

const SystemSchema = z.object({
  timezone: z.string().default("UTC"),
  /** The days Tomorrow rolls into Today. */
  workdays: z.array(z.enum(WEEKDAYS)).min(1).default(["monday", "tuesday", "wednesday", "thursday", "friday"]),
  paperclip: z.object({ company_id: z.string().uuid() }),
  /** Slack hosts → the ID the desktop app opens them with, so the board's Slack links open the app. */
  slack: z.object({ teams: z.record(z.string().regex(/^[a-z0-9.-]+\.slack\.com$/), z.string().regex(/^[TE][A-Z0-9]+$/)).default({}) }).default({ teams: {} }),
});

export interface Config {
  companyId: string;
  /** The model gateway (kernel/src/gateway): its billed ledger is pulled from `url`; `token` (gateway_board_key) both ways (the kernel's records). */
  gateway?: { url: string; token: string };
  timezone: string;
  workdays: Weekday[];
  /** Slack host → workspace or organization ID (E… on Enterprise Grid), for slack:// links. */
  slackTeams: Record<string, string>;
  dbPath: string;
  staticDir: string;
  logLevel: string;
  /**
   * The board's listener (3121): its https address behind the front door, and phones on the home network, under these host
   * names; signed-in admins only. `url`: the board's https address (BOARD_LAN_URL).
   */
  lan: { port: number; hosts: string[]; url: string };
  /**
   * The listener for the tasks bridge and the runner, with a bearer token: off unless the
   * token file exists.
   */
  internal?: { port: number; hosts: string[]; token: string };
  /** google-workspace-mcp's sign-in endpoints: off unless the token file exists. */
  google?: { url: string; token: string };
  /** The modules' board.signins (config/points/board.json): each one whose `<id>_auth_token` is mounted. */
  signIns: SignInPoint[];
  setupFlows: { flows: (SetupFlowPoint & { token?: string })[] };
  /** Organisations that run internal apps (modules/marketplace.json, compiled with each client's module secret). */
  organisations: OrganisationPoint[];
  /** The modules' Fleet pages (board.pages, module-views.ts). */
  pages: PagePoint[];
  /** Where Paperclip keeps its Codex session logs (read-only mount), and the computer launcher for agents in their own computers. */
  sessions?: { dir?: string; launcher?: { url: string; token: string } };
  /** The kernel's admin listener at its front door (AIDENHQ_ADMIN_URL): sign-in, the handoff to the board, admin links. */
  accounts: { adminUrl: string };
}

/** A key file's value, at least 32 characters, else undefined (not configured). */
function keyFile(f: string): string | undefined {
  const k = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  return k.length >= 32 ? k : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const system = SystemSchema.parse(parseYaml(readFileSync(env.BOARD_SYSTEM_CONFIG ?? "/config/system.yaml", "utf8")));
  return {
    companyId: system.paperclip.company_id,
    timezone: system.timezone,
    workdays: system.workdays,
    slackTeams: system.slack.teams,
    dbPath: env.BOARD_DB ?? "/data/board/board.sqlite",
    staticDir: env.BOARD_STATIC_DIR ?? new URL("../web", import.meta.url).pathname,
    logLevel: env.LOG_LEVEL ?? "info",
    lan: lanConfig(env),
    internal: internalConfig(env),
    google: signIn(env.GOOGLE_AUTH_TOKEN_FILE ?? "/run/secrets/google_auth_token", env.GOOGLE_WORKSPACE_URL ?? "http://google-workspace-mcp:8081"),
    signIns: signInPoints(env.BOARD_POINTS_FILE ?? "/config/points/board.json", env.BOARD_SECRETS_DIR ?? "/run/secrets"),
    organisations: organisationPoints(env.BOARD_POINTS_FILE ?? "/config/points/board.json"),
    pages: pagePoints(env.BOARD_POINTS_FILE ?? "/config/points/board.json"),
    setupFlows: { flows: setupFlowPoints(env.BOARD_POINTS_FILE ?? "/config/points/board.json", env.BOARD_SECRETS_DIR ?? "/run/secrets") },
    sessions: sessionsConfig(env),
    gateway: env.AIDENHQ_GATEWAY_URL && keyFile(env.GATEWAY_BOARD_KEY_FILE ?? "/run/secrets/gateway_board_key") ? { url: env.AIDENHQ_GATEWAY_URL.replace(/\/+$/, ""), token: keyFile(env.GATEWAY_BOARD_KEY_FILE ?? "/run/secrets/gateway_board_key")! } : undefined,
    accounts: accountsConfig(env),
  };
}

function accountsConfig(env: NodeJS.ProcessEnv): Config["accounts"] {
  return { adminUrl: (env.AIDENHQ_ADMIN_URL || "http://localhost:3120").replace(/\/+$/, "") };
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

/** A paste field (a module secret's `setup:`): the board shows the label and help and checks the pattern; the kernel checks again. */
export interface SetupField { secret: string; label: string; pattern: string; help?: string }

/**
 * A board.signins contribution (modules/board/schemas/signins.json), with the proxy's base URL and its auth token. `fields`: the
 * per-install values its Connect asks for first.
 */
export interface SignInPoint { id: string; label: string; connect: string; callback: string; mode: "redirect" | "device"; httpsOnly: boolean; missing: string; stopped: string; fields: SetupField[]; url: string; token: string }

/** The compiled board.signins: each needs its module's `<id>_auth_token` mounted on the board, or it is off. */
export function signInPoints(file: string, secrets: string): SignInPoint[] {
  const list: { id: string; module: string; label: string; status_url: string; connect_url: string; callback: string; mode?: "redirect" | "device"; https_only?: boolean; missing: string; stopped: string; fields?: SetupField[] }[] = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).signins ?? []) : [];
  return list.flatMap((s) => {
    // Only its own token (<id>_auth_token goes to status_url) and paths: /<id>/connect, /<id>/callback or one bare /callback.
    if (s.id !== s.module) throw new Error(`board.signins ${s.id}: contributed by ${s.module}; a module's sign-in id is its own name`);
    if (s.id === "google" || s.connect_url !== `/${s.id}/connect` || ![`/${s.id}/callback`, "/callback"].includes(s.callback) || list.filter((x) => x.callback === s.callback).length > 1) throw new Error(`board.signins ${s.id}: its paths must be /${s.id}/connect and /${s.id}/callback (or one module's /callback)`);
    const auth = signIn(`${secrets}/${s.id}_auth_token`, s.status_url.slice(0, -"/status".length).replace(/\/auth$/, ""));
    return auth ? [{ id: s.id, label: s.label, connect: s.connect_url, callback: s.callback, mode: s.mode ?? "redirect", httpsOnly: Boolean(s.https_only), missing: s.missing, stopped: s.stopped, fields: s.fields ?? [], ...auth }] : [];
  });
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
  return { port: Number(env.BOARD_LAN_PORT ?? 3121), hosts, url: (env.BOARD_LAN_URL || `http://${hosts[0]}`).replace(/\/+$/, "") };
}
