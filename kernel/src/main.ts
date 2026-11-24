#!/usr/bin/env node
// The kernel host service, systemd user unit aidenhq-kernel (ops/units/aidenhq-kernel.service).
// - The model gateway (gateway/lib.ts; CI credentials gateway/ci.ts): the only holder of the model key (read from the vault at
//   each call), on host loopback and the backplane's gateway address (8201), and with CI on, on the CI runners' bridge. Fails
//   closed: if it is down, no model call is made.
// - The backplane listener (10.231.0.1:3130, backplane.ts): the tool proxy in front of every connection, caller identity
//   and assertions, the control plane as the calling agent, and the records of every write (writes.ts, kernel.db).
// - Jobs (jobs.ts, sandbox.ts): engine runs in the sandbox, detached, so a restart (KillMode=process) leaves them running;
//   this process adopts them at start and stops following them (offsets saved) on SIGTERM, SIGINT or SIGUSR2. Check jobs'
//   box runs (checkjobs.ts) are detached the same way: a drain hands them on and the next kernel follows them to their end.
// - A restart drains (SIGUSR2, sent by ops/run-draining.sh, the unit's main process, which exits at once so the next kernel starts):
//   this kernel stops its jobs' watchers, timers and listeners at once (the next one binds them as it starts: a gap of its
//   start-up, which callers retry), lets the model calls in flight finish (at most DRAIN_MS) and exits.
// - The admin listener (127.0.0.1:3120, admin.ts): admins' sign-in (accounts.ts, data/kernel/auth/); its old approval addresses redirect to the board.
// - The sign-in listener (127.0.0.1:3129, signin.ts): the gate's half of shared apps' sign-in (Better Auth's steps, handoffs,
//   app access). The kernel is the only process that opens the accounts file (lean 3g).
import { execFile } from "node:child_process";
import http from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { configDir, dataDir, env, repo, secret } from "./env.ts";
import { createGateway, watched } from "./gateway/lib.ts";
import { convert as convertGithubApp, removeApp as removeGithubApp, saveApp as saveGithubApp, type MadeApp } from "./github-app.ts";
import { createAdmin, type SetupField } from "./admin.ts";
import { createAuthApi, OPERATOR_KEY } from "./auth-api.ts";
import { createModuleValidate } from "./module-validate.ts";
import { CHECK_MODEL, MODEL_KEY, createModelStep } from "../../modules/models-openrouter/src/model-step.ts";
import { composeRecreate, createModuleSecrets, secretFits, vaultWriter } from "./module-secrets.ts";
import { doorSource, readGate } from "./accounts.ts";
import { routineWake, webhookWake, type Manifest } from "../../modules/apps-platform/src/app-access.ts";
import { createSignin } from "./signin.ts";
import { createAsserter, loadKey } from "./assert.ts";
import { chiefOfStaff, createBackplane, STOPPED_NOTE } from "./backplane.ts";
import { createProjects } from "./projects.ts";
import { createOutcomes, createPluginPost, delegateIds, lanePoster } from "./outcomes.ts";
import { createBrake } from "./brake.ts";
import { createNotify } from "./notify.ts";
import { createReplyRelay } from "./relay.ts";
import { KERNEL_STAGES, type Stage } from "./flow-stages.ts";
import { journeysOf } from "./journeys.ts";
import { createChannels, type Api, type ModulesFile } from "./channels.ts";
import { createLane } from "./lane.ts";
import { checksFile, createChecks } from "./checks.ts";
import { createAsCaller, createBoardCp, createCp } from "./cp.ts";
import { createIdentity, type Connection, type Grant, type Jobcap } from "./identity.ts";
import { createAdvisories } from "./advisories.ts";
import { hostFetch } from "../../scripts/compiler/sources.ts";
import { createResolver } from "./net.ts";
import { CODEHOST, covers, createCodehost, localFacts, type OpsGrant } from "./codehost.ts";
import { createConnectionHealth, createHealthProbe } from "./health.ts";
import { createProxy } from "./proxy.ts";
import { SETTINGS, UPDATER, openRecords } from "./records.ts";
import { renameKinds, type Catalog } from "./kind-rename.ts";
import { backfillLocal, openFacts } from "./facts.ts";
import { createDeploys } from "./generations.ts";
import { createFlow } from "./flow.ts";
import { createTaskStateRead } from "./task-state-read.ts";
import { createIdle } from "./idle.ts";
import { createConnectionState, type ConnectionState } from "./connection-state.ts";
import { CHIEF, CONVERSING_MS, SETTLER, createEscalate, ownerWroteAt } from "./escalate.ts";
import { pidAlive, recordKernel } from "./previous.ts";
import { createReviews, type ReviewerSlot } from "./reviews.ts";
import { createReviewLoop } from "./review-loop.ts";
import { createNotices, type NoticeOpts } from "./notices.ts";
import { mintToken } from "./gateway/token.ts";
import { createWrites, type Kind } from "./writes.ts";
import type { Executor } from "../sdk/src/executor.ts";
import { createApply, hostApply } from "./apply.ts";
import { checkoutMain, checkoutTree, createSettingsChanges, skillSides } from "./settings-change.ts";
import { createSharing, vaultValues } from "./module-share.ts";
import { createMemory, fillMemory } from "./memory.ts";
import { createEvents, routineRun } from "./events.ts";
import { createRouting } from "./routing-tune.ts";
import { createBoardApi } from "./board-api.ts";
import { hostPlanner } from "./apply-tier.ts";
import type { Verdict } from "./tier.ts";
import { logTasks, scopeOf } from "./task-scope.ts";
import { KERNEL_KINDS, LOCAL_ORG } from "./kinds.ts";
import { FLEET_OP, createFleetOps } from "./fleet-ops.ts";
import { JobError, admittedJob, createJobs, dispatchesFrom } from "./jobs.ts";
import { createAdmission, wakeInbox } from "./admission.ts";
import { createPool } from "./pool.ts";
import { createBoxes, handbookFrom, launcherClient, type Boxes } from "./boxes.ts";
import { checkJobsFrom } from "./checkbox.ts";
import type { Recipes } from "./checkjobs.ts";
import { localSnapshot } from "../../modules/codehost-local/src/snapshot.ts";
import { LOCAL_KINDS, localHost as codehostLocal } from "../../modules/codehost-local/src/host.ts";
import { check as productGate } from "../../modules/platform/src/check.ts";
import { check as instanceDetailsCheck } from "./instance-details-check.ts";
import { ingest } from "../../modules/codehost-local/src/git.ts";
import { localMergePass } from "./localmerge.ts";
import { createJobTools } from "./jobtools.ts";
import { createWakes, wakeNotice } from "./wakes.ts";
import { createDiskSweep, pruneSkillRuntimes } from "./workspaces.ts";
import { createModuleTasks } from "./modtasks.ts";
import { createWork } from "./work.ts";
import { ensureStateDirs, readEngines } from "./sandbox.ts";
import { sandboxConfig } from "./sandbox-config.ts";
import { createCertWatch } from "./front-door.ts";
import { createUpdates, runCheck, runMain, runVerify, updateTask } from "./updates.ts";
import { BOX_EXEC_WRAP } from "../../services/computer/lib.ts";
import { TYPED, limitIssueLists, markCode } from "./cplimit.ts";

const log = (msg: string, fields: Record<string, unknown> = {}) => console.log(new Date().toISOString(), msg, JSON.stringify(fields));

const controlUrl = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
const launcherUrl = env("AIDENHQ_LAUNCHER_URL", "http://10.231.0.1:8199"); // the computer launcher: jobs' and checks' boxes
const grantsFile = path.join(configDir, "grants", "grants.json");
const grantsTable = watched(grantsFile, (j) => j as { agents?: Record<string, Grant> } & Record<string, unknown>, {});
const connections = watched(path.join(configDir, "kernel", "connections.json"), (j) => j as Record<string, Connection>, {});
// The control plane with the owner key (paperclip_board_key: only the kernel holds it; the board reaches it through cp.ts createBoardCp): a record's task.
// One owner-key caller to the control plane, kept under its issue-list cap (cplimit.ts).
// Every comment it writes is marked as code's unless it carries the owner's typed words (cplimit.ts markCode).
const ownerFetch = markCode(limitIssueLists(fetch));
const cpApi = (p: string, init: RequestInit = {}, typed = false) => ownerFetch(new URL(p, controlUrl), { ...init, headers: { authorization: `Bearer ${secret("paperclip_board_key")}`, "content-type": "application/json", ...(typed ? { [TYPED]: "owner" } : {}) }, signal: init.signal ?? AbortSignal.timeout(15_000) });
// Modules with kernel roles, a privileged entry, a token of their own or a channel (compile).
const modulesFile = watched(path.join(configDir, "kernel", "modules.json"), (j) => j as ModulesFile & { snapshot?: string; reviewer?: ReviewerSlot; setup?: SetupField[]; services?: Record<string, string[]>; mounts?: Record<string, string[]>; check_jobs?: Recipes }, {});
const whoami = createIdentity({
  grants: () => grantsTable().agents ?? {}, connections, modules: () => modulesFile().modules ?? {},
  jobcaps: watched(path.join(configDir, "jobcaps.json"), (j) => j as Record<string, Jobcap>, {}), // the reads a job's jobcaps add to its tools (compile)
  secret,
  job: (id) => admittedJob(records.db, id), // a kernel job's token: its row's frozen authority (admission.ts)
});
const asserter = createAsserter(loadKey(path.join(dataDir, "kernel", "caller-key.pem")));
const resolver = createResolver({ project: env("COMPOSE_PROJECT_NAME", "aidenhq") });
// A record's task: still open, and the notices on it (written with the board key, as the board's approval notices are).
const issueOf = async (task: string) => { const r = await cpApi(`/api/issues/${encodeURIComponent(task)}`); return r.ok ? ((await r.json()) as { id: string; identifier?: string; status?: string; assigneeAgentId?: string | null; createdByAgentId?: string | null; parentId?: string | null }) : undefined; };
const cpJson = async (p: string) => { const r = await cpApi(p); if (!r.ok) throw Object.assign(new Error(`control plane GET ${p} → ${r.status}`), { status: r.status }); return r.json(); };
const records = openRecords(path.join(dataDir, "kernel", "kernel.db"));
// Agents' memory (memory.ts): one document per agent, filled into a job's handbook when it starts.
const memory = createMemory({ dir: path.join(dataDir, "kernel", "memory") });
// The event router (events.ts): source events become routine runs through Paperclip's own /run as the owner (routineRun).
const events = createEvents({
  db: records.db, grants: grantsTable as never, connections: connections as never, log,
  run: routineRun(async (p, body) => { const r = await cpApi(p, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }),
  routine: async (id) => {
    const r = await cpApi(`/api/routines/${encodeURIComponent(id)}`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`control plane GET routine → ${r.status}`);
    const j = (await r.json()) as { status?: string; assigneeAgentId?: string | null };
    return { status: String(j.status ?? ""), assignee: String(j.assigneeAgentId ?? "") };
  },
});
// Flow's fact log (facts.ts) on the same file, so a kernel change and its fact commit together.
const facts = openFacts(records.db);
// Flow's stages: the kernel's plus every module's declared ones (module.yaml `stages:`), read from the watched modules file.
const stages = (): Stage[] => [...KERNEL_STAGES, ...Object.entries(modulesFile().modules ?? {}).flatMap(([module, m]) => (m.stages ?? []).map((s) => ({ ...s, module })))];
const journeys = () => journeysOf(modulesFile().modules ?? {});
// Flow's views (GET /v1/flow) read the log on their own read-only connection: a long read never blocks the approval path.
// DORA's incidents: the Fleet Steward detector's tasks for something newly tripped (fleet-steward main.ts fileCheck, fleet-incident:<at>).
const flow = createFlow({ file: path.join(dataDir, "kernel", "kernel.db"), stages, journeys, incident: (f) => f.data.origin === "module:fleet-steward" && String(f.data.source_marker ?? "").startsWith("fleet-incident:") });
// Each task's one state (GET /v1/tasks/state), computed from its facts on its own read-only connection too.
const paperclipAgent = async (id: string) => {
  const r = await ownerApi("GET", `/api/agents/${encodeURIComponent(id)}`);
  if (r.status >= 400 && r.status < 500) return undefined; // Paperclip answers an unknown id with 422
  if (r.status !== 200) throw new Error(`agent → ${r.status}`);
  const a = r.json as { name?: string; status?: string };
  return { name: a.name ?? id, terminated: a.status === "terminated" };
};
// Whether an enabled job dispatcher runs an agent (compile: one module with kernel.jobs dispatches every agent): a held task
// with none reads `unpolled`, never `orphaned`. The compiled list, not a dispatcher's claim, so a kernel restart doesn't make
// every idle task look unpolled for the minute before dispatch joins. A holder is an agent key (task-state's
// `task.assignee_changed.to`); a key no grant maps is left as before (the read names a terminated holder).
const dispatched = dispatchesFrom(() => (modulesFile().modules ?? {}) as never, () => grantsTable().agents ?? {});
const polledKey = (holder: string) => {
  const agents = grantsTable().agents ?? {};
  const id = Object.keys(agents).find((a) => agents[a]?.key === holder);
  if (!id) return true;
  return Object.keys(modulesFile().modules ?? {}).some((m) => dispatched(m, id));
};
const taskStates = createTaskStateRead({ file: path.join(dataDir, "kernel", "kernel.db"), stages, agent: paperclipAgent, polled: polledKey });
// A write's notices on its task (notices.ts): durable, sent every few seconds and as soon as one is queued.
const notices = createNotices({ db: records.db, api: (m, p, b) => ownerApi(m, p, b), alert: (text) => notify.queue({ kind: "alert", text }), log });
const sendNotices = () => void notices.send().catch((e: Error) => log("task notices failed", { err: String(e.message ?? e).slice(0, 300) }));
const onTask = {
  // A task gone (404) is closed; any other failed read throws with its status, so a blip never reads as "closed".
  open: async (task: string) => {
    const r = await cpApi(`/api/issues/${encodeURIComponent(task)}`);
    if (r.status === 404) return false;
    if (!r.ok) throw Object.assign(new Error(`control plane GET task ${task} → ${r.status}`), { status: r.status });
    return !["done", "cancelled"].includes(String(((await r.json()) as { status?: string }).status));
  },
  // A task a conn.tool call names: read whole, and why its agent may write there (the same rule cp.ts applies to a write).
  scope: async (task: string, agent: string) => {
    const i = await issueOf(task);
    if (!i) return undefined;
    return { id: i.id, identifier: i.identifier, scope: await scopeOf(i, agent, issueOf, logTasks(grantsTable() as never)) };
  },
  // Queued in kernel.db and sent from there (notices.ts): the notice is what wakes the agent waiting on the write.
  notify: async (task: string, body: string, o?: NoticeOpts) => { notices.queue(task, body, o); setImmediate(sendNotices); },
};
// The modules' kinds (compile) and the kernel's own and the runner's (kinds.ts).
// The module catalog (compile): which modules are enabled, and which each replaces.
const catalog = watched(path.join(configDir, "modules.json"), (j) => (Array.isArray(j) ? j : []) as Catalog, []);
const moduleKinds = watched(path.join(configDir, "kernel", "writes.json"), (j) => j as Record<string, Kind>, {});
// codehost-local's kinds while it is enabled: it has no service, so the kernel runs its executor (localCode below).
const registry = (): Record<string, Kind> => ({ ...moduleKinds(), ...(localHost() ? LOCAL_KINDS : {}), ...KERNEL_KINDS });
let replay: (r: never) => Promise<{ ok: boolean; text: string }> = async () => ({ ok: false, text: "the proxy isn't up" });
// The product and instance repositories (owner/name), as setup recorded them in .env.
// The fleet org (setting github_fleet_org, compiled into the modules file as repos.fleet_org), read on each call: the one
// GitHub org @agents grants and a bare create_repo resolve to. Unset: none (@agents names only `local`, when it is on).
const fleetOrg = () => modulesFile().repos?.fleet_org || undefined;
// With codehost-local enabled (the compiled catalog), its org `local` is an agents org too (docs/design/codehost-local.md §2).
const localHost = () => catalog().some((m) => m.name === "codehost-local" && m.enabled === true);
// A module that replaced another carries its finished records along: they move to its kinds (kind-rename.ts).
renameKinds(records.db, catalog(), registry());
const baseRepos = { product: env("AIDENHQ_PRODUCT_REPO") || undefined, instance: env("AIDENHQ_INSTANCE_REPO") || undefined };
const repos = () => ({ ...baseRepos, agentsOrg: fleetOrg(), agentsOrgs: [fleetOrg(), ...(localHost() ? [LOCAL_ORG] : [])].filter((o): o is string => Boolean(o)) });
/** Every code-host org the instance reaches (codehostRepos' list, by org): a connection need naming any other org is stale. */
function codehostOrgs(): string[] {
  const r = codehostRepos();
  const owner = (slug?: string) => slug?.split("/")[0];
  return [...(r.orgs ?? []), ...(r.agentsOrgs ?? []), ...[r.product, r.instance, ...(r.maintained ?? [])].map(owner)].filter((o): o is string => Boolean(o));
}
log(baseRepos.product && baseRepos.instance ? "repositories" : "AIDENHQ_PRODUCT_REPO or AIDENHQ_INSTANCE_REPO isn't set", repos());
// The bound reviewer module (reviewer@1): its model calls go through this gateway on a reviewer token minted per review.
const reviews = createReviews({ slot: () => modulesFile().reviewer, secret, resolver, log, modelToken: (component) => mintToken(secret("gateway_job_secret"), { kind: "reviewer", component, ttlMs: 3600_000 }) });
// kernel.apply's executor (apply.ts): the code host lands the commit, a transient unit runs the apply; a restart resumes it.
const instanceDir = env("AIDENHQ_INSTANCE_DIR", path.join(process.env.HOME ?? "", "aidenhq-instance"));
const applyHost = hostApply({ repo, instanceDir, stateDir: env("AIDENHQ_STATE_DIR", path.join(process.env.HOME ?? "", ".local/state/aidenhq")), resolver, codehost: () => { const e = moduleKinds()["github.push"]?.executor; return e && { url: e.url, key: secret(e.auth_secret) }; },
  // codehost-local's instance repo: the bare repo setup made on this host (AIDENHQ_INSTANCE_REMOTE).
  local: () => (localHost() && repos().instance?.toLowerCase().startsWith(`${LOCAL_ORG}/`) ? { bare: localCode.bare(repos().instance!), repo: repos().instance!, ingest: (s) => ingest(tasksDir, localScratch, localCode.bare(s.repo), s.workspace, s) } : undefined) });
const applies = createApply({ db: records.db, log, ...applyHost });
// Its planner (apply-tier.ts): the same code host read and the product checkout.
const applyPlanner = hostPlanner({ repo, instanceRepo: () => repos().instance, read: applyHost.codehost.read, verifyRelease: runVerify(repo), notes: (sha, requester, task) => routing.notes(sha, requester, task), skills: skillSides({ product: repo, fetch: () => checkoutMain(instanceDir)([]), tree: checkoutTree(instanceDir) }) });
// The modules' checks (config/kernel/checks.json): the finish gate's task.finish ones and the write.filed ones every filing runs.
const checksRegistry = checksFile(path.join(configDir, "kernel", "checks.json"));
const writes = createWrites({
  records, registry, connections, secret, resolver, reviews, onTask, log, replay: (r) => replay(r as never), repos,
  // ai_review_code (the ai-reviewer module's setting) and the mandatory code-review repos, compiled into the modules file.
  reviewCode: () => ({ mode: modulesFile().repos?.review_code, mandatory: modulesFile().repos?.code_review_mandatory }),
  // The write.filed checks' code, run in process: the platform check (a hard gate, gates.ts) on the code hosts' git writes.
  checks: checksRegistry, filedChecks: { "platform.product-gate": productGate, "code-review.instance-details": instanceDetailsCheck },
  autonomy: () => (["off", "tier0", "full"].includes(grantsTable().autonomy as string) ? grantsTable().autonomy : "off") as never,
  // kernel.fleet_op (fleet-ops.ts): its planner and executor are bound once fleetOps exists below (called only after start).
  native: { "kernel.apply": applies.execute, [FLEET_OP]: (r) => fleetOps.execute(r) },
  planners: { "kernel.apply": applyPlanner, [FLEET_OP]: (b) => fleetOps.plan(b) },
  executors: (): Record<string, Executor> => (localHost() ? { "codehost-local": localCode.executor } : {}),
  resume: ["kernel.apply"],
});
// Connect on first use (connection-state.ts): built below once notify, wakes and idle are; the proxy reads it late-bound.
let connectionState: ConnectionState | undefined;
const proxy = createProxy({ whoami, grants: () => grantsTable().agents ?? {}, connections, asserter, resolver, secret, writes, needs: () => connectionState, log });
replay = proxy.replay as never;
const healthProbe = createHealthProbe({ grants: () => grantsTable().agents ?? {}, connections, kindOf: writes.kindOf, callAs: proxy.callAs, log });
// JSON both ways: the control plane as the owner (only the kernel holds the board key), and the board's internal listener with
// the kernel's key (gateway_board_key).
const asApi = (call: (p: string, init: RequestInit) => Promise<Response>): Api => async (method, p, body) => {
  const r = await call(p, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ownerApi = asApi(cpApi);
// Projects (projects.ts): repos map into products; a PR's repo fills in its task's project, agents tag one by name.
const projects = createProjects({ db: records.db, owner: ownerApi, products: () => (grantsTable().projects ?? {}) as Record<string, string[]>, log });
const boardApi = asApi((p, init) => fetch(new URL(p, env("BOARD_INTERNAL_URL", "http://127.0.0.1:3122")), { ...init, headers: { authorization: `Bearer ${secret("board_internal_token")}`, "x-gateway-key": secret("gateway_board_key"), "content-type": "application/json" }, signal: AbortSignal.timeout(20_000) }));
const channels = createChannels({ db: records.db, records, writes, board: boardApi, owner: ownerApi, ownerTyped: asApi((p, init) => cpApi(p, init, true)), modules: modulesFile, facts, log, stopJobs: async (task, by) => { const stopped = jobs.stopRunning({ task }, by); for (const j of stopped) await outcomes.post(j, { kind: "notice", body: STOPPED_NOTE }).catch((e: Error) => log("stop note failed", { job: j.id, err: e.message })); return stopped.length; } });
// The owner's messages: the kernel's own (alerts, the approvals digest) and the board's and the runner's, queued for
// owner-channel's notify (notify.ts).
const notify = createNotify({ db: records.db, modules: modulesFile, secret, resolver, log, extra: () => [channels.digest()].filter((t): t is string => t !== null).map((text) => ({ kind: "digest" as const, text })) });
// alert: something is wrong now (a page); done: a plain notice, never muted.
const toOwner = (kind: "alert" | "done") => (text: string) => notify.queue({ kind, text });
// The runner's state root can't be made (a reclaim removed it, or another user owns it): one alert per episode, naming the
// path, its owner and mode, and the uid the kernel runs as, so the owner can fix it instead of every job failing unseen. The
// key names the episode: the owner channel drops an alert key it already sent within the hour, so a second outage an hour or
// even a minute later must not reuse the first one's.
const warnStateNeed = (e: Error, episode: string) => notify.queue({ kind: "alert", text: `Jobs on this host can't start: ${e.message}. Recreate it as this user (mode 0700) or fix its owner and mode.`, dedupe_key: `runner-state-dir:${episode}` });
// A judgement a task can't make for itself (a parked target, an agent's wait on its delegator or the owner) reaches whoever
// can make it, once (escalate.ts).
// A task as the control plane has it now (undefined when gone; throws when it can't be read now): escalate and connection state.
const escalateIssue = async (id: string) => {
  const r = await cpApi(`/api/issues/${encodeURIComponent(id)}`);
  if (r.status === 404) return undefined;
  if (!r.ok) throw Object.assign(new Error(`control plane GET task ${id} → ${r.status}`), { status: r.status });
  return (await r.json()) as never;
};
const escalate = createEscalate({
  db: records.db, log, reachable: (id) => wakes.polls(id),
  issue: escalateIssue,
  state: (id) => taskStates.read({ ids: [id] }).tasks[0],
  // The owner channel's attention reads the agent's key and roles (the grants table), as it does for the agent's own notify.
  asker: async (id) => {
    const g = grantsTable().agents?.[id] as { key?: string; roles?: string[] } | undefined;
    return { name: String(((await cpJson(`/api/agents/${encodeURIComponent(id)}`)) as { name?: string }).name ?? ""), key: String(g?.key ?? id), roles: g?.roles ?? [] };
  },
  notice: (task, body) => { notices.queue(task, body); setImmediate(sendNotices); },
  owner: (n) => notify.queue(n),
  // The Fleet Steward settles every judgement that isn't the owner's conversation (the chief of staff the Steward's own): one
  // kernel-filed task per ask, by role.
  settle: (b) => moduleTasks.file("kernel", { ...b, role: SETTLER }),
  settleAgent: () => Object.entries(grantsTable().agents ?? {}).find(([, g]) => (g.roles ?? []).includes(SETTLER))?.[0],
  chief: (b) => moduleTasks.file("kernel", { ...b, role: CHIEF }),
  chiefAgent: () => chiefOfStaff(grantsTable().agents),
  conversing: async (id) => {
    const t = encodeURIComponent(id);
    const [i, c] = await Promise.all([cpJson(`/api/issues/${t}`), cpJson(`/api/issues/${t}/comments?order=desc&limit=50`)]);
    const at = ownerWroteAt(i as never, Array.isArray(c) ? c : []);
    return at !== undefined && Date.now() - at < CONVERSING_MS;
  },
});
// Marketplace advisories (advisories.ts): read at start, then whenever a day has passed or an apply rewrote the catalog.
const advisories = createAdvisories({ db: records.db, repo, catalog: path.join(configDir, "modules.json"), ownerLine: toOwner("done"), log, ref: env("AIDENHQ_ADVISORY_REF", "main"), fetch: hostFetch(repo) });
// Timers a draining kernel stops (the next one runs its own).
const timers: NodeJS.Timeout[] = [];
const every = (fn: () => void, ms: number) => timers.push(setInterval(fn, ms).unref());
const once = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms).unref());
every(sendNotices, 5_000);
// Facts are kept 400 days (docs/design/flow.md §8).
every(() => { try { facts.prune(); } catch (e) { log("facts prune failed", { error: String((e as Error).message) }); } }, 864e5);
// A drain ends the wake inbox's control-plane reads at once (the poll in flight stops at its next read; the next kernel polls).
// A write (a reopen, an unblock) already sent is never cut mid-flight (it may have landed); none starts once the drain has.
const drainSignal = new AbortController();
// The writes in flight hold the drain open (bounded by DRAIN_MS, as every other in-flight count).
let wakeWrites = 0;
const wakeOwner = asApi(async (p, init) => {
  if ((init.method ?? "GET") === "GET") return cpApi(p, { ...init, signal: AbortSignal.any([AbortSignal.timeout(15_000), drainSignal.signal]) });
  if (drainSignal.signal.aborted) throw new Error("draining: the next kernel takes it");
  wakeWrites++;
  try { return await cpApi(p, init); } finally { wakeWrites--; }
});
// Who owns a row across a restart. A restart drains the old kernel beside this one for at most DRAIN_MS (below): the old one
// starts no job and no write after its drain begins, but finishes the launches and executions it had in flight. So a row this
// process didn't make (a job still `admitted`, a write still `claimed`) is the previous kernel's until that process has exited
// (its pid, recorded in kernel.db, is gone) or DRAIN_MS has passed; only then does this kernel recover it (afterPrevious).
// A running job is followed by one process only: the old one detaches its watchers before this one adopts them.
const DRAIN_MS = 5 * 60_000;
let draining = false;
const started = Date.now();
const previousPids = recordKernel(records.db, process.pid);
const previousGone = () => previousPids.every((pid) => !pidAlive(pid)) || Date.now() - started > DRAIN_MS + 30_000;
/** Runs `fn` once the previous kernel has exited (checked every 5 s); at once when there is none. */
const afterPrevious = (fn: () => void) => {
  if (previousGone()) return fn();
  const t = setInterval(() => { if (previousGone()) { clearInterval(t); fn(); } }, 5_000).unref();
  timers.push(t);
};
every(() => void advisories.tick(), 10 * 60_000);
// The event router's drain: once the previous kernel has exited, at once and then every 15 s.
const drainEvents = () => void events.drain().catch((e: Error) => log("events drain failed", { err: String(e.message).slice(0, 300) }));
afterPrevious(() => { drainEvents(); every(drainEvents, 15_000); });
// The instance's products map (instance.yaml `projects:`): a repo moved into a product moves its project, at start and after an apply.
every(() => void projects.sync().catch((e: Error) => log("project sync failed", { err: e.message })), 60_000);
once(() => void advisories.tick(), 30_000);
// The public front door's certificate (exposure public, compiled into config/exposure; the IP is the host's .env): hourly.
const certWatch = createCertWatch({
  ip: () => { try { return readFileSync(path.join(configDir, "exposure"), "utf8").trim() === "public" ? env("AIDENHQ_PUBLIC_IP") || undefined : undefined; } catch { return undefined; } },
  notify: toOwner("alert"),
});
every(() => void certWatch.tick(), 3_600_000);
once(() => void certWatch.tick(), 10 * 60_000);
// Release updates (updates.ts, docs/design/release-updates.md): the check (a child process) prepares a release; the kernel files
// it as a kernel.apply on a task of its own (the platform engineer's, as the release train's), follows it and tells the owner.
const moduleTasks = createModuleTasks({ db: records.db, owner: ownerApi, agents: () => grantsTable().agents ?? {}, plugin: () => plugin, rubric: (task, module, b) => checks.rubric(task, module, b), log });
const updates = createUpdates({
  db: records.db, dir: path.join(dataDir, "updates"), inst: env("AIDENHQ_INSTANCE_DIR", path.join(process.env.HOME ?? "", "aidenhq-instance")), board: path.join(env("AIDENHQ_STATE_DIR", path.join(process.env.HOME ?? "", ".local/state/aidenhq")), "board/updates.json"),
  ownerLine: toOwner("done"), alert: toOwner("alert"), check: runCheck(repo), main: runMain(repo), log,
  file: async (r) => {
    const task = await moduleTasks.file("kernel", updateTask(r));
    try {
      return { record: (await writes.fileKernel("kernel.apply", { args: { repo: repos().instance, branch: r.branch, sha: r.sha }, task: task.id, requester: UPDATER })).id, task: task.id };
    } catch (e) {
      await moduleTasks.close("kernel", task.id, { status: "cancelled", body: `Not filed: ${(e as Error).message.slice(0, 500)}` }).catch(() => {});
      throw e;
    }
  },
  record: (id) => records.get(id),
  close: (task, body) => moduleTasks.close("kernel", task, { status: "done", body }),
});
const updatesTick = () => void updates.tick().catch((e: Error) => log("update pass failed", { err: e.message.slice(0, 300) }));
every(updatesTick, 5 * 60_000);
once(updatesTick, 60_000);
// The kernel's review of every record waiting for the AI reviewer (review-loop.ts).
let ownerUser: string | undefined;
const reviewLoop = createReviewLoop({
  records, writes, reviews, log,
  task: {
    issue: (id) => cpJson(`/api/issues/${encodeURIComponent(id)}`),
    comments: async (id) => ((await cpJson(`/api/issues/${encodeURIComponent(id)}/comments?order=asc&limit=500`)) as { deletedAt?: string | null }[]).filter((c) => !c.deletedAt),
    me: async () => (ownerUser ||= String(((await cpJson("/api/cli-auth/me")) as { userId?: string }).userId ?? "")),
    notify: onTask.notify,
    delegator: async (i) => escalate.creatorAgent(i),
    agent: (id) => grantsTable().agents?.[id] as { key?: string; roles?: string[] } | undefined,
  },
});
every(() => void reviewLoop.tick(), 30_000);
once(() => void reviewLoop.tick(), 5_000);
const brake = createBrake({ db: records.db, owner: ownerApi });
// The owner's typed settings changes from the board and agents' changes to themselves (settings-change.ts): written by the
// instance repo's code host, filed as a kernel.apply.
const settingsChange = createSettingsChanges({
  product: repo, configDir, instanceRepo: () => repos().instance, main: checkoutMain(instanceDir), tree: checkoutTree(instanceDir), log,
  task: (id) => cpJson(`/api/issues/${encodeURIComponent(id)}`).catch(() => undefined) as never,
  owner: async () => (ownerUser ||= String(((await cpJson("/api/cli-auth/me")) as { userId?: string }).userId ?? "")),
  filed: (task) => records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 50, { task, kinds: ["kernel.apply"] }).some((r) => r.requester.kind === SETTINGS.kind && r.requester.name === SETTINGS.name),
  write: applyHost.codehost.write,
  file: (args, task, requester, owner) => writes.fileKernel("kernel.apply", { args, task, requester: requester ?? SETTINGS, ...(owner ? { owner } : {}) }),
  credentialAccount: async (c) => {
    if ("mcp" in c) return (await accounts?.mcpGrant(c.mcp.token, c.mcp.resource))?.account.id;
    const who = await accounts?.uiSession("board", c.board);
    return who?.ready && who.account.role === "admin" ? who.account.id : undefined;
  },
});
// The routing learning loop (routing-tune.ts): the Fleet Steward's typed routing changes, written by the same code host and
// filed as kernel.apply records with the Steward as their requester.
const routing = createRouting({
  db: records.db, records, instanceRepo: () => repos().instance, main: checkoutMain(instanceDir), write: applyHost.codehost.write, owner: ownerApi, log,
  file: (args, task, requester) => writes.fileKernel("kernel.apply", { args, task, requester }),
  grants: () => (grantsTable().agents ?? {}) as never,
});
// The job settings as configured here (jobs run in their agents' computers; no repo code runs on the host).
const sandbox = sandboxConfig(env);
// codehost-local (docs/design/codehost-local.md), run here: the org `local`'s bare repos under <data dir>/codehost, setup's
// instance repo where setup made it (AIDENHQ_INSTANCE_REMOTE), job commits from their workspaces, and a change's checks as
// the `change` check job, whose receipt the kernel signed and verifies.
const tasksDir = path.join(sandbox.workDir, "tasks"), localScratch = path.join(sandbox.workDir, "codehost-scratch");
mkdirSync(localScratch, { recursive: true });
// The runner's state root and its logs (the engine homes and job logs live there): made 0700 at start, beside the other
// startup directories, so a reclaim that removed them doesn't wait for the first job to find out. A root that still can't be
// made is one owner alert; the first launch reports the same way (`stateNeed` below).
try { ensureStateDirs(sandbox.stateDir, warnStateNeed); } catch (e) { log("WARNING: the runner state directory can't be made", { err: (e as Error).message }); }
const instanceRemote = env("AIDENHQ_INSTANCE_REMOTE", "");
const localCode = codehostLocal({
  fact: localFacts(facts, projects),
  root: path.join(dataDir, "codehost"), tasksDir, scratchDir: localScratch, instanceRepo: baseRepos.instance, productRepo: baseRepos.product,
  sources: baseRepos.instance && instanceRemote.startsWith("/") ? { [baseRepos.instance]: instanceRemote } : {},
  // `retry` asks for a run (idempotent: the one already running or done); otherwise this only reads the one already asked for,
  // so a sweep over open changes never starts work by looking. A check that couldn't run (no box) starts again on a request; a
  // merge waiting on one reads it as it stands.
  checks: async (repo, head, base, retry) => {
    const ask = { repo, head, run: "change", spec: { base } } as const;
    const v = retry ? checkJobs.start("codehost-local", ask) : checkJobs.find("codehost-local", ask);
    if (!v) return [{ ok: false, pending: false, missing: true, summary: "not started" }];
    // An error is no verdict at all (no box, no snapshot): missing, so a sweep may ask for it again. A red receipt stays red.
    return [{ ok: v.state === "done" && checkJobs.verify(v.receipt, { repo, head, run: "change" }).ok, pending: v.state === "running", missing: ["error", "lost"].includes(v.state), summary: v.receipt?.summary ?? v.error ?? v.state }];
  },
});
// A green local change asks for its merge itself, once per head and base, as the task's own agent (localmerge.ts: the local
// equivalent of the agents-org auto-merge), so no Engineer runs `aidenhq merge`. Still the Tier 1 `local-merge` record the AI
// reviewer reads; a done or cancelled task, and a change whose checks are red or running, is never asked for.
const localMerge = () => localMergePass({
  open: () => localCode.open(),
  task: async (id) => { const r = await cpJson(`/api/issues/${encodeURIComponent(id)}`); return r as { status?: string; assigneeAgentId?: string | null }; },
  grant: (agent) => grantsTable().agents?.[agent],
  prior: (task) => records.list(["review", "owner", "approved", "claimed", "done", "failed", "stale", "rejected"], 500, { task, kinds: ["codehost-local.merge"] }),
  file: (b) => writes.fileLocalMerge(b),
  restart: (c) => localCode.checks(c.repo, c.head, c.base, true),
  log,
});
every(() => void (localHost() ? localMerge() : Promise.resolve({ filed: [], restarted: [], skipped: [] })).catch((e: Error) => log("local auto-merge pass failed", { err: String(e.message ?? e).slice(0, 300) })), 60_000);
once(() => void (localHost() ? localMerge() : Promise.resolve({ filed: [], restarted: [], skipped: [] })).catch(() => {}), 90_000);
// A kernel-admitted job's computer (boxes.ts): made below, once the gateway it needs is up; a job that ends releases it.
let boxes: Boxes | undefined;
const agentKey = (id: string) => String(grantsTable().agents?.[id]?.key ?? id);
/**
 * The MCP servers the agent's compiled config declares (config/paperclip.yaml `agents.<key>.mcp_servers`, keyed by the grants
 * entry's `key`): the launch compares them with the job's frozen authority, so a declared server is never silently absent.
 * undefined (unknown agent, missing or unreadable config) skips the check; a parse failure is logged, never thrown.
 */
type CompiledConfig = { agents?: Record<string, { mcp_servers?: unknown }> };
const declaredServers = (agentId: string): string[] | undefined => {
  const key = grantsTable().agents?.[agentId]?.key;
  if (!key) return undefined;
  let compiled: CompiledConfig;
  try {
    compiled = (YAML.parse(readFileSync(path.join(configDir, "paperclip.yaml"), "utf8")) ?? {}) as CompiledConfig;
  } catch (e) {
    log("couldn't read the compiled config's MCP declarations", { err: String((e as Error).message ?? e).slice(0, 200) });
    return undefined;
  }
  const declared = compiled.agents?.[key]?.mcp_servers;
  return Array.isArray(declared) ? declared.filter((n): n is string => typeof n === "string") : undefined;
};
// The agents a module dispatches (compile: an agent runs on the engine runner, and this module holds kernel.jobs), by key.
const mayDispatch = dispatchesFrom(() => (modulesFile().modules ?? {}) as never, () => grantsTable().agents ?? {});
const jobs = createJobs({
  db: records.db, cfg: sandbox, log, facts, agentKey, boxWrap: BOX_EXEC_WRAP, onEnd: (id) => boxes?.ended(id), mayDispatch, stateNeed: (e, episode) => warnStateNeed(e, episode),
  cp: {
    task: async (id) => { const r = await cpApi(`/api/issues/${encodeURIComponent(id)}`); return r.ok ? ((await r.json()) as never) : undefined; },
  },
});
jobs.adopt();
// The wake inbox (wakes.ts): Paperclip events scan their task now; the reconcile poll scans every polled agent's open tasks.
// Outcomes posted on a job's task as its agent, once (outcomes.ts): the agent's own Paperclip key, setup's paperclip-agents/<id>.
const plugin = createPluginPost({ controlUrl, agentKey: (id) => secret(`paperclip-agents/${id}`), postKey: () => secret("paperclip_post_key") });
const outcomes = createOutcomes({ db: records.db, facts, agentKey, plugin, log, relay: createReplyRelay({ owner: ownerApi, queue: notify.queue, log }), delegates: (id) => delegateIds(grantsTable().agents, id, appOwners), finish: (task, agent) => checks.finish(task, { agent, via: "job_post" }), chatTask: (id) => { const t = grantsTable().agents?.[id]?.chat_task; return typeof t === "string" ? t : undefined; } });
const KNOWN_REPOS = ["@agents/*", "@product", "@instance", "@orgs", "@maintained"];
const localRepoExists = (repo: string) => { try { return existsSync(path.join(localCode.bare(repo), "HEAD")); } catch { return false; } };
const wakes = createWakes({
  db: records.db, facts, owner: wakeOwner, post: outcomes.post, log,
  // Setup's log tasks (review logs, chat tasks, Fleet issues): held by an agent, they wake nobody.
  containers: () => logTasks(grantsTable() as never),
  routineKey: (id) => (grantsTable().routine_keys as Record<string, string> | undefined)?.[id],
  dispatches: { may: mayDispatch, agents: (module) => Object.keys(grantsTable().agents ?? {}).filter((id) => mayDispatch(module, id)) },
  // Teams (team-routing.ts): a task on a team record goes to a member.
  grants: () => (grantsTable().agents ?? {}) as never,
  // A repo the instance's code hosts have (codehostRepos: the agents orgs, the product, the instance, github_orgs and the
  // maintained repos; a local/… one only once it exists). A branch, a path or a library named like owner/name is none.
  knownRepo: (repo) => (repo.startsWith(`${LOCAL_ORG}/`) ? localHost() && localRepoExists(repo) : covers(repo, KNOWN_REPOS, codehostRepos())),
  // No member can take it: an open parent hears it as a wake notice (as asker.tell does), else the owner.
  tellBlocked: async (task, text) => {
    // A parent that can't be read now is not a reason to lose the message: it goes to the owner, as with no parent at all.
    if (task.parentId && (await wakeNotice(ownerApi, task.parentId, text).catch(() => "retry")) === "posted") return;
    notify.queue({ kind: "alert", text });
  },
});
// One poll at a time, stopped by a drain like every timer; a failed one is logged and the next tries again.
let polling = false;
every(() => {
  if (polling) return;
  polling = true;
  void wakes.poll().catch((e: Error) => log("wake poll failed", { err: String(e.message ?? e).slice(0, 300) })).finally(() => { polling = false; });
}, (Number(env("AIDENHQ_WAKE_POLL_SECONDS", "")) || 60) * 1000);
// No idle agent-held task (idle.ts): agents' own waits (POST /v1/wait), and the idle sweep every 5 minutes.
const idle = createIdle({ db: records.db, facts, state: taskStates, wakes, owner: ownerApi, team: (id) => Boolean(grantsTable().agents?.[id]?.team), escalate, log });
// A connection only the owner can fix: the owner hears in their own conversation, background work gets the digest (connection-state.ts).
connectionState = createConnectionState({
  db: records.db, idle, wakes, queue: notify.queue, log,
  issue: (id) => escalateIssue(id),
  comments: async (id) => { const c = await cpJson(`/api/issues/${encodeURIComponent(id)}/comments?order=desc&limit=50`); return Array.isArray(c) ? c : []; },
  agentName: async (id) => String(((await cpJson(`/api/agents/${encodeURIComponent(id)}`)) as { name?: string }).name ?? "") || "AidenHQ",
  // The module's display name from its module.yaml (compile: its sign-in label, else its setup flow title), else its name.
  label: (m) => modulesFile().modules?.[m]?.label ?? m,
  connections, grants: () => grantsTable().agents ?? {},
  // Every code-host org the instance reaches (codehostRepos: github_orgs, the agents orgs, and the owners of the product,
  // instance and maintained repos): an sso/restricted need on any other org is stale, and tick clears it (connection-state.ts).
  // A tool call to a maintained repo's org is a live need, not a retired sync scope, so its org must stay allowed.
  orgs: () => codehostOrgs(),
  // The board's origin (declared below; read only when a need is routed, after the listeners are up).
  boardUrl: () => boardOrigins[0] ?? "http://localhost:3121",
});
every(() => connectionState?.tick(), 10 * 60_000);
let sweeping = false;
every(() => {
  if (sweeping) return;
  sweeping = true;
  void idle.sweep().catch((e: Error) => log("idle sweep failed", { err: e.message })).finally(() => { sweeping = false; });
}, 5 * 60_000);
// The disk stays bounded (workspaces.ts): closed and idle tasks' workspaces, cache layers, engine homes and left check folders
// go, sooner when a disk is over PRESSURE. Every 15 minutes, and once soon after start; one pass at a time.
const sweepFolders = createDiskSweep({ db: records.db, workDir: sandbox.workDir, stateDir: sandbox.stateDir, stopping: () => draining,
  stillClosed: async (task) => { const r = await ownerApi("GET", `/api/issues/${encodeURIComponent(task)}`); return r.status === 404 ? true : r.status === 200 ? ["done", "cancelled"].includes(String((r.json as { status?: string }).status)) : undefined; }, // 404: the task is gone, so is its workspace's reason to stay
  engines: () => Object.entries(readEngines(sandbox)).filter(([, e]) => e.state === "task").map(([k]) => k), log });
let diskSweeping = false;
const sweepDisk = () => {
  if (diskSweeping) return;
  diskSweeping = true;
  void sweepFolders().catch((e: Error) => log("disk sweep failed", { err: e.message })).finally(() => { diskSweeping = false; });
  try { pruneSkillRuntimes({ companiesDir: path.join(dataDir, "paperclip/instances/default/companies"), log }); } catch (e) { log("skill runtime prune failed", { err: (e as Error).message }); }
};
every(sweepDisk, 15 * 60_000);
once(sweepDisk, 60_000);
// A stop: the jobs go on for the next kernel (KillMode=process); this one stops following them, offsets saved. A restart
// (SIGUSR2) drains once the listeners are up (drain, below); before that it stops at once, as a stop does.
const stop = (signal: string) => { log("stopping: jobs left running for the next kernel", { signal, jobs: jobs.running() }); jobs.detach(); process.exit(0); };
let drain: () => void = () => stop("SIGUSR2");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => stop(sig));
process.on("SIGUSR2", () => drain());
// The finish gate (checks.ts): modules' task.finish checks (compile), holds placed as the owner.
// The Fleet Steward's operations (fleet-ops.ts): pause/resume, stop a run, restart a module's service, roll back.
const fleetOps = createFleetOps({
  db: records.db, owner: ownerApi, log,
  roles: (id) => (grantsTable().agents?.[id] as { roles?: string[] } | undefined)?.roles ?? [],
  services: () => Object.values(modulesFile().services ?? {}).flat(),
  // A task by its id or its identifier (WOR-12): the job rows carry both.
  running: (task) => (records.db.prepare("SELECT id FROM jobs WHERE state = 'running' AND (task = ? OR identifier = ?) ORDER BY id").all(task, task) as { id: string }[]).map((r) => r.id),
  stop: (job) => jobs.stopRunning({ job }, "fleet-steward"),
  note: (j, body) => outcomes.post(j, { kind: "notice", body }),
  generations: () => { const g = work.generations(); return "error" in g ? [] : g.generations; },
  launch: (unit, args) => applyHost.launch(unit, args),
  // An apply runs or waits: the host's apply lock is taken (a non-blocking flock fails), or an apply unit is queued
  // (ops/aidenhq-apply's transient units, before they reach the lock).
  applying: async () => {
    const locked = await new Promise<boolean>((ok) => execFile("flock", ["-n", path.join(env("AIDENHQ_DIR", repo), "data", "apply.lock"), "true"], (err) => ok(Boolean(err))));
    if (locked) return true;
    const any = (args: string[]) => new Promise<boolean>((ok) => execFile("systemctl", ["--user", ...args, "--no-legend", "aidenhq-apply-*"], (err, out) => ok(Boolean(err) || String(out).trim() !== "")));
    // A unit starting or running, or a start job still pending for one.
    return (await any(["list-units", "--type=service", "--state=activating,active"])) || (await any(["list-jobs"]));
  },
  recreate: (services) => composeRecreate({ dir: env("AIDENHQ_DIR", repo), composeFile: env("COMPOSE_FILE", "") })(services),
});
const work = createWork({ db: records.db, records, pauses: () => fleetOps.pauses(), generationsFile: path.join(env("AIDENHQ_STATE_DIR", path.join(process.env.HOME ?? "", ".local/state/aidenhq")), "generations.jsonl"), capacity: () => Number(computers().max) || 0 });
// Flow: what the kernel kept before the fact log, once per install (kernel_once marks it done; every record and job since
// writes its own facts), and the host's deploys as they settle (generations.ts).
records.db.exec("CREATE TABLE IF NOT EXISTS kernel_once (name TEXT PRIMARY KEY, at TEXT NOT NULL)");
if (!records.db.prepare("SELECT 1 FROM kernel_once WHERE name = 'flow-backfill'").get()) {
  try {
    log("flow backfill", { recorded: backfillLocal(records.db, facts, { agentKey: (id) => grantsTable().agents?.[id]?.key }) });
    records.db.prepare("INSERT OR IGNORE INTO kernel_once (name, at) VALUES ('flow-backfill', ?)").run(new Date().toISOString());
  } catch (e) { log("WARNING: flow backfill failed", { err: String((e as Error).message) }); }
}
const deploys = createDeploys({ db: records.db, file: path.join(env("AIDENHQ_STATE_DIR", path.join(process.env.HOME ?? "", ".local/state/aidenhq")), "generations.jsonl"), repo });
const syncDeploys = () => { try { deploys(); } catch (e) { log("WARNING: deploy facts failed", { err: String((e as Error).message) }); } };
syncDeploys();
every(syncDeploys, 60_000);
// One live grader token per task, reused while it has time left and dropped when the task's hold resolves. Kind grader (never an
// agent's identity: whoami and every agent check refuse it) that names the assignee, so the gateway charges its calls to that
// agent on that task (its task cap, gateway/lib.ts).
const graderTokens = new Map<string, { token: string; exp: number }>();
const graderToken = (task: string, agent: string) => {
  const live = graderTokens.get(task);
  if (live && live.exp > Date.now() + 5 * 60_000) return live.token;
  const ttlMs = 15 * 60_000;
  const token = mintToken(secret("gateway_job_secret"), { kind: "grader", agentId: agent, issueId: task, component: "Grader", ttlMs });
  graderTokens.set(task, { token, exp: Date.now() + ttlMs });
  return token;
};
const checks = createChecks({ db: records.db, registry: checksRegistry, owner: ownerApi, secret, resolver, log, agentKey: (id) => grantsTable().agents?.[id]?.key, graded: (id) => grantsTable().agents?.[id]?.graded === true, pending: (task) => records.list(["review", "owner", "approved"], 100, { task }),
  // A task's own change requests on this server: none may be open when it closes (a green-but-unmerged change is not shipped).
  localChanges: async ({ id, identifier }) => localHost() ? (await localCode.open()).filter((c) => (c.task && (c.task === id || c.task === identifier))).map((c) => ({ url: c.url, checks: c.checks.map(({ ok, pending }) => ({ ok, pending })) })) : [] });
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
// The first run's model step (/setup/model; the models-openrouter module's flow, served on the admin listener): OpenRouter's
// PKCE and a 1-token check on the gateway's upstream, against the module's default model (CHECK_MODEL). Its readiness is
// model_ready and the first-run redirects.
const upstream = env("AIDENHQ_GATEWAY_UPSTREAM", "https://openrouter.ai/api/v1");
const model = createModelStep({
  upstream,
  model: () => CHECK_MODEL,
  vault: { get: secret, exists: (n) => existsSync(path.join(secretsDir, n)), save: firstRun.save },
  fits: (key) => { const f = firstRun.fields().find((x) => x.secret === MODEL_KEY); return !f || secretFits(f, key); },
  dayCap: () => gw.dayLimit(), // the limit the gateway enforces, its default included
  log,
});
// A module's declared setup secrets from the board (save_secret, setup_status): the same vault writes, then that module's
// services and every other one mounting the secret recreated in the checkout under the apply lock.
const moduleSecrets = createModuleSecrets({
  fields: firstRun.fields, has: firstRun.has, save: firstRun.save,
  services: (module) => { const s = modulesFile().services ?? {}; return Object.hasOwn(s, module) ? s[module] : undefined; },
  mounts: (secret) => { const m = modulesFile().mounts ?? {}; return Object.hasOwn(m, secret) ? m[secret]! : []; },
  recreate: composeRecreate({ dir: env("AIDENHQ_DIR", repo), composeFile: env("COMPOSE_FILE", "") }),
  log,
});
// A module's own check of a setting or a pasted secret before it is saved (module.yaml `validate:`, module-validate.ts).
const moduleValidate = createModuleValidate({ registry: checksRegistry, services: (m) => { const s = modulesFile().services ?? {}; return Object.hasOwn(s, m) ? s[m] : undefined; }, secret, resolver, facts, log });
// Admission (admission.ts) and the kernel's own computers for the jobs it admits (boxes.ts): capacity is settings.computers_max,
// the number the launcher's pool reads too (config/computers.json `max`; missing, nothing is admitted).
const computers = watched(path.join(configDir, "computers.json"), (j) => j as { max?: unknown; checks?: unknown; connections?: Record<string, { tool_timeout_sec?: number }> }, {});
// A job's requests for its task's next turn (`aidenhq reset|engine|cleanup`): boxes does the cleanup, admission the rest; and
// its prechecks (`aidenhq review`, the precheck below), counted here.
const jobTools = createJobTools({ db: records.db, secret: () => secret("gateway_job_secret"), orgs: () => repos().agentsOrgs, engines: () => Object.entries(readEngines(sandbox)).filter(([, e]) => e.box === true).map(([k]) => k) });
// Each module's code host grant (its module.yaml `codehost:`), and what its @ names resolve to: the code host broker's, and
// what an engineer job's dispatcher may clone into its task's workspace.
const codehostGrants = (): OpsGrant[] => Object.entries(modulesFile().modules ?? {}).flatMap(([module, d]) => ((d as { codehost?: OpsGrant }).codehost ? [{ ...(d as { codehost: OpsGrant }).codehost, module }] : []));
const codehostRepos = () => ({ instance: baseRepos.instance, product: baseRepos.product, agentsOrgs: repos().agentsOrgs, orgs: modulesFile().repos?.orgs, maintained: modulesFile().repos?.maintained });
boxes = createBoxes({
  db: records.db, cfg: sandbox, jobs, stopping: () => draining, call: launcherClient(launcherUrl, () => secret("launcher_kernel_key")), secret, whoami,
  connections: () => computers().connections ?? {}, declaredServers, handbook: (agent) => {
    const book = handbookFrom(configDir)(agent), key = String(grantsTable().agents?.[agent]?.key ?? "");
    if (book !== undefined && !key) throw new Error(`agent ${agent} has no key in the grants table`);
    return book === undefined ? undefined : fillMemory(book, memory.view(key));
  }, cleanup: jobTools.cleanup, log, once: outcomes.once,
  stateNeed: (e, episode) => warnStateNeed(e, episode),
  attachments: {
    list: async (task) => (await cpJson(`/api/issues/${encodeURIComponent(task)}/attachments`)) as { originalFilename?: string; byteSize?: number }[],
    add: async (task, name, type, data) => {
      const company = String(((await cpJson(`/api/issues/${encodeURIComponent(task)}`)) as { companyId?: string }).companyId ?? "");
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(data)], { type }), name);
      // The owner key, multipart: no JSON content-type.
      const r = await ownerFetch(new URL(`/api/companies/${company}/issues/${encodeURIComponent(task)}/attachments`, controlUrl), { method: "POST", headers: { authorization: `Bearer ${secret("paperclip_board_key")}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`the control plane answered ${r.status} attaching ${name}`);
    },
  },
  // A box commits as the owner (name and noreply email from the code host, with the AidenHQ trailer its commit-msg hook adds) while
  // GitHub is connected; otherwise as the agent itself (<key>@<commit_domain>), which only a `local/…` repo takes.
  identity: async (id) => { const g = (grantsTable().agents ?? {})[id] as { key?: string; name?: string } | undefined; const key = String(g?.key ?? id); const agent = String(g?.name ?? key); return { ...((await codehost.identity()) ?? { name: agent, email: `${key}@${modulesFile().commit_domain ?? "aidenhq.ai"}` }), agent }; },
  clones: {
    text: async (task) => { const i = (await cpJson(`/api/issues/${encodeURIComponent(task)}`)) as { title?: string; description?: string | null }; return `${i.title ?? ""}\n${i.description ?? ""}`; },
    may: (module, repo) => covers(repo, codehostGrants().find((g) => g.module === module)?.clone?.repos, codehostRepos()),
  },
});
// The computer pool (pool.ts): agent jobs bounded by settings.computers_max, check jobs by settings.check_computers_max.
const pool = createPool({ capacity: () => Number(computers().max) || 0, checkCapacity: () => Number(computers().checks) || 0, agentLive: () => (records.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('admitted', 'running')").get() as { n: number }).n });
const admission = createAdmission({
  pool, db: records.db, facts, grants: () => (grantsTable().agents ?? {}) as never, kinds: registry, capacity: () => Number(computers().max) || 0,
  spend: (agent, task) => gw.exhausted(agent, task), mayDispatch, wakes: wakeInbox(records.db), nextTurn: jobTools,
  routineKey: (id) => (grantsTable().routine_keys as Record<string, string> | undefined)?.[id], launch: (job) => boxes!.launch(job), release: (id) => boxes!.release(id), log,
  // A task gone is none (a refusal dispatch drops); a read that fails otherwise is a 503, so the wake comes back.
  cp: { task: async (id) => {
    const r = await cpApi(`/api/issues/${encodeURIComponent(id)}`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new JobError(503, "task-unreadable", `task ${id} couldn't be read now (${r.status}); try again shortly`);
    return (await r.json()) as never;
  } },
});
afterPrevious(() => void admission.recover().catch((e: Error) => log("WARNING: couldn't recover the previous kernel's admitted jobs", { err: e.message })));
const stopTending = boxes.start();
// The GitHub code host's operations, brokered for modules under their own codehost grants (codehost.ts).
const codehost = createCodehost({ repos: codehostRepos, grants: codehostGrants, kind: () => Object.values(moduleKinds()).find((k) => k.module === CODEHOST && k.executor), secret, resolver,
  // A code host op's needs_owner answer is connection state on the same record the MCP proxy feeds (proxy.ts): the module's
  // own call has no task chain, so it is background and reaches the owner's digest once a day (and, for a full cause, every
  // agent's connections-down list). The op's own answer goes back unchanged.
  recordNeed: (module, need) => void connectionState?.hit({ kind: "module", module, roles: [], tools: {}, credential: "" }, CODEHOST, need)
    .catch((e: Error) => log("connection need not routed", { connection: CODEHOST, module, err: String(e?.message ?? e).slice(0, 300) })),
  // A 2xx op is the owner's sign-in working, as the MCP proxy's SIGNED_IN answer is: the full causes clear and the tasks waiting on
  // them wake; a scope/sso/restricted need is partial and stays until the owner grants it.
  clearNeed: () => { try { connectionState?.ok(CODEHOST, { fullOnly: true }); } catch (e) { log("connection state not cleared", { connection: CODEHOST, err: String((e as Error)?.message ?? e).slice(0, 300) }); } },
  // codehost-local's snapshot for `local/…` repos, when that module is enabled.
  local: () => (localHost() ? { snapshot: localSnapshot({ bare: localCode.bare }), bundle: (repo) => localCode.bundle(repo) } : undefined) , noteObject: (ref, record) => records.addObjects(record, [ref]) });
// Check jobs (checkjobs.ts): credential-free boxes of the launcher's, snapshots from the module that provides them.
const checkJobs = checkJobsFrom({ pool, db: records.db, secret, recipes: () => modulesFile().check_jobs ?? {}, ask: codehost.ask, call: launcherClient(launcherUrl, () => secret("launcher_kernel_key")), workDir: sandbox.workDir, gatewayUrl: `${sandbox.boxGatewayUrl}/api/v1`, spent: (runKey) => gw.spentByKey(runKey), tokens: (runKey) => gw.tokensByKey(runKey), refused: (runKey) => gw.refusedByKey(runKey), log });
const lane = createLane({ once: outcomes.once, owner: ownerApi, grantsFile: grantsTable, facts, log, postAsAgent: lanePoster(outcomes) });
// The board's reads of module services that declare a board API (providers.board), through the kernel.
const moduleBoardApi = createBoardApi({ decl: (m) => (modulesFile().modules?.[m] as { board?: { url: string; auth_secret: string } } | undefined)?.board, secret, resolver });
// A job's precheck (`aidenhq review`): the write it would file, planned and tiered but never filed, read as the review loop reads
// a record and decided as writes.review decides; `slot` counts the reviewer call against the job's PRECHECKS (jobtools.ts).
async function precheck(who: Parameters<typeof writes.preview>[0], b: { kind: string; args: unknown }, slot: () => (failure: unknown) => void) {
  const p = await writes.preview(who, b);
  if (p.satisfied !== undefined) return { text: "Nothing to do: the code host says it is already done.", reason: p.satisfied };
  if (p.rec!.tier === 0) return { text: "Tier 0: this write runs without a review." };
  // Filed, it would go as code routes it: to the owner (his veto, autonomy off), or with the verdict only a note for him (tier0).
  if (p.rec!.state === "owner") return { text: "The owner decides this write (his veto on this task, or autonomy off): no review. Nothing was filed." };
  const shadow = [grantsTable().autonomy, p.rec!.cap?.value].some((a) => a === "tier0" || a === "off");
  const v = await reviewLoop.precheck(p.rec!, async (request) => {
    const refund = slot();
    // A call that never reached a reviewer cost nothing: the precheck is the job's again (jobtools.ts decides which failures).
    return (await reviews.request(request).catch((e) => { refund(e); throw e; })) as Verdict;
  });
  const hard = v.model === "kernel/code" && v.decision === "reject";
  const said = v.decision === "approve" ? "would approve it" : v.decision === "reject" ? "would reject it" : v.code === "owner_veto" ? "would leave it to the owner (their veto on this task)" : shadow ? "couldn't finish (a filed write is tried once more, then goes to the owner, since autonomy is below full)" : "couldn't finish (a filed write is tried once more, then approved)";
  const note = shadow && !hard && v.code !== "reviewer_failed" && v.code !== "owner_veto" ? " Autonomy is below full, so filed, its verdict would be a note and the owner decides." : "";
  return { decision: v.decision, text: `${v.model === "kernel/code" ? "The kernel's own rules" : `The AI reviewer (${v.model})`} ${said}.${note} Nothing was filed.`, reason: v.reason };
}
// Sharing a local module (module-share.ts): the preview, and the owner's board save filed as his own github.publish_module.
const sharing = createSharing({
  instanceDir, configDir, instanceRepo: () => repos().instance, secrets: () => vaultValues(secretsDir),
  memory: () => memory.list().flatMap(({ key }) => memory.read(key).doc.facts.map((f) => f.fact)),
  tip: (b) => codehost.publishTip(b), ownerTask: settingsChange.ownerTask,
  filed: (task) => records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 50, { task, kinds: ["github.publish_module"] }).length > 0,
  file: (args, task, owner) => writes.fileKernel("github.publish_module", { args, task, requester: SETTINGS, owner }),
});
const backplane = createBackplane({ projects, idle, memory, sharing, boardApi: moduleBoardApi, facts, repos: codehostRepos, healthProbe, settingsChange, validate: moduleValidate, routing, events, connectionHealth: createConnectionHealth({ connections, resolver }), connectionState, healthKey: () => secret("health_probe_key"), codehost: codehost.op, checks, checkJobs, lane, whoami, asserter, grantsFile: grantsTable, log, writes, records, channels, brake, notify, owner: ownerApi, ownerRaw: (p) => cpApi(p), modules: modulesFile, boardKey: () => secret("gateway_board_key"), reviews, reviewerKey: () => secret("reviewer_key"), jobs, admission, outcomes, wakes, tasks: moduleTasks, work, flow, taskStates, graderToken, dropGraderToken: (task) => graderTokens.delete(task), eventsKey: () => secret("paperclip_events_key"), jobTools, precheck, repoBundle: (module: string, repo: string) => codehost.ask(module, "bundle", { repo, ref: "HEAD" }), advisories: advisories.list, accounts: createAuthApi({ accounts: () => accounts, whoami, boardKey: () => secret("gateway_board_key"), recoveryKeyWaiting: () => Boolean(firstRun.recoveryKey()), modelReady: model.ready, operatorKey: () => secret(OPERATOR_KEY), secrets: moduleSecrets, decide: channels.decideCard, update: (to, by) => updates.requestMain(to, by), validate: moduleValidate }), proxy: (req, res, c) => proxy(req, res, c!), cp: createCp({ sawn: (id) => jobs.sawn(id), projects, appOwners: () => appOwners(), asserter, whoami, plugin, once: outcomes.once, agentKey: (id) => secret(`paperclip-agents/${id}`), grants: () => grantsTable().agents ?? {}, fleetIssues: () => String(grantsTable().fleet_issues ?? ""), controlUrl, checks, observe: wakes.observe, log }) as never, boardCp: createBoardCp({ controlUrl, key: () => secret("paperclip_board_key"), fetch: ownerFetch, observe: wakes.observe, facts, log, ownerFiled: (id) => void records.db.prepare("INSERT OR IGNORE INTO task_filers (task, filer) VALUES (?, 'owner')").run(id) }) as never });
// The admin listener's accounts (data/kernel/auth/auth.db) and pages. Accounts not moved yet, or a malformed URL setting: the
// listener refuses while every other part of the kernel serves.
const urlOf = (v: string) => { try { return v ? new URL(v) : undefined; } catch { log("ignoring a malformed URL setting", { value: v.slice(0, 100) }); return undefined; } };
const adminUrl = urlOf(env("AIDENHQ_ADMIN_URL", ""));
const boardUrl = urlOf(env("BOARD_LAN_URL", ""));
// The front door's name with and without its port (proxies differ in the Host they pass on).
const loopback = env("AIDENHQ_ADMIN_HOSTS", "localhost:3120,127.0.0.1:3120").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const adminHosts = [...loopback, ...(adminUrl ? [adminUrl.host, adminUrl.hostname] : [])];
const adminOrigins = [...loopback.map((h) => `http://${h}`), ...(adminUrl ? [adminUrl.origin] : [])];
// The sign-in listener's own Host names (the gate calls it at 127.0.0.1:3129), and shared apps' config (scripts/edge.ts).
const signinHosts = env("AIDENHQ_SIGNIN_HOSTS", "127.0.0.1:3129,localhost:3129").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const gateFile = path.join(configDir, "gate.json");
const gateInfo = () => readGate(gateFile);
const accountLog = { info: (o: object, m: string) => log(m, o as never), warn: (o: object, m: string) => log(m, o as never), error: (o: object, m: string) => log(m, o as never) };
// apps-mcp's internal API (the apps-platform module's service), with its internal token: a shared app's manifest.
const appOwners = async (): Promise<string[]> => {
  const t = await resolver.resolve(`${env("AIDENHQ_APPS_INTERNAL_URL", "http://apps-mcp:8090")}/internal/apps`);
  const r = await fetch(`http://${t.host}:${t.port}${t.path}`, { headers: { authorization: `Bearer ${secret("apps_internal_token")}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`apps-mcp answered ${r.status}`);
  return ((await r.json()) as { owner?: string }[]).flatMap((a) => (a.owner ? [a.owner] : []));
};
const manifest = async (app: string): Promise<Manifest> => {
  const t = await resolver.resolve(`${env("AIDENHQ_APPS_INTERNAL_URL", "http://apps-mcp:8090")}/internal/apps/${encodeURIComponent(app)}/manifest`);
  const r = await fetch(`http://${t.host}:${t.port}${t.path}`, { headers: { authorization: `Bearer ${secret("apps_internal_token")}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`apps-mcp answered ${r.status}`);
  return (await r.json()) as Manifest;
};
// The board's origins: its front door (BOARD_LAN_URL) and its loopback addresses (the SSH tunnel, local mode).
const boardOrigins = env("AIDENHQ_BOARD_ORIGINS", [boardUrl?.origin, "http://localhost:3121", "http://127.0.0.1:3121"].filter(Boolean).join(",")).split(",").map((o) => o.trim()).filter(Boolean);
const ttl = Number(env("AIDENHQ_LINK_TTL_HOURS", ""));
const accounts = await import("./accounts.ts").then((a) => a.openAccounts({
  dataDir, hosts: [...adminHosts, ...signinHosts], origins: adminUrl ? [adminUrl.origin] : [], ...(adminUrl ? { adminUrl: adminUrl.origin } : {}), boardUrl: boardOrigins[0],
  edgeSecret: () => secret("edge_board_secret"), gateSecret: () => secret("gate_board_secret"), gate: gateInfo,
  // The gate's account map (compile makes it with settings.edge); without shared apps (no config/gate.json) there's no gate to tell.
  gateAccountsFile: path.join(dataDir, "gate", "accounts.json"),
  ...(ttl > 0 ? { linkTtlHours: ttl } : {}), // settings.owner_email (compile writes it to config/kernel/modules.json): the only email setup makes the owner's account.
  ownerEmail: () => modulesFile().owner?.email,
  notify: toOwner("done"), manifest,
  wake: webhookWake(path.join(env("AIDENHQ_SECRETS_DIR", ""), "app_request_webhook_url"), path.join(env("AIDENHQ_SECRETS_DIR", ""), "app_request_webhook_secret"), accountLog, controlUrl),
  feedbackWake: routineWake(ownerApi, accountLog),
  log: accountLog,
}))
  .catch((e: Error) => (log("accounts off", { err: e.message }), undefined));
if (accounts) {
  // Apps come and go with applies (config/gate.json): a removed app's rows leave the gate's map within a minute; manifests
  // refresh, undelivered request wakes and a failed write retry on the same beat.
  void accounts.syncGate();
  every(() => void accounts.syncGate(), 60_000);
}
// The board's origins are the module UI origins a session may be handed to (/auth/handoff).
const uiOrigins = () => Object.fromEntries(boardOrigins.map((o) => [o, "board"]));
// Code review's optional GitHub App (github-app.ts), made from the admin pages while the github module is on: its id and key go
// into that module's own vault dir, which its process reads at /state.
const githubVault = path.join(secretsDir, "modules", "github");
const githubApp = Object.hasOwn(modulesFile().modules ?? {}, "github") ? {
  name: () => { const i = /^([a-z0-9-]+)\.aidenhq\.ai$/.exec(String(modulesFile().commit_domain ?? ""))?.[1]; return `AidenHQ review${i ? ` ${i}` : ""}`.slice(0, 34); },
  ready: () => existsSync(path.join(githubVault, "github-app", "key.pem")),
  convert: (code: string) => convertGithubApp(code),
  save: (app: MadeApp) => saveGithubApp(app, githubVault),
  remove: () => removeGithubApp(githubVault),
} : undefined;
const admin = accounts && createAdmin({ accounts, firstRun, model, githubApp, uiOrigins, updates, doorSource: () => doorSource(gateInfo()), boardUrl: () => boardOrigins[0], ownerMessage: (b) => channels.ownerMessageAs("web", b, () => chiefOfStaff(grantsTable().agents)), owner: ownerApi, hosts: () => adminHosts, origins: () => adminOrigins, frameOrigins: () => boardOrigins, log });

// Claimed records a restart left without an outcome: their executors say how they went (never replayed). Executors may
// still be starting at boot, so once, a minute in.
// Run once the previous kernel has exited (afterPrevious: it finishes what it was executing), and only on records it claimed.
// Once the previous kernel has exited and a minute in (executors may still be starting at boot), then every 10 minutes while
// an executor's status couldn't be read (writes.ts reconcile: an hour, then unknown).
const reconcile = () => void writes.reconcile(undefined, new Date(started).toISOString()).then((u) => u.length && log("records left unknown", { records: u }), (e: Error) => log("reconcile failed", { err: e.message }));
afterPrevious(() => { once(reconcile, 60_000); every(reconcile, 10 * 60_000); });
// Approved records not yet run (a restart between the decision and the claim, a check that failed transiently): every minute.
every(() => writes.retryApproved(), 60_000);
once(() => writes.retryApproved(), 60_000);
// Open records past their 7 days are cancelled here, not on a read of the lists (records.ts expire).
const expireRecords = () => { try { records.expire(); } catch (e) { log("records expiry failed", { err: String((e as Error).message ?? e).slice(0, 300) }); } };
every(expireRecords, 60_000);
once(expireRecords, 5_000);

const gw = createGateway({
  dbFile: path.join(dataDir, "kernel", "kernel.db"),
  legacyDbFile: path.join(dataDir, "gateway", "usage.db"), // the old ledger: merged in at every start while it is there
  grantsFile,
  settingsFile: path.join(configDir, "gateway.json"),
  asCaller: createAsCaller({ whoami, connections, asserter, log }), // a module's model calls for its caller (cp.ts)
  secret,
  upstream,
  paperclipUrl: controlUrl,
  // Past a spend limit (no model call: the owner's notice path); past a task's cap, whoever asked for the task hears it.
  notifyOwner: (text) => toOwner("alert")(text),
  tellDelegator: async (task, text) => {
    const issue = await issueOf(task);
    if (issue?.parentId && (await wakeNotice(ownerApi, issue.parentId, `**${issue.identifier ?? task}:** ${text}`).catch(() => "retry")) === "posted") return;
    toOwner("alert")(`${issue?.identifier ?? task}: ${text}`);
  },
  jobLive: (id) => ["admitted", "running"].includes(String(admittedJob(records.db, id)?.state)),
  log,
});
// The previous kernel's check runs are its own until it has exited (it hands their box runs on as it drains); then this one
// follows those again to their end, and what never reached its box is lost. Asked only after the gateway exists: with no
// previous kernel alive afterPrevious runs at once, and a lost run's cost is read from the gateway (spent).
afterPrevious(() => void checkJobs.recover().catch((e: Error) => log("WARNING: adopted checks failed outside their own handling", { err: String(e?.message ?? e).slice(0, 300) })));

// host:port pairs. Each binds on its own: the backplane address exists only once compose is up, so a failed bind is retried
// (backoff up to a minute) while the others keep serving (a draining kernel's ports included). One process owns a port at a
// time: never SO_REUSEPORT, which would let any process of this user take a share of the model calls and their credentials.
const servers: http.Server[] = [];
function listen(addr: string, ci = false, handler: http.RequestListener = (req, res) => gw.handle(req, res, { ci })) {
  const i = addr.lastIndexOf(":");
  const server = http.createServer(handler);
  servers.push(server);
  // A model stream can run for many minutes (requestTimeout covers receiving the request, not the answer). The CI listener
  // faces jobs that run untrusted code: a request must arrive within a minute, and few connections at once.
  server.requestTimeout = ci ? 60_000 : 0;
  if (ci) server.maxConnections = 32;
  let wait = 1000;
  const bind = () => { if (!draining) server.listen(Number(addr.slice(i + 1)), addr.slice(0, i)); };
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
every(ciCheck, 60_000);

// The monitoring module's metrics (lib.ts metricsText, and the event loop's health below): node-exporter textfiles every 30
// seconds, written only while the module's directory exists. Files, not a route: nothing new listens, and a stale file shows
// the kernel is down.
const textfile = path.join(dataDir, "modules", "monitoring", "textfile");
// The event loop's delay (p99 and max) and utilization over each 30-second window: the histogram starts over at each write.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let loopUse = performance.eventLoopUtilization();
const loopText = () => {
  const use = performance.eventLoopUtilization();
  const busy = performance.eventLoopUtilization(use, loopUse).utilization;
  loopUse = use;
  const p99 = loopDelay.percentile(99) / 1e9, max = loopDelay.max / 1e9;
  loopDelay.reset();
  const gauge = (name: string, help: string, v: number) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Math.round(v * 1e4) / 1e4}\n`;
  return gauge("aidenhq_kernel_event_loop_delay_p99_seconds", "The kernel's event loop delay, 99th percentile over the last 30 seconds.", p99)
    + gauge("aidenhq_kernel_event_loop_delay_max_seconds", "The kernel's longest event loop delay over the last 30 seconds.", max)
    + gauge("aidenhq_kernel_event_loop_utilization", "The share of the last 30 seconds the kernel's event loop was busy.", busy);
};
const writeProm = (name: string, text: string) => {
  const tmp = path.join(textfile, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path.join(textfile, name));
};
every(() => {
  const loop = loopText();
  if (!existsSync(textfile)) return;
  try {
    writeProm("gateway.prom", gw.metricsText());
    writeProm("kernel.prom", loop);
  } catch (e) {
    log("metrics write failed", { err: String((e as Error).message).slice(0, 200) });
  }
}, 30_000);

// A restart (ops/run-draining.sh): the next kernel is starting. This one stops its jobs' watchers (offsets saved: the next one adopts
// them), stops following its checks' box runs (the next one follows them from their rows), its timers and its listeners, so
// the next one can bind them; then it serves only the calls it holds (idle connections
// closed, so callers reconnect to the next one) and exits when its model calls, the checks still before or after their box run and the job launches it had in
// flight have finished (a launch that gets its box now gives it back: boxes.ts `stopping`), or at DRAIN_MS (the next kernel settles what
// is left: lib.ts sweep and true-up, afterPrevious above).
drain = () => {
  if (draining) return;
  draining = true;
  const t0 = Date.now();
  log("draining: the next kernel takes new calls; model calls in flight finish here", { inflight: gw.inflight(), jobs: jobs.running() });
  jobs.detach();
  checkJobs.detach();
  stopTending();
  for (const t of timers) clearTimeout(t);
  drainSignal.abort();
  // The ledger's own timers stop now; it closes once the calls it holds and the true-up in flight have settled.
  let truedUp = false;
  void gw.stop().finally(() => { truedUp = true; });
  for (const s of servers) if (s.listening) s.close();
  const done = () => {
    for (const s of servers) s.closeIdleConnections();
    const t = Date.now() - t0;
    if ((gw.inflight() > 0 || !truedUp || wakeWrites > 0 || admission.inflight() > 0 || writes.inflight() > 0 || checkJobs.inflight() > 0 || notices.inflight()) && t < DRAIN_MS) return;
    log("drained: exiting", { inflight: gw.inflight(), launches: admission.inflight(), writes: writes.inflight(), wake_writes: wakeWrites, checks: checkJobs.inflight(), notices: notices.inflight(), ms: t });
    if (gw.inflight() === 0 && truedUp) gw.close();
    process.exit(0);
  };
  done();
  setInterval(done, 1000);
};
