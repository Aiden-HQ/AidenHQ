import pino from "pino";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKernelAuth } from "./kernel-auth.js";
import { createApp } from "./app.js";
import { appsApi } from "./fleet.js";
import { appWatchTick, type Alert, type AppStatus } from "./app-watch.js";
import { ownerAlert, startNotify } from "./notify.js";
import { createGrading } from "./grading.js";
import { createViewHost, pagePoints, readPoints } from "./module-views.js";
import { loadConfig } from "./config.js";
import { pullUsage } from "./costs.js";
import { McpAuth } from "./mcpauth.js";
import { GoogleAuth } from "./google.js";
import { Paperclip } from "./paperclip.js";
import { kernelRecords } from "./records.js";
import { kernelFlow } from "./flow.js";
import { kernelSearch } from "./search.js";
import { cachedActivity, kernelWork, liveRunsOf } from "./runs.js";
import { weekdayOf } from "./dates.js";
import { convertLegacyRecurring, reapRecurring } from "./recurring.js";
import { Store, localDate } from "./store.js";
import { kernelStates } from "./task-state.js";
import { startWatch } from "./watch.js";
import { liveActivity } from "./live-activity.js";
import { kernelSessions } from "./sessions.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: { paths: ["authorization", "*.authorization", "key", "*.key"], censor: "[redacted]" }, base: { svc: "board" } });
const store = new Store(cfg.dbPath);
// The grading module owns the grade rows (modules/grading); the board reads them over HTTP.
const grading = createGrading();
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/+$/, "");
if (!cfg.gateway) throw new Error("the board needs gateway_board_key: its key on the kernel's backplane (Paperclip, sign-in, records)");
// Paperclip, as the owner, only through the kernel (it alone holds the owner key).
const paperclip = new Paperclip(kernelUrl, cfg.companyId, cfg.gateway.token);
// The kernel keeps every approval record; the board reads them with the gateway_board_key.
const records = kernelRecords({ url: kernelUrl, token: cfg.gateway.token }, log);
// The kernel's jobs (every agent run is one): the run pages and run links.
const work = kernelWork({ url: kernelUrl, token: cfg.gateway.token });
// Each task's one state (the kernel's /v1/tasks/state): every view shows it.
const taskStates = kernelStates({ url: kernelUrl, token: cfg.gateway.token });
// The Flow page's reads (the kernel's /v1/flow).
const flow = kernelFlow({ url: kernelUrl, token: cfg.gateway.token });
// The Tasks page's search (the warehouse module's, through the kernel's /v1/board-api).
const search = kernelSearch({ url: kernelUrl, token: cfg.gateway.token });

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
// The board's owner alerts go through the kernel's queue to owner-channel's notify (notify.ts).
if (cfg.gateway) startNotify({ url: (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/+$/, ""), token: cfg.gateway.token }, log);
// The app alerts (app-watch.ts): a task for the chief of staff through the kernel, never the owner. apps-mcp unreachable: skipped.
const fileAlert = async (a: Alert) => {
  const r = await fetch(`${kernelUrl}/v1/board-tasks`, { method: "POST", headers: { authorization: `Bearer ${cfg.gateway!.token}`, "content-type": "application/json" }, body: JSON.stringify({ ...a, role: "fleet-admin" }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`the kernel answered ${r.status} filing an app alert`);
};
const appWatch = () => void appWatchTick({ apps: () => appsApi<AppStatus[]>("/internal/status"), diskPct: async () => (await appsApi<{ disk_pct: number }>("/internal/host")).disk_pct, store, file: fileAlert }).catch((err) => log.warn({ err: String(err) }, "app alerts tick failed"));
setInterval(appWatch, 2 * 60_000).unref();
// A repeating task that is closed, reassigned or deleted stops repeating (recurring.ts).
setInterval(() => void reapRecurring(paperclip, store, log).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "recurring check failed")), 60_000).unref();
// Schedules from before routines become routines once (recurring.ts); until it succeeds the old rows stay.
void convertLegacyRecurring(paperclip, store, cfg.timezone, log).catch((err) => log.warn({ err: String(err).slice(0, 300) }, "recurring tasks not converted yet"));
// The Costs tab: model calls with what OpenRouter billed for each, from the model gateway (kernel/src/gateway), agent
// computers' included (the launcher forwards their calls there).
pullUsage(cfg.gateway, store, log, 60_000, "gateway_usage_pulled_at");

const google = cfg.google && new GoogleAuth(cfg.google.url, cfg.google.token, log);
// The modules' sign-ins through their MCP proxies (board.signins).
const signIns = cfg.signIns.map(({ url, token, ...s }) => ({ ...s, auth: new McpAuth(s.label, url, token, log) }));
// Board sign-in: admins sign in on the kernel's admin listener and the kernel hands this origin its own session (kernel-auth.ts);
// the board opens no accounts file.
const accounts = createKernelAuth({ kernel: { url: kernelUrl, token: cfg.gateway.token }, adminUrl: cfg.accounts.adminUrl, log });
// Read on every use: an apply that adds, changes or removes a module's page rewrites the points file without restarting the board.
const pointsFile = process.env.BOARD_POINTS_FILE ?? "/config/points/board.json";
const views = createViewHost({ kernel: cfg.gateway && { url: kernelUrl, token: cfg.gateway.token }, pages: () => pagePoints(pointsFile), reads: () => readPoints(pointsFile) });
// Sessions (sessions.ts): the kernel's session rows; the launcher's session key opens only a lease's terminal and phone UI.
const sessionKey = process.env.COMPUTER_SESSION_KEY_FILE ?? "/run/secrets/computer_session_key";
const terminals = { kernel: kernelSessions({ url: kernelUrl, token: cfg.gateway.token }), launcher: process.env.AIDENHQ_LAUNCHER_URL && existsSync(sessionKey) ? { url: process.env.AIDENHQ_LAUNCHER_URL.replace(/\/+$/, ""), key: readFileSync(sessionKey, "utf8").trim() } : undefined };
const common = { terminals, grading, views, adminUrl: cfg.accounts.adminUrl, paperclip, store, log, staticDir: cfg.staticDir, timezone: cfg.timezone, workdays: cfg.workdays, slackTeams: cfg.slackTeams, lan: cfg.lan, sessions: cfg.sessions, google, signIns, setupFlows: cfg.setupFlows, organisations: cfg.organisations, welcomeMarker: join(dirname(cfg.dbPath), "welcome-sent"), accounts, gateway: cfg.gateway, records, work, taskStates, flow, search, lane: process.env.AIDENHQ_GRANTS_FILE ? { grantsFile: process.env.AIDENHQ_GRANTS_FILE } : undefined };
// The board's https address (the front door) and phones on the home network; 3120 is the kernel's admin listener.
const lan = createApp({ ...common, allowedHosts: cfg.lan.hosts, mode: "lan" });
lan.listen(cfg.lan.port, "0.0.0.0", () => log.info({ port: cfg.lan.port, hosts: cfg.lan.hosts }, "LAN board listening"));
// Open boards hear what agents change in their chats (watch.ts): one look at Paperclip every 2s while any board listens. The
// watch also runs the board's sweep (new tasks placed, crew parts closed, settled tasks back), once at start-up as catch-up.
const watchedActivity = cachedActivity(work);
startWatch({ pc: paperclip, liveRuns: async () => liveRunsOf(await watchedActivity()), states: taskStates, events: store.events, records, log, session: liveActivity(cfg.sessions), sweep: lan.sweep });

// The tasks bridge and the kernel: bearer token, /internal/ only. Not published beyond loopback.
const internal = cfg.internal && createApp({ ...common, allowedHosts: cfg.internal.hosts, mode: "internal", internalToken: cfg.internal.token, gatewayKey: cfg.gateway?.token });
if (internal && cfg.internal) internal.listen(cfg.internal.port, "0.0.0.0", () => log.info({ port: cfg.internal!.port }, "internal API listening"));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    store.events.close();
    lan.close();
    internal?.close();
    store.close();
    process.exit(0);
  });
}
