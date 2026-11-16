// jira-mcp: see src/app.ts. Configuration from the module's compose service.
import { existsSync, readFileSync } from "node:fs";
import pino from "pino";
import { kernelJwks } from "./aidenhq-sdk/caller.js";
import { createApp } from "./app.js";
import { SourceStore } from "./source-store.js";
import { startConfluenceSync } from "./confluence.js";
import { startSync } from "./sources.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: "jira-mcp" }, redact: ["authorization", "*.authorization", "token", "*.token", "code"] });
const readToken = (file: string | undefined) => (file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined);
const port = Number(process.env.PORT ?? 8091);
const siteUrl = process.env.JIRA_URL;
if (!siteUrl) throw new Error("JIRA_URL is required (the jira_url setting, e.g. https://your-company.atlassian.net)");

const http = createApp({
  upstreamUrl: process.env.ATLASSIAN_MCP_URL || "https://mcp.atlassian.com/v2/mcp?tools=all",
  siteUrl,
  stateDir: process.env.JIRA_STATE_DIR ?? "/state",
  inboundToken: readToken(process.env.MCP_TOKEN_FILE),
  authToken: readToken(process.env.JIRA_AUTH_TOKEN_FILE),
  jwks: kernelJwks(),
  log,
});

// src_jira (shared sources): issues and sprints into the warehouse through the same sign-in. Off until the warehouse
// password (WAREHOUSE_PASSWORD_FILE) is there.
const sources = SourceStore.fromEnv("jira");
if (sources) {
  startSync(sources, http.callJira, siteUrl, log, { projects: (process.env.HISTORY_PROJECTS ?? "").split(",").map((p) => p.trim()).filter(Boolean), days: Number(process.env.HISTORY_DAYS) || 365 });
  startConfluenceSync(sources, http.callJira, siteUrl, log);
}
else log.warn("warehouse not configured; src_jira is off");

http.listen(port, "0.0.0.0", () => log.info({ port, site: siteUrl }, "jira-mcp listening"));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => http.close(() => process.exit(0)));
