import pino from "pino";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKernelAuth } from "./kernel-auth.js";
import { createApp } from "./app.js";
import { appsApi } from "./fleet.js";
import { appWatchTick, type AppStatus } from "./app-watch.js";
import { maintainerIssues, maintainerTriageWake, maintainerWake, startMaintainer, triageLimits } from "./maintainer.js";
import { queueOwnerLine, startDetector } from "./fleet-ops.js";
import { createGrading } from "./grading.js";
import { loadConfig } from "./config.js";
import { pullUsage } from "./costs.js";
import { McpAuth } from "./mcpauth.js";
import { GoogleAuth } from "./google.js";
import { Paperclip } from "./paperclip.js";
import { kernelRecords } from "./records.js";
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
// The grading module owns the grade rows (modules/grading); the board reads them over HTTP.
const grading = createGrading();
// The kernel keeps every approval record; the board reads them with the gateway_board_key.
const records = kernelRecords(cfg.gateway && { url: (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/+$/, ""), token: cfg.gateway.token }, log);

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
// Fleet Ops' detector: only when the fleet-ops module is enabled (it sets FLEET_OPS_INTERVAL_MINUTES).
startDetector(paperclip, store, grading, log);
// The owner's app alerts (app-watch.ts): owner lines a channel collects through the kernel. apps-mcp unreachable: skipped.
const appWatch = () => void appWatchTick({ apps: () => appsApi<AppStatus[]>("/internal/status"), diskPct: async () => (await appsApi<{ disk_pct: number }>("/internal/host")).disk_pct, store, notify: (line) => queueOwnerLine(store, line) }).catch((err) => log.warn({ err: String(err) }, "app alerts tick failed"));
setInterval(appWatch, 2 * 60_000).unref();
// Event wake-ups for heartbeat agents (wake.ts).
startWake(paperclip, store, records, grading, log);
// The Maintainer's issue wake-up (maintainer.ts): off until the modules mount the webhook and github-mcp's token. Their
// files are read on every tick: setup writes the webhook after apply has started this board.
if (process.env.MAINTAINER_WEBHOOK_URL_FILE && process.env.MAINTAINER_ISSUES_TOKEN_FILE) {
  startMaintainer({ wiring: () => { const [fire, issues, triage] = [maintainerWake(), maintainerIssues(), maintainerTriageWake()]; return fire && issues ? { fire, issues, triage, limits: triageLimits() } : undefined; }, store, log });
} else log.info({}, "maintainer issue watcher off: MAINTAINER_WEBHOOK_URL_FILE or MAINTAINER_ISSUES_TOKEN_FILE is not set");
// Long-lived tasks move to a successor before Paperclip's fresh-session prompt outgrows the model's input (rollover.ts).
startRollover(paperclip, store, records, grading, log);
// The Costs tab: model calls with what OpenRouter billed for each, from the model gateway (kernel/src/gateway), agent
// computers' included (the launcher forwards their calls there).
pullUsage(cfg.gateway, store, log, 60_000, "gateway_usage_pulled_at");

const google = cfg.google && new GoogleAuth(cfg.google.url, cfg.google.token, log);
// The modules' sign-ins through their MCP proxies (board.signins).
const signIns = cfg.signIns.map(({ url, token, ...s }) => ({ ...s, auth: new McpAuth(s.label, url, token, log) }));
// Board sign-in: admins sign in on the kernel's admin listener and the kernel hands this origin its own session (kernel-auth.ts);
// the board opens no accounts file.
const kernelUrl = (process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/+$/, "");
if (!cfg.gateway) throw new Error("the board needs gateway_board_key: its key on the kernel's backplane (sign-in, records)");
const accounts = createKernelAuth({ kernel: { url: kernelUrl, token: cfg.gateway.token }, adminUrl: cfg.accounts.adminUrl });
// The runner's Engineer jobs, as it last reported them (shared by the listeners: it reports to the internal one).
const activity: { runner?: RunnerReport } = {};
// Open boards hear what agents change in their chats (watch.ts): one look at Paperclip every 2s while any board listens.
startWatch({ pc: paperclip, events: store.events, records, log, runner: () => activity.runner, session: liveActivity(cfg.sessions) });
const common = { grading, adminUrl: cfg.accounts.adminUrl, paperclip, store, log, staticDir: cfg.staticDir, timezone: cfg.timezone, workdays: cfg.workdays, slackTeams: cfg.slackTeams, lan: cfg.lan, activity, sessions: cfg.sessions, google, signIns, setupFlows: cfg.setupFlows, welcomeMarker: join(dirname(cfg.dbPath), "welcome-sent"), accounts, gateway: cfg.gateway, records, lane: process.env.CHAT_LANE_KEY_FILE ? { url: process.env.CHAT_LANE_URL ?? "http://lane:8089", token: readFileSync(process.env.CHAT_LANE_KEY_FILE, "utf8").trim() } : undefined };
// The board's https address (the front door) and phones on the home network; 3120 is the kernel's admin listener.
const lan = createApp({ ...common, allowedHosts: cfg.lan.hosts, mode: "lan" });
lan.listen(cfg.lan.port, "0.0.0.0", () => log.info({ port: cfg.lan.port, hosts: cfg.lan.hosts }, "LAN board listening"));

// The tasks bridge and the runner: bearer token, /internal/ only. Not published beyond loopback.
const internal = cfg.internal && createApp({ ...common, allowedHosts: cfg.internal.hosts, mode: "internal", internalToken: cfg.internal.token, reviewerKey: cfg.reviewerKey, operatorKey: cfg.operatorKey, gatewayKey: cfg.gateway?.token });
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
