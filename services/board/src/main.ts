import pino from "pino";
import { readFileSync } from "node:fs";
import { createAccounts, readGate } from "./accounts.js";
import { createApp } from "./app.js";
import { routineWake, webhookWake, type Manifest } from "./app-access.js";
import { appsApi } from "./fleet.js";
import { appWatchTick, type AppStatus } from "./app-watch.js";
import { createSigninServer } from "./signin.js";
import { queueOwnerLine, startDetector } from "./fleet-ops.js";
import { backfillEscalatedDelegators, settleClosedGrades } from "./grades.js";
import { loadConfig } from "./config.js";
import { pullUsage } from "./costs.js";
import { McpAuth } from "./mcpauth.js";
import { GoogleAuth } from "./google.js";
import { Paperclip } from "./paperclip.js";
import { weekdayOf } from "./recurrence.js";
import { Store, localDate } from "./store.js";
import { startWake } from "./wake.js";
import { startRollover } from "./rollover.js";
import { startWatch } from "./watch.js";
import { liveActivity } from "./live-activity.js";
import type { RunnerReport } from "./activity.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: { paths: ["authorization", "*.authorization", "key", "*.key"], censor: "[redacted]" }, base: { svc: "board" } });
const store = new Store(cfg.dbPath);
const paperclip = new Paperclip(cfg.paperclipUrl, cfg.companyId, cfg.boardKey);

/** Every minute: Tomorrow → Today at the start of a workday, then any scheduled moves that are due, on top. */
function rollover() {
  try {
    const today = localDate(cfg.timezone);
    const moved = store.rollover(today, cfg.workdays.includes(weekdayOf(today)));
    if (moved) log.info({ moved }, "rollover: Tomorrow → Today");
    const scheduled = store.applySchedules(today);
    if (scheduled.length) log.info({ moved: scheduled.length }, "scheduled moves applied");
  } catch (err) {
    log.error({ err: String(err) }, "rollover failed");
  }
}
rollover();
setInterval(rollover, 60_000).unref();
/**
 * Every five minutes: a graded task closed before the grader settled it (a cancel in Paperclip itself) has nothing to grade,
 * and an escalated row that saved no delegators gets its task's creator saved.
 */
async function settleGrades() {
  try {
    const settled = await settleClosedGrades(store.grades, (id) => paperclip.issue(id));
    if (settled.length) log.info({ tasks: settled.map((g) => g.issueId), reason: settled[0]!.closedReason }, "graded rows settled on a closed task");
  } catch (err) {
    log.warn({ err: String(err) }, "settling closed grades failed");
  }
  try {
    const filled = await backfillEscalatedDelegators(store.grades, (id) => paperclip.issue(id));
    if (filled.length) log.info({ tasks: filled.map((g) => g.issueId) }, "escalated grades given their creator as delegator");
  } catch (err) {
    log.warn({ err: String(err) }, "backfilling escalated delegators failed");
  }
}
setInterval(() => void settleGrades(), 5 * 60_000).unref();
void settleGrades();
// Fleet Ops' detector: only when the fleet-ops module is enabled (it sets FLEET_OPS_INTERVAL_MINUTES).
startDetector(paperclip, store, log);
// The owner's app alerts (app-watch.ts): owner lines a channel collects through the kernel. apps-mcp unreachable: skipped.
const appWatch = () => void appWatchTick({ apps: () => appsApi<AppStatus[]>("/internal/status"), diskPct: async () => (await appsApi<{ disk_pct: number }>("/internal/host")).disk_pct, store, notify: (line) => queueOwnerLine(store, line) }).catch((err) => log.warn({ err: String(err) }, "app alerts tick failed"));
setInterval(appWatch, 2 * 60_000).unref();
// Event wake-ups for heartbeat agents (wake.ts): on unless the instance setting wake_ups is off.
startWake(paperclip, store, log);
// Long-lived tasks move to a successor before Paperclip's fresh-session prompt outgrows the model's input (rollover.ts).
startRollover(paperclip, store, log);
// The Costs tab: model calls with what OpenRouter billed for each, from the model gateway (kernel/src/gateway), agent
// computers' included (the launcher forwards their calls there).
pullUsage(cfg.gateway, store, log, 60_000, "gateway_usage_pulled_at");

const google = cfg.google && new GoogleAuth(cfg.google.url, cfg.google.token, log);
// Glean; Grafana and ClickHouse for the runner's Engineer jobs; Jira through Atlassian's remote MCP server.
const glean = cfg.glean && new McpAuth("Glean", cfg.glean.url, cfg.glean.token, log);
const grafana = cfg.grafana && new McpAuth("Grafana", cfg.grafana.url, cfg.grafana.token, log);
const clickhouse = cfg.clickhouse && new McpAuth("ClickHouse", cfg.clickhouse.url, cfg.clickhouse.token, log);
const jira = cfg.jira && new McpAuth("Jira", cfg.jira.url, cfg.jira.token, log);
// Board accounts: Better Auth in the kernel's accounts file (mounted); every board route needs a signed-in admin, who signs in
// on the kernel's admin listener (the same session cookie).
const accounts = await createAccounts({ dbPath: cfg.accounts.dbPath, hosts: [...cfg.lan.hosts, ...cfg.accounts.signin.hosts], adminUrl: cfg.accounts.adminUrl, gate: () => readGate(cfg.accounts.gateFile), gateAccountsFile: cfg.accounts.gateAccountsFile, gateSecret: cfg.accounts.gateSecret, linkTtlHours: cfg.accounts.linkTtlHours, ownerEmail: cfg.accounts.ownerEmail,
  // Sign-in alerts and new-sign-in notices: the owner-line queue the owner channel collects (/internal/owner/grades).
  notify: (line) => queueOwnerLine(store, line),
  // Each shared app's manifest at its running commit (apps-mcp), and the app-request routine's webhook (setup writes its files).
  manifest: (app) => appsApi<Manifest>(`/internal/apps/${encodeURIComponent(app)}/manifest`, undefined, { auth: true }),
  wake: webhookWake(process.env.APP_REQUEST_WEBHOOK_URL_FILE ?? "/run/secrets/app_request_webhook_url", process.env.APP_REQUEST_WEBHOOK_SECRET_FILE ?? "/run/secrets/app_request_webhook_secret", log),
  // In-app feedback: the app's own "App feedback: <app>" routine (compiled from its registry entry), run by its title.
  feedbackWake: routineWake(paperclip, log),
  log });
// The runner's Engineer jobs, as it last reported them (shared by the listeners: it reports to the internal one).
const activity: { runner?: RunnerReport } = {};
// Open boards hear what agents change in their chats (watch.ts): one look at Paperclip every 2s while any board listens.
startWatch({ pc: paperclip, events: store.events, log, runner: () => activity.runner, session: liveActivity(cfg.sessions) });
const common = { adminUrl: cfg.accounts.adminUrl, paperclip, store, log, staticDir: cfg.staticDir, timezone: cfg.timezone, workdays: cfg.workdays, slackTeams: cfg.slackTeams, lan: cfg.lan, activity, sessions: cfg.sessions, google, glean, grafana, clickhouse, jira, accounts, gateway: cfg.gateway, kernel: cfg.gateway && { url: (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/+$/, ""), token: cfg.gateway.token }, lane: process.env.CHAT_LANE_KEY_FILE ? { url: process.env.CHAT_LANE_URL ?? "http://lane:8089", token: readFileSync(process.env.CHAT_LANE_KEY_FILE, "utf8").trim() } : undefined };
// The board's https address (the front door) and phones on the home network; 3120 is the kernel's admin listener.
const lan = createApp({ ...common, allowedHosts: cfg.lan.hosts, mode: "lan" });
lan.listen(cfg.lan.port, "0.0.0.0", () => log.info({ port: cfg.lan.port, hosts: cfg.lan.hosts }, "LAN board listening"));

// The tasks bridge and the runner: bearer token, /internal/ only. Not published beyond loopback.
const internal = cfg.internal && createApp({ ...common, allowedHosts: cfg.internal.hosts, mode: "internal", internalToken: cfg.internal.token, reviewerKey: cfg.reviewerKey, operatorKey: cfg.operatorKey, gatewayKey: cfg.gateway?.token });
// The gate's sign-in listener (3129): Better Auth's sign-in endpoints and pages only, never a board route.
const signin = createSigninServer({ accounts, hosts: cfg.accounts.signin.hosts, gate: () => readGate(cfg.accounts.gateFile), log });
void accounts.syncGate();
// Apps come and go with applies (config/gate.json): a removed app's rows leave the gate's map within a minute; manifests
// refresh, undelivered request wakes and a failed write retry on the same beat.
setInterval(() => void accounts.syncGate(), 60_000).unref();
signin.listen(cfg.accounts.signin.port, "0.0.0.0", () => log.info({ port: cfg.accounts.signin.port, hosts: cfg.accounts.signin.hosts }, "sign-in listener up"));
if (internal && cfg.internal) internal.listen(cfg.internal.port, "0.0.0.0", () => log.info({ port: cfg.internal!.port }, "internal API listening"));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    store.events.close();
    lan.close();
    internal?.close();
    signin.close();
    accounts.close();
    store.close();
    process.exit(0);
  });
}
