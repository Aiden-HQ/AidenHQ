#!/usr/bin/env node
// The kernel host service, systemd user unit aidenhq-kernel (ops/units/aidenhq-kernel.service).
// - The model gateway (gateway/lib.ts; CI credentials gateway/ci.ts): the only holder of the model key (read from the vault at
//   each call), on host loopback and the backplane's gateway address (8201), and with CI on, on the CI runners' bridge. Runner
//   jobs' tool calls (their jobcaps) come in on 8201 too, the one port their jail reaches. Fails closed: if it is down, no
//   model or tool call is made.
// - The backplane listener (10.231.0.1:3130, backplane.ts): the tool proxy in front of every connection, caller identity
//   and assertions, the control plane as the calling agent, and the records of every write (writes.ts, kernel.db).
// - Jobs (jobs.ts, sandbox.ts): engine runs in the sandbox, detached, so a restart (KillMode=process) leaves them running;
//   this process adopts them at start and stops following them (offsets saved) on SIGTERM, SIGINT or SIGUSR2.
// - The admin listener (127.0.0.1:3120, admin.ts): admins' sign-in (accounts.ts, data/kernel/auth/) and the approval pages.
// - The sign-in listener (127.0.0.1:3129, signin.ts): the gate's half of shared apps' sign-in (Better Auth's steps, handoffs,
//   app access). The kernel is the only process that opens the accounts file (lean 3g).
import http from "node:http";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir, dataDir, env, repo, secret } from "./env.ts";
import { INSTALL_CAP, createGateway, watched } from "./gateway/lib.ts";
import { createAdmin, type SetupField } from "./admin.ts";
import { createAuthApi } from "./auth-api.ts";
import { checkModel, exchange, readiness, startPkce } from "./openrouter-pkce.ts";
import { agentSetup, composeRecreate, createModuleSecrets, vaultWriter } from "./module-secrets.ts";
import { doorSource, readGate } from "./accounts.ts";
import { routineWake, webhookWake, type Manifest } from "./app-access.ts";
import { createSignin } from "./signin.ts";
import { createAsserter, loadKey } from "./assert.ts";
import { createBackplane } from "./backplane.ts";
import { createBrake } from "./brake.ts";
import { createChannels, type Api, type ModulesFile } from "./channels.ts";
import { checksFile, createChecks } from "./checks.ts";
import { createAsCaller, createCp } from "./cp.ts";
import { createIdentity, type Connection, type Grant, type Jobcap } from "./identity.ts";
import { createAdvisories } from "./loader/advisories.ts";
import { hostFetch } from "./loader/sources.ts";
import { createResolver } from "./net.ts";
import { createProxy } from "./proxy.ts";
import { openRecords } from "./records.ts";
import { createReviews, type ReviewerSlot } from "./reviews.ts";
import { mintToken } from "./gateway/token.ts";
import { createWrites, type Kind } from "./writes.ts";
import { taskRoutineCap } from "./tier.ts";
import { KERNEL_KINDS, LOCAL_ORG, raiseCapCard } from "./kinds.ts";
import { createJobs, dispatchesFrom } from "./jobs.ts";
import { jailProblem } from "./sandbox.ts";
import { sandboxConfig } from "./sandbox-config.ts";
import { createCertWatch } from "./front-door.ts";
import { BOX_EXEC_WRAP } from "../../services/computer/lib.mjs";

const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(fields));

const controlUrl = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
const launcherUrl = env("AIDENHQ_LAUNCHER_URL", "http://10.231.0.1:8199"); // names agent computers' run tokens (/whoami)
const grantsFile = path.join(configDir, "grants", "grants.json");
const grantsTable = watched(grantsFile, (j) => j as { agents?: Record<string, Grant> } & Record<string, unknown>, {});
const connections = watched(path.join(configDir, "kernel", "connections.json"), (j) => j as Record<string, Connection>, {});
// The control plane with the board key (only the kernel holds it): the task a run is on (its run record), and a record's task.
const cpApi = (p: string, init: RequestInit = {}) => fetch(new URL(p, controlUrl), { ...init, headers: { authorization: `Bearer ${secret("paperclip_board_key")}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) });
async function runTask(runId: string): Promise<string | undefined> {
  const res = await cpApi(`/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return undefined;
  const r = (await res.json()) as { issueId?: string; contextSnapshot?: { issueId?: string } };
  return r.issueId ?? r.contextSnapshot?.issueId ?? undefined;
}
// Modules with kernel roles, a privileged entry, a token of their own or a channel (compile).
const modulesFile = watched(path.join(configDir, "kernel", "modules.json"), (j) => j as ModulesFile & { reviewer?: ReviewerSlot; setup?: SetupField[]; services?: Record<string, string[]>; mounts?: Record<string, string[]> }, {});
const whoami = createIdentity({
  grants: () => grantsTable().agents ?? {}, connections, modules: () => modulesFile().modules ?? {},
  jobcaps: watched(path.join(configDir, "jobcaps.json"), (j) => j as Record<string, Jobcap>, {}), // runner jobs' reads (compile)
  secret, controlUrl, launcherUrl, runTask,
});
const asserter = createAsserter(loadKey(path.join(dataDir, "kernel", "caller-key.pem")));
const resolver = createResolver({ project: env("COMPOSE_PROJECT_NAME", "aidenhq") });
// A record's task: still open, and the notices on it (written with the board key, as the board's approval notices are).
const issueOf = async (task: string) => { const r = await cpApi(`/api/issues/${encodeURIComponent(task)}`); return r.ok ? ((await r.json()) as { id: string; identifier?: string; status?: string; parentId?: string | null }) : undefined; };
const cpJson = async (p: string) => { const r = await cpApi(p); if (!r.ok) throw new Error(`control plane GET ${p} → ${r.status}`); return r.json(); };
const cpTrace = { issue: (id: string) => cpJson(`/api/issues/${encodeURIComponent(id)}`), run: (id: string) => cpJson(`/api/heartbeat-runs/${encodeURIComponent(id)}`) };
const runIssue = new Map<string, string | null>(); // a run's issue never changes
const onTask = {
  open: async (task: string) => { const i = await issueOf(task); return Boolean(i) && !["done", "cancelled"].includes(String(i!.status)); },
  parent: async (task: string) => (await issueOf(task))?.parentId ?? undefined,
  notify: async (task: string, body: string) => { const r = await cpApi(`/api/issues/${encodeURIComponent(task)}/comments`, { method: "POST", body: JSON.stringify({ body }) }); if (!r.ok) log("notice failed", { task, status: r.status }); },
  // The cap of a routine whose run started the task's chain, traced as the runner traces it; a read that fails is "off".
  routineCap: (task: string) => taskRoutineCap(cpTrace, task, grantsTable().routines as Record<string, string> | undefined, runIssue),
};
const records = openRecords(path.join(dataDir, "kernel", "kernel.db"));
// The modules' kinds (compile) and the kernel's own and the runner's (kinds.ts).
const moduleKinds = watched(path.join(configDir, "kernel", "writes.json"), (j) => j as Record<string, Kind>, {});
const registry = () => ({ ...moduleKinds(), ...KERNEL_KINDS });
let replay: (r: never) => Promise<{ ok: boolean; text: string }> = async () => ({ ok: false, text: "the proxy isn't up" });
// The product and instance repositories (owner/name), as setup recorded them in .env: runner kinds touching them get the
// kernel's own floors and refusals (kinds.ts runnerFacts), whatever the runner's plan says. Either unknown: every runner
// kind is the owner's after the reviewer (fails closed).
// The agents org, as the runner reads it: AIDENHQ_GITHUB_AGENTS_ORG, else the instance's github_agents_org or aidenhq-<instance_name>.
const instanceSettings = (() => { try { return readFileSync(path.join(env("AIDENHQ_INSTANCE_DIR", "").replace(/^~(?=\/)/, process.env.HOME ?? ""), "instance.yaml"), "utf8"); } catch { return ""; } })();
const setting = (k: string) => new RegExp(`^\\s+${k}:\\s*["']?([\\w.-]+)`, "m").exec(instanceSettings)?.[1];
const agentsOrg = env("AIDENHQ_GITHUB_AGENTS_ORG") || setting("github_agents_org") || (setting("instance_name") ? `aidenhq-${setting("instance_name")}` : undefined);
// With codehost-local enabled (the compiled catalog), its org `local` is an agents org too (docs/design/codehost-local.md §2).
const localHost = watched(path.join(configDir, "modules.json"), (j) => Array.isArray(j) && j.some((m: { name?: string; enabled?: boolean }) => m?.name === "codehost-local" && m.enabled === true), false);
const baseRepos = { product: env("AIDENHQ_PRODUCT_REPO") || undefined, instance: env("AIDENHQ_INSTANCE_REPO") || undefined, agentsOrg };
const repos = () => ({ ...baseRepos, agentsOrgs: [agentsOrg, ...(localHost() ? [LOCAL_ORG] : [])].filter((o): o is string => Boolean(o)) });
log(baseRepos.product && baseRepos.instance ? "runner kinds' repositories" : "runner kinds: AIDENHQ_PRODUCT_REPO or AIDENHQ_INSTANCE_REPO isn't set, so every runner write is the owner's", repos());
// The bound reviewer module (reviewer@1): its model calls go through this gateway on a reviewer token minted per review.
const reviews = createReviews({ slot: () => modulesFile().reviewer, secret, resolver, log, modelToken: (component) => mintToken(secret("gateway_job_secret"), { kind: "reviewer", component, ttlMs: 3600_000 }) });
let raiseCap: (r: { scope: string; agentId: string; subject: string; cap: number; spent: number; to: number }) => Promise<string> = async () => { throw new Error("the model gateway isn't up"); };
const writes = createWrites({
  records, registry, connections, secret, resolver, reviews, onTask, log, replay: (r) => replay(r as never), repos,
  autonomy: () => (["off", "tier0", "full"].includes(grantsTable().autonomy as string) ? grantsTable().autonomy : "off") as never,
  // An approved raise_cap: the gateway's cap for that scope and subject becomes the card's doubled cap.
  native: { "kernel.raise_cap": async (r) => ({ ok: true, text: await raiseCap(r.args as never) }) },
});
const proxy = createProxy({ whoami, connections, asserter, resolver, secret, writes, log });
replay = proxy.replay as never;
// JSON both ways: the control plane as the owner (only the kernel holds the board key), and the board's internal listener with
// the kernel's key (gateway_board_key: successors and the owner's notices).
const asApi = (call: (p: string, init: RequestInit) => Promise<Response>): Api => async (method, p, body) => {
  const r = await call(p, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ownerApi = asApi(cpApi);
const boardApi = asApi((p, init) => fetch(new URL(p, env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122")), { ...init, headers: { authorization: `Bearer ${secret("board_internal_token")}`, "x-gateway-key": secret("gateway_board_key"), "content-type": "application/json" }, signal: AbortSignal.timeout(20_000) }));
const channels = createChannels({ db: records.db, records, writes, board: boardApi, owner: ownerApi, modules: modulesFile, resetLinks: () => accounts?.takeResetLinks() ?? [], log });
// Marketplace advisories (loader/advisories.ts): read at start, then whenever a day has passed or an apply rewrote the catalog.
const advisories = createAdvisories({ db: records.db, repo, catalog: path.join(configDir, "modules.json"), ownerLine: channels.ownerLine, log, ref: env("AIDENHQ_ADVISORY_REF", "main"), fetch: hostFetch(repo) });
setInterval(() => void advisories.tick(), 10 * 60_000).unref();
setTimeout(() => void advisories.tick(), 30_000).unref();
// The public front door's certificate (exposure public, compiled into config/exposure; the IP is the host's .env): hourly.
const certWatch = createCertWatch({
  ip: () => { try { return readFileSync(path.join(configDir, "exposure"), "utf8").trim() === "public" ? env("AIDENHQ_PUBLIC_IP") || undefined : undefined; } catch { return undefined; } },
  notify: channels.ownerLine,
});
setInterval(() => void certWatch.tick(), 3_600_000).unref();
setTimeout(() => void certWatch.tick(), 10 * 60_000).unref();
const brake = createBrake({ db: records.db, owner: ownerApi });
// The host sandbox as configured here (jobs run in their agents' computers; repo code the host runs itself, fast checks among
// it, runs in this sandbox). A known no-jail condition is fatal, with the reason in the journal: repo code must never share the
// host's network (every loopback service).
const sandbox = sandboxConfig(env);
const jailIssue = jailProblem(sandbox);
if (jailIssue) {
  log("ERROR: the host sandbox cannot be jailed here", { reason: jailIssue });
  process.exit(1);
}
const jobs = createJobs({
  db: records.db, cfg: sandbox, log, boxWrap: BOX_EXEC_WRAP,
  // The agents a module dispatches (compile: an agent runs on the engine runner, and this module holds kernel.jobs), by key.
  mayDispatch: dispatchesFrom(() => (modulesFile().modules ?? {}) as never, () => grantsTable().agents ?? {}),
  cp: {
    agent: async (id) => { const r = await cpApi(`/api/agents/${encodeURIComponent(id)}`); return r.ok ? ((await r.json()) as never) : undefined; },
    task: async (id) => { const r = await cpApi(`/api/issues/${encodeURIComponent(id)}`); return r.ok ? ((await r.json()) as never) : undefined; },
  },
});
jobs.adopt();
// A restart: the jobs go on for the next kernel (KillMode=process); this one stops following them, offsets saved.
for (const sig of ["SIGTERM", "SIGINT", "SIGUSR2"] as const) process.on(sig, () => { log("stopping: jobs left running for the next kernel", { signal: sig, jobs: jobs.running() }); jobs.detach(); process.exit(0); });
// The finish gate (checks.ts): modules' task.finish checks (compile), holds placed as the owner.
const checks = createChecks({ db: records.db, registry: checksFile(path.join(configDir, "kernel", "checks.json")), owner: ownerApi, secret, resolver, log, agentKey: (id) => grantsTable().agents?.[id]?.key, graded: (id) => grantsTable().agents?.[id]?.graded === true, pending: (task) => records.list(["review", "owner", "approved"], 100, { task }) });
// First-run setup (/setup): the keys the modules ask for go into the vault view (AIDENHQ_SECRETS_DIR) as new 0600 files renamed into place; the
// vault's recovery key waits there (ops/setup.sh --unattended moves it out of root's home) until the owner has seen it.
const secretsDir = env("AIDENHQ_SECRETS_DIR", "");
const firstRun = {
  ownerEmail: () => modulesFile().owner?.email || undefined,
  recoveryKey: () => (/^[0-9a-f-]{64,80}$/.test(secret("vault_recovery_key")) ? secret("vault_recovery_key") : ""),
  fields: () => modulesFile().setup ?? [], // the modules' provided secrets with `setup:` (compile)
  has: (name: string) => Boolean(secret(name)),
  save: vaultWriter(secretsDir),
  forgetRecoveryKey: () => rmSync(path.join(secretsDir, "vault_recovery_key"), { force: true }),
};
// The model step's record of whether the vault's model key last passed its check (model_ready, the first-run redirects).
const modelState = readiness({ get: secret, exists: (n) => existsSync(path.join(secretsDir, n)), save: firstRun.save });
// A module's declared setup secrets from the board (save_secret, setup_status): the same vault writes, then that module's
// services and every other one mounting the secret recreated in the checkout under the apply lock.
const moduleSecrets = createModuleSecrets({
  fields: firstRun.fields, has: firstRun.has, save: firstRun.save,
  services: (module) => { const s = modulesFile().services ?? {}; return Object.hasOwn(s, module) ? s[module] : undefined; },
  mounts: (secret) => { const m = modulesFile().mounts ?? {}; return Object.hasOwn(m, secret) ? m[secret]! : []; },
  recreate: composeRecreate({ dir: env("AIDENHQ_DIR", repo), composeFile: env("COMPOSE_FILE", "") }),
  log,
});
const backplane = createBackplane({ checks, whoami, asserter, grantsFile: grantsTable, log, writes, records, channels, brake, owner: ownerApi, modules: modulesFile, boardKey: () => secret("gateway_board_key"), reviews, runnerKey: () => secret("runner_writes_key"), reviewerKey: () => secret("reviewer_key"), jobs, advisories: advisories.list, accounts: createAuthApi({ accounts: () => accounts, whoami, boardKey: () => secret("gateway_board_key"), recoveryKeyWaiting: () => Boolean(firstRun.recoveryKey()), modelReady: modelState.ready, operatorKey: () => secret("board_operator_key"), secrets: moduleSecrets }), proxy: (req, res, c) => proxy(req, res, c!), cp: createCp({ whoami, asserter, controlUrl, launcherUrl, checks, log }) as never });
// The admin listener's accounts (data/kernel/auth/auth.db) and pages. Accounts not moved yet, or a malformed URL setting: the
// listener refuses while every other part of the kernel serves.
const urlOf = (v: string) => { try { return v ? new URL(v) : undefined; } catch { log("ignoring a malformed URL setting", { value: v.slice(0, 100) }); return undefined; } };
const adminUrl = urlOf(env("AIDENHQ_ADMIN_URL", ""));
const boardUrl = urlOf(env("BOARD_LAN_URL", ""));
// The front door's name with and without its port (proxies differ in the Host they pass on).
const loopback = env("AIDENHQ_ADMIN_HOSTS", "localhost:3120,127.0.0.1:3120").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const adminHosts = [...loopback, ...(adminUrl ? [adminUrl.host, adminUrl.hostname] : [])];
const adminOrigins = [...loopback.map((h) => `http://${h}`), ...(adminUrl ? [adminUrl.origin] : [])];
// The sign-in listener's own Host names (the gate calls it at 127.0.0.1:3129), and shared apps' config (scripts/edge.mjs).
const signinHosts = env("AIDENHQ_SIGNIN_HOSTS", "127.0.0.1:3129,localhost:3129").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const gateFile = path.join(configDir, "gate.json");
const gateInfo = () => readGate(gateFile);
const accountLog = { info: (o: object, m: string) => log(m, o as never), warn: (o: object, m: string) => log(m, o as never), error: (o: object, m: string) => log(m, o as never) };
// apps-mcp's internal API (the apps-platform module's service), with its internal token: a shared app's manifest.
const manifest = async (app: string): Promise<Manifest> => {
  const t = await resolver.resolve(`${env("AIDENHQ_APPS_INTERNAL_URL", "http://apps-mcp:8090")}/internal/apps/${encodeURIComponent(app)}/manifest`);
  const r = await fetch(`http://${t.host}:${t.port}${t.path}`, { headers: { authorization: `Bearer ${secret("apps_internal_token")}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`apps-mcp answered ${r.status}`);
  return (await r.json()) as Manifest;
};
const ttl = Number(env("AIDENHQ_LINK_TTL_HOURS", ""));
const accounts = await import("./accounts.ts").then((a) => a.openAccounts({
  dataDir, hosts: [...adminHosts, ...signinHosts], origins: adminUrl ? [adminUrl.origin] : [], ...(adminUrl ? { adminUrl: adminUrl.origin } : {}),
  edgeSecret: () => secret("edge_board_secret"), gateSecret: () => secret("gate_board_secret"), gate: gateInfo,
  // The gate's account map (compile makes it with settings.edge); without shared apps (no config/gate.json) there's no gate to tell.
  gateAccountsFile: path.join(dataDir, "gate", "accounts.json"),
  ...(ttl > 0 ? { linkTtlHours: ttl } : {}), // settings.owner_email (compile writes it to config/kernel/modules.json): the only email setup makes the owner's account.
  ownerEmail: () => modulesFile().owner?.email,
  notify: (line) => channels.ownerLine(line), manifest,
  wake: webhookWake(path.join(env("AIDENHQ_SECRETS_DIR", ""), "app_request_webhook_url"), path.join(env("AIDENHQ_SECRETS_DIR", ""), "app_request_webhook_secret"), accountLog, controlUrl),
  feedbackWake: routineWake(ownerApi, accountLog),
  log: accountLog,
}))
  .catch((e: Error) => (log("accounts off", { err: e.message }), undefined));
if (accounts) {
  // Apps come and go with applies (config/gate.json): a removed app's rows leave the gate's map within a minute; manifests
  // refresh, undelivered request wakes and a failed write retry on the same beat.
  void accounts.syncGate();
  setInterval(() => void accounts.syncGate(), 60_000).unref();
}
// The board's origins: its front door (BOARD_LAN_URL) and its loopback addresses (the SSH tunnel, local mode).
const boardOrigins = env("AIDENHQ_BOARD_ORIGINS", [boardUrl?.origin, "http://127.0.0.1:3121", "http://localhost:3121"].filter(Boolean).join(",")).split(",").map((o) => o.trim()).filter(Boolean);
// The board's origins are the module UI origins a session may be handed to (/auth/handoff).
const uiOrigins = () => Object.fromEntries(boardOrigins.map((o) => [o, "board"]));
// The first run's model step (/setup/model): OpenRouter's PKCE and a 1-token check on the gateway's upstream, against the first
// model the modules price (config/gateway.json, in the order the modules list them: the default first).
const upstream = env("AIDENHQ_GATEWAY_UPSTREAM", "https://openrouter.ai/api/v1");
const gatewaySettings = watched(path.join(configDir, "gateway.json"), (j) => j as { models?: Record<string, unknown> }, {});
const model = {
  start: (callback: string, state: string) => startPkce(callback, { upstream, state }),
  exchange: (code: string, verifier: string) => exchange(code, verifier, fetch, upstream),
  check: (key: string) => checkModel(key, { model: Object.keys(gatewaySettings().models ?? {})[0] ?? "~deepseek/deepseek-flash-latest", upstream }),
  saved: () => secret("openrouter_key"),
  dayCap: () => { const n = Number((gatewaySettings() as { install_day_usd?: unknown }).install_day_usd); return n > 0 ? n : undefined; },
  verifyAgents: agentSetup({ dir: env("AIDENHQ_DIR", repo), log: path.join(dataDir, "kernel", "agent-setup.log"), warn: (m, o) => log(m, o as never) }),
  ...modelState,
};
const admin = accounts && createAdmin({ accounts, firstRun, model, uiOrigins, doorSource: () => doorSource(gateInfo()), boardUrl: () => boardOrigins[0], cards: channels, ownerMessage: (b) => channels.ownerMessageAs("web", b, () => Object.entries(grantsTable().agents ?? {}).find(([, g]) => g.key === "chief-of-staff")?.[0]), owner: ownerApi, hosts: () => adminHosts, origins: () => adminOrigins, frameOrigins: () => boardOrigins, log });

// Claimed records a restart left without an outcome: their executors say how they went (never replayed). Executors may
// still be starting at boot, so once, a minute in.
setTimeout(() => void writes.reconcile().then((u) => u.length && log("records left unknown", { records: u }), (e: Error) => log("reconcile failed", { err: e.message })), 60_000).unref();

const gw = createGateway({
  dbFile: path.join(dataDir, "kernel", "kernel.db"),
  legacyDbFile: path.join(dataDir, "gateway", "usage.db"), // the old ledger: merged in at every start while it is there
  grantsFile,
  settingsFile: path.join(configDir, "gateway.json"),
  tools: proxy, // runner jobs' reads of connections (POST /c/<connection>/mcp, job tokens only)
  asCaller: createAsCaller({ whoami, connections, asserter, log }), // a module's model calls for its caller (cp.ts)
  secret,
  upstream,
  paperclipUrl: controlUrl,
  // The numbers are the gateway's ledger; the task's identifier and the agent's name are looked up here.
  // The install cap's card (agent INSTALL_CAP, no task) goes on an unassigned task of the owner's own, so no agent wakes.
  fileRaiseCap: async ({ task, ...r }) => {
    const install = r.agentId === INSTALL_CAP;
    const [issue, agent] = await Promise.all([task ? issueOf(task) : installCapTask(r.subject), install ? { name: "AidenHQ" } : cpApi(`/api/agents/${encodeURIComponent(r.agentId)}`).then((x) => (x.ok ? (x.json() as Promise<{ name?: string }>) : {}))]);
    if (!issue) throw new Error(`no task ${task ?? "for the install cap"}`);
    const args = { ...r, to: Math.round(r.cap * 200) / 100 };
    writes.fileNative("kernel.raise_cap", { task: issue.id, identifier: issue.identifier, args, card: raiseCapCard(args, String((agent as { name?: string }).name ?? ""), issue.identifier ?? issue.id), reason: install ? "the install-wide daily spend cap is the owner's to raise" : `a ${r.scope} spend cap is the owner's to raise`, rule: "raise-cap" });
  },
  launcherUrl,
  log,
});

/** A new unassigned task for the install cap's raise card, in the company of the instance's agents. */
async function installCapTask(day: string) {
  const someAgent = Object.keys(grantsTable().agents ?? {})[0];
  const a = someAgent ? await cpApi(`/api/agents/${encodeURIComponent(someAgent)}`) : undefined;
  const company = a?.ok ? String(((await a.json()) as { companyId?: string }).companyId ?? "") : "";
  if (!company) throw new Error("no company to file the install cap's card in");
  const r = await cpApi(`/api/companies/${company}/issues`, { method: "POST", body: JSON.stringify({ title: `Daily spend cap reached (${day})`, description: "AidenHQ reached its daily spend cap (settings.spend_day_usd), so model calls are paused until tomorrow (UTC). Approve the card to double today's cap, or change the setting in Settings.", status: "todo" }) });
  if (!r.ok) throw new Error(`Paperclip answered ${r.status} creating the install cap's task`);
  return (await r.json()) as { id: string; identifier?: string };
}

raiseCap = async (r) => {
  gw.setCap(r.scope, r.agentId, r.subject, r.to);
  return `Raised the ${r.scope} spend cap from $${r.cap.toFixed(2)} to $${r.to.toFixed(2)} ($${r.spent.toFixed(2)} spent). Carry on where the cap stopped you.`;
};

// host:port pairs. Each binds on its own: the backplane address exists only once compose is up, so a failed bind is retried
// (backoff up to a minute) while the others keep serving.
function listen(addr: string, ci = false, handler: http.RequestListener = (req, res) => gw.handle(req, res, { ci })) {
  const i = addr.lastIndexOf(":");
  const server = http.createServer(handler);
  // A model stream can run for many minutes (requestTimeout covers receiving the request, not the answer). The CI listener
  // faces jobs that run untrusted code: a request must arrive within a minute, and few connections at once.
  server.requestTimeout = ci ? 60_000 : 0;
  if (ci) server.maxConnections = 32;
  let wait = 1000;
  const bind = () => server.listen(Number(addr.slice(i + 1)), addr.slice(0, i));
  server.on("listening", () => { wait = 1000; log("listening", { addr }); });
  server.on("error", (e) => {
    log("listen failed; retrying", { addr, err: e.message, inMs: wait });
    setTimeout(bind, wait);
    wait = Math.min(wait * 2, 60_000);
  });
  bind();
}
for (const addr of env("AIDENHQ_GATEWAY_LISTEN", "127.0.0.1:8201,10.231.0.1:8201").split(",").map((s) => s.trim()).filter(Boolean)) listen(addr);
// The backplane listener: containers on the backplane reach it (Codex in the control plane, modules); jobs never do.
listen(env("AIDENHQ_KERNEL_BACKPLANE", "10.231.0.1:3130"), false, backplane);

// The admin listener: loopback only; the front door reaches it there.
listen(env("AIDENHQ_KERNEL_ADMIN", "127.0.0.1:3120"), false, admin ?? ((_req, res) => void res.writeHead(503, { "content-type": "text/plain" }).end("accounts are off: see the kernel's log")));

// The sign-in listener: loopback only; the gate (host network) reaches it there with its secret.
listen(env("AIDENHQ_KERNEL_SIGNIN", "127.0.0.1:3129"), false, accounts ? createSignin({ accounts, hosts: signinHosts, gate: gateInfo, log: accountLog }) : ((_req, res) => void res.writeHead(503, { "content-type": "text/plain" }).end("accounts are off: see the kernel's log")));

// The CI listener, on the CI runners' bridge address (modules/ci; ops/units/aidenhq-ci-net.service lets that bridge reach this
// port only): CI routes and CI tokens only (lib.ts). Bound once config/gateway.json turns CI on (checked every minute, so
// an apply that enables the ci module needs no restart); a host without the CI network never tries.
const ciAddr = env("AIDENHQ_GATEWAY_CI_LISTEN", "10.231.4.1:8201");
let ciBound = false;
const ciCheck = () => { if (!ciBound && ciAddr && gw.ciEnabled()) { ciBound = true; listen(ciAddr, true); } };
ciCheck();
setInterval(ciCheck, 60_000);

// The monitoring module's metrics (lib.ts metricsText): a node-exporter textfile every 30 seconds, written only while the
// module's directory exists. A file, not a route: nothing new listens, and a stale file shows the gateway is down.
const textfile = path.join(dataDir, "modules", "monitoring", "textfile");
setInterval(() => {
  if (!existsSync(textfile)) return;
  try {
    const tmp = path.join(textfile, ".gateway.prom.tmp");
    writeFileSync(tmp, gw.metricsText());
    renameSync(tmp, path.join(textfile, "gateway.prom"));
  } catch (e) {
    log("metrics write failed", { err: String((e as Error).message).slice(0, 200) });
  }
}, 30_000).unref();
