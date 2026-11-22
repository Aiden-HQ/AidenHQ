#!/usr/bin/env node
// Idempotently provision Paperclip for AidenHQ from config/paperclip.yaml:
// board login/claim, board API key, company, labels, agents, the ops-mcp agent key,
// tool connections, routines and the transcript-watcher webhook.
//
//   node scripts/paperclip-setup.ts            (prompts for your Paperclip login once)
//
// Env overrides: PAPERCLIP_URL, PAPERCLIP_EMAIL, PAPERCLIP_PASSWORD, PAPERCLIP_NAME,
// AIDENHQ_ENV_FILE, AIDENHQ_SKIP_RESTART=1, AIDENHQ_PAPERCLIP_CONFIG (config file to apply,
// default config/paperclip.yaml; use it to provision a second company).
// Secrets are written to AIDENHQ_SECRETS_DIR (0600) and never printed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureBackupRetention, ensureChatTasks, ensureFleetIssues, ensureMemoryInboxes, ensureReviewLogs, holdFleetIssues, grantEntry, mapLimit } from "./modules.ts";
import { busyRemovedMembers, retireUnconfigured } from "./retire-agents.ts";
import { routineDrift, syncAgents } from "./paperclip-diff.ts";
import { ensureAgentKeys, ensureEventsPlugin } from "./paperclip-events.ts";
import { agentSkills, handbookParts, laneHandbook, readInstructions as readHandbook } from "./handbook.ts";
import { recoverStalePid } from "./paperclip-recover.ts";

/** Paperclip rows, the compiled config and the module catalog: JSON read at run time, used field by field. */
type Obj = Record<string, any>;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromScripts = createRequire(join(repo, "scripts/package.json"));
let YAML: any;
try {
  YAML = requireFromScripts("yaml");
} catch {
  console.error("Missing dependency: run `npm ci --prefix scripts` first.");
  process.exit(1);
}

// ------------------------------------------------------------------ env & files

function loadEnv(path: string) {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return env;
}

const envFile = process.env.AIDENHQ_ENV_FILE ?? join(repo, ".env");
const dotenv = loadEnv(envFile);
const env = (k: string, d?: string) => (process.env[k] ?? dotenv[k] ?? d) as string;
const secretsDir = env("AIDENHQ_SECRETS_DIR");
// The secret vault (ops/vault): once it exists, its view must be mounted, or secrets written here land on disk in plaintext.
if (existsSync(join(process.env.HOME ?? "", ".local/share/aidenhq/vault.enc"))) {
  try { execFileSync("mountpoint", ["-q", secretsDir]); } catch { console.error(`The secret vault isn't mounted at ${secretsDir}: sudo systemctl start aidenhq-vault (ops/vault/README.md).`); process.exit(1); }
}
if (!secretsDir) fail("AIDENHQ_SECRETS_DIR is not set (.env)");
const baseUrl = env("PAPERCLIP_URL", "http://localhost:3100");
const origin = new URL(baseUrl).origin;
const configDir = resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
const customCfg = process.env.AIDENHQ_PAPERCLIP_CONFIG;
const cfgPath = customCfg ? resolve(repo, customCfg) : join(configDir, "paperclip.yaml");
if (!existsSync(cfgPath)) { console.error(`${cfgPath} is missing: run \`node scripts/compile.ts\` first.`); process.exit(1); }
const cfg: Obj = YAML.parse(readFileSync(cfgPath, "utf8"));
// Only the work company feeds config/system.yaml and keeps the upstream secret file names;
// any other company's per-company secrets get a suffix so they never overwrite work's.
const isWork = !customCfg || cfg.company.name === "work";
const companySuffix = isWork ? "" : `_${cfg.company.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

const secretPath = (name: string) => join(secretsDir, name);
const readSecret = (name: string) => (existsSync(secretPath(name)) ? readFileSync(secretPath(name), "utf8").trim() : "");
function writeSecret(name: string, value: string) {
  writeFileSync(secretPath(name), value, { mode: 0o600 });
  chmodSync(secretPath(name), 0o600);
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
const step = (msg: string) => console.log(`• ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP

let boardKey = "";
let sessionCookie = "";

async function api(method: string, path: string, body?: unknown, { auth = "board", allow = [] }: { auth?: string; allow?: number[] } = {}) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth === "board" && boardKey) headers.authorization = `Bearer ${boardKey}`;
  if (auth === "session") headers.cookie = sessionCookie;
  // Better Auth and the board-mutation guard both check Origin for browser-style calls.
  if (auth !== "board") headers.origin = origin;
  const res = await fetch(new URL(path, baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return { status: res.status, json, headers: res.headers };
}

// ------------------------------------------------------------------ prompts

// Never waits on a terminal that isn't there (an unattended install, ops/apply-config.sh from a script): it stops, saying what is missing.
function ask(question: string, { hidden = false }: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) fail(`no terminal to ask "${question.trim()}": set PAPERCLIP_EMAIL, PAPERCLIP_PASSWORD and PAPERCLIP_NAME (ops/setup.sh passes them)`);
  return new Promise<string>((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as ReturnType<typeof createInterface> & { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream }; // _writeToOutput and output are Node internals
    if (hidden) {
      rl._writeToOutput = (s: string) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer: string) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolveAnswer(answer.trim());
    });
  });
}

// ------------------------------------------------------------------ steps

async function waitForHealth() {
  step(`Waiting for Paperclip at ${baseUrl}`);
  for (let i = 0; i < 90; i++) {
    // After a minute without health, try the one known cause once (an unclean Postgres shutdown); else fail below.
    if (i === 30) { try { recoverStalePid({ repo, dataDir: resolve(repo, env("AIDENHQ_DATA_DIR", "./data")), env: { ...process.env, ...dotenv } }); } catch { /* fail loudly below */ } }
    try {
      const { json } = await api("GET", "/api/health", undefined, { auth: "none" });
      if (json.status === "ok") return json;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  fail("Paperclip did not become healthy (docker compose logs paperclip)");
}

async function ensureBoardKey(health: Obj) {
  boardKey = readSecret("paperclip_board_key");
  if (boardKey) {
    const me = await api("GET", "/api/cli-auth/me", undefined, { allow: [401, 403] });
    if (me.status === 200 && me.json.isInstanceAdmin) {
      step("Board API key is valid");
      return;
    }
    boardKey = "";
  }
  // The owner's Paperclip login: the environment, else what ops/setup.sh made it from (the owner's email, the vault's password).
  const email = env("PAPERCLIP_EMAIL") || cfg.settings?.owner_email?.value || (await ask("Paperclip email: "));
  const password = env("PAPERCLIP_PASSWORD") || readSecret("paperclip_owner_password") || (await ask("Paperclip password (8+ chars): ", { hidden: true }));
  let res = await api("POST", "/api/auth/sign-in/email", { email, password, rememberMe: true }, { auth: "none", allow: [401] });
  if (res.status === 401) {
    if (health.bootstrapStatus !== "bootstrap_pending") fail("sign-in failed (wrong password?)");
    const name = env("PAPERCLIP_NAME") || cfg.owner_name || (await ask("No account yet. Your name: "));
    step("Creating your Paperclip account");
    await sleep(3500); // auth endpoints allow 3 requests / 10 s
    res = await api("POST", "/api/auth/sign-up/email", { name, email, password, rememberMe: true }, { auth: "none" });
  }
  sessionCookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.includes("session_token"))
    .join("; ");
  if (!sessionCookie) fail("no session cookie returned by sign-in");

  const me = await api("GET", "/api/cli-auth/me", undefined, { auth: "session" });
  if (!me.json.isInstanceAdmin) {
    const claim = await api("POST", "/api/bootstrap/claim", {}, { auth: "session", allow: [409] });
    if (claim.status === 409) fail("this Paperclip instance is already owned by another account");
    step("Claimed instance ownership");
  }
  const key = await api("POST", "/api/board-api-keys", { name: "aidenhq-setup", expiresAt: null }, { auth: "session" });
  boardKey = key.json.token;
  writeSecret("paperclip_board_key", boardKey);
  step("Created board API key (saved to secrets dir)");
}

async function ensureCompany() {
  const { json } = await api("GET", "/api/companies");
  let company = json.find((c: Obj) => c.name === cfg.company.name && c.status !== "archived");
  if (!company) {
    company = (await api("POST", "/api/companies", { name: cfg.company.name, description: cfg.company.description ?? null })).json;
    step(`Created company ${company.name} (${company.issuePrefix})`);
  } else step(`Company ${company.name} exists (${company.issuePrefix})`);
  return company;
}

async function ensureLabels(companyId: string) {
  const { json: existing } = await api("GET", `/api/companies/${companyId}/labels`);
  for (const l of cfg.labels ?? []) {
    if (existing.some((e: Obj) => e.name === l.name)) continue;
    await api("POST", `/api/companies/${companyId}/labels`, { name: l.name, color: l.color });
    step(`Created label ${l.name}`);
  }
}

// The engine kinds the enabled engine modules provide (config/engines.json, written by compile).
const ENGINES = (() => { try { return JSON.parse(readFileSync(join(configDir, "engines.json"), "utf8")); } catch { return {}; } })();
const instanceDir = env("AIDENHQ_INSTANCE_DIR", "");
// An agent's own handbook (scripts/handbook.ts); a bad path fails setup.
const readInstructions = (a: Obj) => { try { return readHandbook(cfg, a, { repo, instanceDir }); } catch (e) { fail((e as Error).message); } };

/**
 * An agent's Paperclip record. Paperclip tracks and schedules (tasks are assigned to it, its routines file tasks for it); it runs
 * nothing: no env or secrets (record-agent.ts), and Paperclip never wakes it. The kernel runs its jobs (grants.json). The
 * metadata is the board's and the tools' view of it (setupKey is its identity).
 */
function agentBody(key: string, a: Obj) {
  const models = a.models ?? [];
  if (!Array.isArray(models) || models.some((m: unknown) => typeof m !== "string")) fail(`agent ${key}: models must be a list of model ids`);
  // A kind whose models carry a prefix (a router's) takes only those ids.
  const prefix = ENGINES[a.engine]?.model_prefix;
  if (prefix && a.profile === "engineer" && a.model && !a.model.startsWith(prefix)) fail(`agent ${key}: engine ${a.engine} needs model: ${prefix}<model>`);
  const engineer = a.profile === "engineer";
  return {
    name: a.name,
    role: "general",
    title: a.title ?? null,
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false, maxConcurrentRuns: 1 } },
    // Paperclip's own budget stop stays off (0 = no limit): spend limits are the model gateway's.
    budgetMonthlyCents: 0,
    defaultEnvironmentId: null,
    // An Engineer (runnerEngine): the board's picker and the tasks tools' engineer list. `brief: true`: its handbook is the
    // brief its delegators read. maxParallel: its parallel jobs (`max_parallel`).
    metadata: {
      setupKey: `aidenhq:${key}`, module: a.module, isolation: a.isolation, profile: a.profile, engine: a.engine, ...(a.model ? { model: a.model } : {}), ...(a.trial ? { trial: true } : {}),
      ...(engineer ? { runnerEngine: true, ...(a.image ? { box: true } : {}), ...(a.max_parallel ? { maxParallel: a.max_parallel } : {}), ...(models.length ? { models } : {}), ...(a.brief ? { brief: readInstructions(a)!.trim() } : {}) } : {}),
      ...display(key, a),
    },
  };
}

const display = (key: string, a: Obj) => {
  // avatar: a portrait bundled with the board, from the handbook's frontmatter.
  if (a.avatar !== undefined && !/^[a-z0-9-]{1,40}$/.test(a.avatar)) fail(`agent ${key}: avatar must be an avatar name (a-z, 0-9, -)`);
  // department: where the board's Agents page lists it, resolved from the registry by compile (scripts/modules.ts).
  if (a.department !== undefined && (typeof a.department?.id !== "string" || typeof a.department.name !== "string" || !Number.isInteger(a.department.order))) fail(`agent ${key}: department must be compiled (id, name, order): run scripts/compile.ts`);
  // A team (compile's teams): the team record lists its members ({key, name}); a member names its team record's key. The
  // board's Agents page draws the org from these.
  const team = a.team ? { team: { name: a.team.name, members: a.team.members.map((k: string) => ({ key: k, name: cfg.agents[k].name })) } } : {};
  // roles: what the agent does, kept on its record so a successor can be found by role once it is retired (retire-agents.ts).
  return { ...(a.avatar ? { avatar: a.avatar } : {}), ...(a.department ? { department: a.department } : {}), ...(!a.member_of && a.roles?.length ? { roles: a.roles } : {}), ...team, ...(a.member_of ? { memberOf: a.member_of, ...(a.repos?.length ? { repos: a.repos } : {}) } : {}) };
};

// Paperclip secrets only Paperclip-run agents used: deleted once no agent refers to them (after ensureAgents).
const OLD_SECRETS = ["openrouter-key", "unused-openai-key", "gateway-harness-key"];
async function dropOldSecrets(companyId: string) {
  const { json } = await api("GET", `/api/companies/${companyId}/secrets`);
  for (const x of json.filter((x: Obj) => OLD_SECRETS.includes(x.name))) {
    try {
      await api("DELETE", `/api/secrets/${x.id}`);
      step(`Removed Paperclip's ${x.name} secret (no agent runs in Paperclip)`);
    } catch (e) {
      console.warn(`! couldn't remove Paperclip's ${x.name} secret (delete it in Paperclip's UI): ${(e as Error).message}`);
    }
  }
}

const revInputs: Record<string, string> = {};
const handbooks: Record<string, string> = {}; // each agent's compiled AGENTS.md (the fast lane's prompt)
async function ensureAgents(companyId: string, fleetIssues: string) {
  const { json: agents } = await api("GET", `/api/companies/${companyId}/agents`);
  const plans = Object.entries<Obj>(cfg.agents ?? {}).map(([key, a]) => {
    let instructions: string, lane: string;
    try {
      instructions = handbookParts(cfg, key, a, { repo, instanceDir, fleetIssues }).map(([, t]) => t).join("");
      lane = laneHandbook(cfg, a, { repo, instanceDir, fleetIssues });
    } catch (e) { fail((e as Error).message); }
    const agent = agents.find((x: Obj) => x.metadata?.setupKey === `aidenhq:${key}` && x.status !== "terminated") ?? (a.member_of ? undefined : agents.find((x: Obj) => x.name === a.name && x.status !== "terminated"));
    const body = agentBody(key, a);
    revInputs[key] = instructions; // the rev's text (revOf)
    // The lane gets the agent's own handbook, the untrusted-text rule and the prompts marked for it (memory), not the shared
    // run sections (task flow, notify replies).
    handbooks[key] = lane;
    return { key, a, agent, body, instructions };
  });
  // Only the agents whose record or handbook differ from Paperclip's are written (scripts/paperclip-diff.ts).
  const live = await syncAgents({ api, companyId, rows: agents, plans: plans.map((p) => ({ key: p.key, name: p.a.name, agent: p.agent, body: p.body, instructions: p.instructions })), step });
  // The kernel's copy: a kernel job's engine home gets it as its instructions file (kernel/src/boxes.ts).
  mkdirSync(join(configDir, "handbooks"), { recursive: true });
  for (const p of plans) {
    const file = join(configDir, "handbooks", `${live[p.key]!.id}.md`);
    if (!existsSync(file) || readFileSync(file, "utf8") !== p.instructions) writeFileSync(file, p.instructions);
  }
  return live;
}

/** reports_to: <agent key> sets Paperclip's reportsTo once every agent exists. */
async function ensureReportingLines(agents: Record<string, Obj>) {
  for (const [key, a] of Object.entries<Obj>(cfg.agents ?? {})) {
    if (!a.reports_to) continue;
    const manager = agents[a.reports_to];
    if (!manager || a.reports_to === key) fail(`agent ${key}: reports_to must be another agent in this config (got ${a.reports_to})`);
    if (agents[key]!.reportsTo === manager.id) continue;
    await api("PATCH", `/api/agents/${agents[key]!.id}`, { reportsTo: manager.id });
    step(`${cfg.agents[key].name} now reports to ${cfg.agents[a.reports_to].name}`);
  }
}

async function ensureOpsKey(agent: Obj) {
  // ops-mcp creates tasks as the agent holding the ops-key role (agent key, standard trust); a key of another agent (the role
  // moved) is replaced.
  const existing = readSecret(`paperclip_ops_key${companySuffix}`);
  if (existing) {
    const res = await fetch(new URL("/api/agents/me", baseUrl), { headers: { authorization: `Bearer ${existing}` } });
    if (res.ok && (await res.json()).id === agent.id) {
      step("ops-mcp agent key is valid");
      return false;
    }
  }
  const { json } = await api("POST", `/api/agents/${agent.id}/keys`, { name: "ops-mcp" });
  writeSecret(`paperclip_ops_key${companySuffix}`, json.token);
  step("Created ops-mcp agent key (saved to secrets dir)");
  return true;
}

/**
 * The fast chat lane's config (secret `lane_config`, read by the chat-lane module): per agent with a `chat:` block, its id, name,
 * its chat task, its own agent key (`paperclip_lane_key_<agent>`, kept while it still names that agent), its chat settings, handbook,
 * lane tools (connection and tool: called through the kernel's proxy with its own key), and its own Telegram bot token (`chat_<agent>_telegram_bot_token`)
 * when chat.telegram is on. Rewritten in place only when it changes (the lane re-reads it; no restart).
 */
async function ensureLaneConfig(agents: Record<string, Obj>, chatTasks: Record<string, string>) {
  const out: Obj = {};
  for (const [key, a] of Object.entries<Obj>(cfg.agents ?? {})) {
    if (!a.chat || !agents[key]) continue;
    const name = `paperclip_lane_key_${key}`;
    let token = readSecret(name);
    const res = token ? await fetch(new URL("/api/agents/me", baseUrl), { headers: { authorization: `Bearer ${token}` } }) : undefined;
    if (!res?.ok || (await res.json()).id !== agents[key].id) {
      token = (await api("POST", `/api/agents/${agents[key].id}/keys`, { name: "fast-lane" })).json.token;
      writeSecret(name, token);
      step(`Created ${a.name}'s fast lane key`);
    }
    const tools = (a.chat.tools ?? []).map((t: string) => {
      const [connection, tool] = t.split(".");
      return { connection, name: tool }; // through the kernel's proxy, with the lane agent's own key
    });
    const telegram = a.chat.telegram ? readSecret(`chat_${key}_telegram_bot_token`) : "";
    if (a.chat.telegram && !telegram) console.warn(`warning: ${a.name} has chat.telegram on but no chat_${key}_telegram_bot_token in the vault; board chat only`);
    out[key] = { id: agents[key].id, name: a.name, chat_task: chatTasks[key], api_key: token, model: a.chat.model, reasoning: a.chat.reasoning, deadline_s: a.chat.deadline_s, prompt: handbooks[key] ?? "", tools, ...(telegram ? { telegram_token: telegram } : {}) };
  }
  const text = Object.keys(out).length ? JSON.stringify({ agents: out }) : "";
  if (readSecret("lane_config") === text) return;
  writeSecret("lane_config", text);
  step(`Wrote the fast lane config (${Object.keys(out).join(", ") || "no lane agents"})`);
}

function updateSystemYaml(companyId: string) {
  const path = join(configDir, "system.yaml");
  if (!existsSync(path)) fail("config/system.yaml missing (run scripts/bootstrap.sh)");
  const text = readFileSync(path, "utf8");
  const doc = YAML.parseDocument(text);
  if (doc.getIn(["paperclip", "company_id"]) === companyId) return false;
  doc.setIn(["paperclip", "company_id"], companyId);
  writeFileSync(path, doc.toString());
  step("Wrote company_id to config/system.yaml");
  return true;
}

/**
 * Each configured routine (matched by title), its schedules and its webhook, written only where Paperclip's differs: one list
 * call (it carries the triggers) is the whole read. A routine that differs gets today's full write: schedules first, then
 * its own fields (re-saving a schedule moves its next run to the next tick from now, so a routine resumed after a long pause
 * starts there instead of Paperclip catching up every tick it missed, up to 25 runs).
 */
async function ensureRoutines(companyId: string, agents: Record<string, Obj>) {
  const { json: routines } = await api("GET", `/api/companies/${companyId}/routines`);
  const work: { key: string; r: Obj; body: Obj; routine?: Obj; webhook?: { prefix: string; label: string; existing?: Obj } }[] = [];
  for (const [key, r] of Object.entries<Obj>(cfg.routines ?? {})) {
    const agent = agents[r.agent];
    if (!agent) fail(`routine ${key}: unknown agent ${r.agent}`);
    const routine = routines.find((x: Obj) => x.title === r.title);
    const body = {
      title: r.title,
      description: r.description,
      assigneeAgentId: agent.id,
      priority: "medium",
      // A paused routine stays paused across applies (the detector's auto-pause, the owner's pause) unless the config sets a status; an archived one that returns comes back active.
      status: r.status ?? (routine?.status === "paused" ? "paused" : "active"),
      concurrencyPolicy: r.concurrency ?? "coalesce_if_active",
      // Placeholders like {{tasks}} are filled by whoever starts the run (API); give them a default.
      variables: [...new Set([...(r.description ?? "").matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))]
        .filter((v) => !["date", "timestamp"].includes(v))
        .map((name) => ({ name, type: "text", required: false, defaultValue: "" })),
      // A lost scheduler tick still fires on the next one (Paperclip enqueues one run per missed tick, at most one for sub-hourly crons); always_enqueue routines already queue every event, so they skip.
      catchUpPolicy: (r.concurrency ?? "coalesce_if_active") === "always_enqueue" ? "skip_missed" : "enqueue_missed_with_cap",
      // A routine's model and reasoning_effort are the kernel's (grants.json `routines`); nothing rides in the routine's env.
      env: null,
    };
    const drift = routine ? routineDrift(body, routine, r.schedules ?? []) : ["new"];
    let webhook;
    if (r.webhook) {
      // Webhooks come from modules only: an instance agent (writable through apply) could otherwise take another routine's secret.
      if (cfg.agents?.[r.agent]?.module === "instance") fail(`routine ${key}: an instance agent's routine can't have a webhook`);
      if (r.secrets_prefix != null && !/^[a-z0-9_]+$/.test(r.secrets_prefix)) fail(`routine ${key}: secrets_prefix must be lowercase letters, digits and _`);
      // Secret files: <secrets_prefix>_url / _secret (default meeting_webhook, the transcript watcher).
      const prefix = r.secrets_prefix ?? "meeting_webhook";
      const label = r.secrets_prefix ? `${key} webhook` : "transcript watcher";
      webhook = { prefix, label, existing: routine?.triggers?.find((t: Obj) => t.kind === "webhook" && t.label === label) };
      if (routine && (!webhook.existing || !readSecret(`${prefix}_secret${companySuffix}`))) drift.push("webhook");
    }
    if (routine) routineKeys[routine.id] = key;
    if (drift.length) { work.push({ key, r, body, routine, webhook }); step(`Routine ${r.title}: ${drift.join(", ")}${routine ? " changed" : ""}`); }
  }
  step(`setup: ${work.length} routines changed, ${Object.keys(cfg.routines ?? {}).length - work.length} unchanged`);
  // A routine's key is the kernel's alone (never Paperclip's), so it lands here even when the routine itself is unchanged.
  writeGrants(agents, memoryInboxes, reviewLogs, chatTasks);
  // One routine's calls are independent of the next one's: a few side by side.
  await mapLimit(work, 4, async ({ key, r, body, routine, webhook }: (typeof work)[number]) => {
    const existed = Boolean(routine);
    if (!routine) {
      routine = (await api("POST", `/api/companies/${companyId}/routines`, body)).json as Obj;
      step(`Created routine ${r.title}`);
      routineKeys[routine.id] = key;
      writeGrants(agents, memoryInboxes, reviewLogs, chatTasks);
    }
    const triggers: Obj[] = routine.triggers ?? [];
    for (const s of r.schedules ?? []) {
      const existing = triggers.find((t: Obj) => t.kind === "schedule" && t.label === s.label);
      if (existing) {
        await api("PATCH", `/api/routine-triggers/${existing.id}`, { cronExpression: s.cron, timezone: s.timezone, enabled: true });
      } else {
        await api("POST", `/api/routines/${routine.id}/triggers`, { kind: "schedule", label: s.label, cronExpression: s.cron, timezone: s.timezone });
        step(`Added schedule "${s.label}" (${s.cron} ${s.timezone}) to ${r.title}`);
      }
    }
    // Schedules are matched by label, so a renamed or removed one would keep firing next to its replacement: it stops.
    for (const t of triggers.filter((t: Obj) => t.kind === "schedule" && t.enabled && !(r.schedules ?? []).some((s: Obj) => s.label === t.label))) await api("PATCH", `/api/routine-triggers/${t.id}`, { enabled: false }).then(() => step(`Disabled schedule "${t.label}" on ${r.title}: its config no longer names it`));
    // An existing routine's own fields last (see above).
    if (existed) await api("PATCH", `/api/routines/${routine.id}`, body);

    if (webhook) {
      const { prefix, label, existing } = webhook;
      let material: Obj | undefined;
      if (!existing) {
        material = (await api("POST", `/api/routines/${routine.id}/triggers`, { kind: "webhook", label, signingMode: "hmac_sha256", replayWindowSec: 300 })).json.secretMaterial;
        step(`Added signed webhook trigger to ${r.title}`);
      } else if (!readSecret(`${prefix}_secret${companySuffix}`)) {
        material = (await api("POST", `/api/routine-triggers/${existing.id}/rotate-secret`, {})).json.secretMaterial;
        step("Rotated webhook secret (local copy was missing)");
      }
      if (material) {
        // webhook_base: for callers inside the compose network (the public URL does not resolve there).
        writeSecret(`${prefix}_url${companySuffix}`, r.webhook_base ? r.webhook_base + new URL(material.webhookUrl).pathname : material.webhookUrl);
        writeSecret(`${prefix}_secret${companySuffix}`, material.webhookSecret);
      }
    }
  });
}

/**
 * The static half of fleet_catalog (read by paperclip-tasks-mcp from /paperclip): every agent with its routing text, reporting line,
 * roles, tools and routines, and which agents use each MCP server. Live apps are merged in by the tool.
 */
function writeCatalog() {
  if (!isWork) return;
  const agentsOut = Object.entries<Obj>(cfg.agents ?? {}).map(([key, a]) => ({
    key,
    name: a.name,
    title: a.title ?? "",
    description: a.description,
    reports_to: a.reports_to ?? null,
    roles: a.member_of ? [] : a.roles ?? [],
    mcp_servers: a.mcp_servers ?? [],
    tools: a.enabled_tools ?? {},
    routines: Object.values<Obj>(cfg.routines ?? {}).filter((r) => r.agent === key).map((r) => r.title),
    ...(a.team ? { team: a.team.members } : {}), ...(a.member_of ? { member_of: a.member_of } : {}),
  }));
  const mcp = Object.fromEntries(Object.keys(cfg.mcp_servers ?? {}).map((n) => [n, agentsOut.filter((a) => a.mcp_servers.includes(n)).map((a) => a.key)]));
  // The tasks module's fleet_catalog reads it (its data dir's catalog folder, mounted read-only).
  const path = join(resolve(repo, env("AIDENHQ_DATA_DIR", "./data")), "modules", "tasks", "catalog", "catalog.static.json");
  mkdirSync(dirname(path), { recursive: true });
  // Every module found, enabled or not (scripts/compile.ts): what can be installed, and what each one brings.
  const modulesFile = join(repo, "config/modules.json");
  // Without the board's setting docs and setup steps (Settings page only): agents' fleet_catalog stays small.
  const modules = existsSync(modulesFile) ? JSON.parse(readFileSync(modulesFile, "utf8")).map(({ settings, setup, ...m }: Obj) => m) : [];
  writeFileSync(path, JSON.stringify({ agents: agentsOut, mcp_servers: mcp, modules }, null, 1));
  step("Wrote the capabilities catalog");
}

/**
 * An agent's rev: the first 12 hex of sha256(its final handbook + adapter config + its grants entry, models
 * included). A run is stamped with it (the model gateway stamps usage rows from the grants table; the run page falls back
 * to revs.jsonl), so a behaviour change can be tied to the apply that caused it.
 */
function revOf(key: string) {
  const a = cfg.agents[key];
  const entry = { roles: a.roles ?? [], tools: a.enabled_tools ?? {}, ...grantEntry(key, a, cfg.routines), model: a.model ?? null, effort: a.reasoning_effort ?? null };
  return createHash("sha256").update(revInputs[key] ?? "").update(JSON.stringify(entry)).digest("hex").slice(0, 12);
}

/** Appends {at, agent, agentId, rev, product_sha, instance_sha} to config/grants/revs.jsonl (the board's mount) when an agent's rev or either sha changed. */
function appendRevs(table: Obj) {
  const gitSha = (dir: string) => { try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  const product_sha = gitSha(repo);
  const instance_sha = env("AIDENHQ_INSTANCE_DIR") ? gitSha(env("AIDENHQ_INSTANCE_DIR")) : null;
  const file = join(configDir, "grants", "revs.jsonl");
  const last = new Map();
  if (existsSync(file)) for (const l of readFileSync(file, "utf8").split("\n")) { try { const r = JSON.parse(l); last.set(r.agentId, r); } catch {} }
  const at = new Date().toISOString();
  const lines = Object.entries<Obj>(table.agents).filter(([id, g]) => { const p = last.get(id); return !p || p.rev !== g.rev || p.product_sha !== product_sha || p.instance_sha !== instance_sha; }).map(([agentId, g]) => JSON.stringify({ at, agent: g.key, agentId, rev: g.rev, product_sha, instance_sha }) + "\n");
  if (lines.length) appendFileSync(file, lines.join(""));
}

/**
 * The grants table the kernel's tool proxy checks every caller against (kernel/src/identity.ts): Paperclip agent id →
 * {key, roles, tools, models, graded} (the last two: grantEntry in scripts/modules.ts). Keyed by id because
 * Paperclip lets agents edit their own metadata (setupKey, roles). Written in place, never renamed: the board bind-mounts
 * its directory read-only.
 */
/** The last grants table: the first write of an apply keeps its routine keys until ensureRoutines adds each routine's. */
const lastGrants = (() => {
  try {
    return JSON.parse(readFileSync(join(configDir, "grants", "grants.json"), "utf8"));
  } catch {
    return {};
  }
})();
/** Each routine's compiled key by Paperclip routine id: a routine run's wake names it (`routine:<key>`), so its own model applies. */
const routineKeys = { ...lastGrants.routine_keys };

function writeGrants(agents: Record<string, Obj>, memoryInboxes: Record<string, string> = {}, reviewLogs: Record<string, string> = {}, chatTasks: Record<string, string> = {}) {
  if (!isWork) return;
  // autonomy: the board and the runner read the tiered-approvals switch here, fresh on every use.
  // A member's roles are its team record's, given at admission: the record alone holds them, so role lookups find the team.
  const table: Obj = { autonomy: cfg.autonomy ?? "off", agents: Object.fromEntries(Object.entries(agents).map(([key, a]) => [a.id, { key, roles: cfg.agents[key].member_of ? [] : cfg.agents[key].roles ?? [], tools: cfg.agents[key].enabled_tools ?? {}, ...grantEntry(key, cfg.agents[key], cfg.routines), rev: revOf(key), description: cfg.agents[key].description, ...(cfg.agents[key].trial ? { trial: true } : {}), ...(cfg.agents[key].delegate_to ? { delegate_to: cfg.agents[key].delegate_to } : {}), ...(cfg.agents[key].image ? { image: cfg.agents[key].image } : {}) }])) };
  // The shared "Fleet issues" log task (ensureFleetIssues, its identifier): any agent may comment there (kernel cp.ts).
  if (fleetIssues) table.fleet_issues = fleetIssues;
  table.routine_keys = { ...routineKeys };
  // Each agent's memory inbox issue id (ensureMemoryInboxes): memory_note posts there, the tasks bridge guards it.
  for (const [key, a] of Object.entries(agents)) if (memoryInboxes[key]) table.agents[a.id].memory_inbox = memoryInboxes[key];
  // Each fleet-audit agent's review log issue id (ensureReviewLogs): the tasks bridge's coach_record writes there, coach_due reads it.
  for (const [key, a] of Object.entries(agents)) if (reviewLogs[key]) table.agents[a.id].review_log = reviewLogs[key];
  // Each lane agent's chat task (ensureChatTasks): the kernel writes the fast lane's turns there, and only there.
  for (const [key, a] of Object.entries(agents)) if (chatTasks[key]) table.agents[a.id].chat_task = chatTasks[key];
  // Each agent's skills (compile resolved them): the runner copies exactly these into its jobs' engine home.
  for (const [key, a] of Object.entries(agents)) if (agentSkills(cfg, key).length) table.agents[a.id].skills = agentSkills(cfg, key);
  const file = join(configDir, "grants", "grants.json");
  mkdirSync(dirname(file), { recursive: true });
  appendRevs(table);
  const next = JSON.stringify(table, null, 1) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === next) return;
  writeFileSync(file, next, { mode: 0o644 });
  step(`Wrote the grants table (${Object.keys(table.agents).length} agents)`);
}

function restartOpsMcp() {
  if (env("AIDENHQ_SKIP_RESTART") === "1") return;
  try {
    execFileSync("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", "meetings-ops-mcp"], { cwd: repo, stdio: "ignore", env: { ...process.env, ...dotenv } });
    step("Restarted ops-mcp to pick up the new key/config");
  } catch {
    console.warn("  warning: could not restart ops-mcp; run `docker compose up -d --force-recreate ops-mcp`");
  }
}


// ------------------------------------------------------------------ main

// Wall time per section, printed as one line at the end so a slow apply shows where setup spent it.
const laps: string[] = [];
let lapAt = Date.now();
const lap = (name: string) => { const now = Date.now(); laps.push(`${name} ${((now - lapAt) / 1000).toFixed(1)}s`); lapAt = now; };
const health = await waitForHealth();
await ensureBoardKey(health);
// The instance's general settings row is the only place the dump scheduler reads this from (7-day default on a fresh host).
await ensureBackupRetention({ api, dailyDays: 3, step });
const company = await ensureCompany();
await ensureLabels(company.id);
// A team member removed from instance.yaml while it still has open tasks: nothing is changed until they are drained or handed off.
const busy = await busyRemovedMembers({ api, companyId: company.id, cfg });
if (busy.length) fail(`team members removed while they still have open tasks: ${busy.map((m) => `${m.name} (${m.tasks.join(", ")})`).join("; ")}. Finish or hand off their tasks first, or keep them in teams: until then.`);
lap("login");
// Heartbeat runs note missed wake-ups on one "Fleet issues" task; its identifier goes into their handbook section.
const fleetIssues = Object.values<Obj>(cfg.agents ?? {}).some((a: Obj) => a.heartbeat != null && a.heartbeat !== false) ? await ensureFleetIssues({ api, companyId: company.id, step }) : "";
const agents = await ensureAgents(company.id, fleetIssues);
lap("agents");
// Setup's log tasks are held by their agents (every open task has a holder); Fleet issues by the fleet-audit agent.
const holders = Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, a.id]));
const auditor = Object.keys(cfg.agents ?? {}).find((k) => !cfg.agents[k].member_of && cfg.agents[k].roles?.includes("fleet-audit") && agents[k]);
await holdFleetIssues({ api, identifier: fleetIssues, holder: auditor ? agents[auditor]!.id : "", step });
const memoryInboxes = await ensureMemoryInboxes({ api, companyId: company.id, step, holders, keys: Object.entries<Obj>(cfg.agents ?? {}).filter(([k, x]) => x.enabled_tools?.paperclip_tasks?.includes("memory_note") && agents[k]).map(([k]) => k) });
await dropOldSecrets(company.id);
await ensureReportingLines(agents);
// The Agent Coach's review log (one task per fleet-audit agent), found again by its setup marker, never by search at run time.
const reviewLogs = await ensureReviewLogs({ api, companyId: company.id, step, holders, keys: Object.entries<Obj>(cfg.agents ?? {}).filter(([k, x]) => !x.member_of && x.roles?.includes("fleet-audit") && agents[k]).map(([k]) => k) });
// The fast chat lane's conversation: one chat task per agent with a `chat:` block (kernel/src/lane.ts writes each turn there).
const chatTasks = isWork ? await ensureChatTasks({ api, companyId: company.id, step, holders, ownerName: cfg.owner_name, agents: Object.fromEntries(Object.entries<Obj>(cfg.agents ?? {}).filter(([k, x]) => x.chat && agents[k]).map(([k, x]) => [k, x.name])) }) : {};
writeGrants(agents, memoryInboxes, reviewLogs, chatTasks);
lap("tasks");
await ensureEventsPlugin({ api, step, version: JSON.parse(readFileSync(join(repo, "services/paperclip-events/package.json"), "utf8")).version }).catch((e) => fail(e.message));
lap("plugins");
// ops-mcp acts in Paperclip as the agent with the ops-key role.
const opsAgents = Object.keys(cfg.agents ?? {}).filter((k) => !cfg.agents[k].member_of && cfg.agents[k].roles?.includes("ops-key"));
if (opsAgents.length > 1) fail(`only one agent may hold the ops-key role (${opsAgents.join(", ")})`);
const opsAgent = opsAgents.length ? agents[opsAgents[0]!] : undefined;
const keyChanged = opsAgent ? await ensureOpsKey(opsAgent) : false;
if (isWork) await ensureAgentKeys({ api, agents, secretsDir, baseUrl, step });
if (isWork) await ensureLaneConfig(agents, chatTasks); // the fast chat lane serves the work company only (phase 1)
const cfgChanged = isWork ? updateSystemYaml(company.id) : false;
if (opsAgent && (keyChanged || cfgChanged)) restartOpsMcp(); // ops-mcp exists only with the meetings module
writeCatalog();
lap("keys");
await ensureRoutines(company.id, agents); // writes each routine's key into the grants table before its triggers
await retireUnconfigured({ api, companyId: company.id, cfg, step });
lap("routines");

console.log("\nPaperclip is configured.");
console.log(`setup timing: ${laps.join(", ")}`);
if (readSecret("modules/google/google_oauth.json") === "{}" || !readSecret("modules/google/google_oauth.json")) {
  console.log("Google Calendar/Drive is not connected yet: see README.md › Google.");
}
