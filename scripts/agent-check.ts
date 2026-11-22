#!/usr/bin/env node
// The pre-launch agent check (wave 2, item 7): what can be known about each agent before it runs.
//
// At compile (scripts/compile.ts calls staticCheck on the compiled config; errors fail the build):
//   - every model id an agent or its routines name is an OpenRouter id (gateway grants are built from them: grantEntry).
// Advisory (warnings in the compile and apply output, never a failure): every tool the agent's handbook names in
// backticks (scripts/handbook-tools.ts) is granted to it, and every routine of the agent says when it is done (closes or
// finishes its task). Heuristics: handbooks legitimately name other agents' tools ("hand it to the DevOps Engineer, who
// files `app_run_request`"), and no instance commit is checked before it lands, so a hard failure here would land and then
// stop every later apply until reverted.
// At apply (ops/apply-config.sh runs `node scripts/agent-check.ts live --since <the previous config>` at the end):
//   - each connection an agent is granted answers its /healthz (which also reports sign-in: 503 until signed in), from the host.
//   A failing connection is an error (exit 1) where it is newly granted since --since (a new agent: all of its
//   connections); a warning where it was granted before, so one vendor being down doesn't fail every apply.
//   A connection nobody has set up yet is a note, never an error, even where newly granted (an upgrade adds the default
//   bundle's connections to an owner who connected none of them): its /healthz answers `state: "missing"`, or its service
//   isn't in the compiled compose at all (a `when:` setting not given yet: no container until it is).
//
//   node scripts/agent-check.ts [--config config/paperclip.yaml]              the compile checks on a compiled config
//   node scripts/agent-check.ts live [--config ...] [--since <old paperclip.yaml>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { knownTools, namedTools } from "./handbook-tools.ts";

/** An OpenRouter model id: vendor/model, optionally `~` (latest alias) and the `openrouter/` engine prefix. */
const MODEL_ID = /^(openrouter\/)?~?[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][\w.:-]*$/;
/** A routine description that says when it is done: it closes or finishes its task. */
const DONE = /\b(close|closes|finish|finishes|task_finish|done when|done once)\b/i;

/** The fields of a compiled config (config/paperclip.yaml) that these checks read. */
export interface AgentCfg { model?: unknown; models?: unknown[]; enabled_tools?: Record<string, string[]>; instructions?: string; instructions_extra?: string; mcp_servers?: string[] }
export interface Cfg { mcp_servers?: Record<string, any>; routines?: Record<string, { agent?: string; model?: unknown; description?: unknown }>; agents?: Record<string, AgentCfg> }
interface Health { ok: boolean; state?: string; detail?: string; idle?: boolean }

const readText = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");

/**
 * The compile checks on a compiled config (config/paperclip.yaml's shape). Pure but for reading handbooks through
 * `read` (path → text). Returns { errors, warnings }, each a list of one-line messages.
 */
export function staticCheck(cfg: Cfg, { read = readText }: { read?: (f?: string) => string } = {}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const servers = cfg.mcp_servers ?? {};
  const known = knownTools(servers);
  const routines = Object.entries(cfg.routines ?? {});
  for (const [key, a] of Object.entries(cfg.agents ?? {})) {
    const flag = (msg: string) => warnings.push(`${key}: ${msg}`);
    for (const m of [a.model, ...(a.models ?? []), ...routines.filter(([, r]) => r.agent === key).map(([, r]) => r.model)]) {
      if (m != null && !(typeof m === "string" && MODEL_ID.test(m))) errors.push(`${key}: model ${JSON.stringify(m)} isn't an OpenRouter model id (vendor/model)`);
    }
    const granted = new Set(Object.values(a.enabled_tools ?? {}).flat());
    const text = [a.instructions, a.instructions_extra].map(read).join("\n");
    const missing = (namedTools(text, known) as string[]).filter((t) => !granted.has(t));
    if (missing.length) flag(`its handbook names ${missing.map((t) => `\`${t}\``).join(", ")}, not granted to it (grant it, or don't name it)`);
    for (const [rk, r] of routines) if (r.agent === key && !DONE.test(String(r.description ?? ""))) flag(`routine ${rk} doesn't say when it is done (e.g. "then close this task with one line")`);
  }
  return { errors, warnings };
}

/**
 * Each agent's connections granted since `prev` (a compiled config): agent key → Set. Without one (a first install, where
 * nothing is signed in yet) nothing counts as new: every finding is a warning.
 */
export function newGrants(cfg: Cfg, prev?: Cfg) {
  if (!prev) return new Map();
  return new Map(Object.entries(cfg.agents ?? {}).map(([k, a]) => [k, new Set((a.mcp_servers ?? []).filter((c) => !(prev?.agents?.[k]?.mcp_servers ?? []).includes(c)))]));
}

/**
 * The live check's verdict, given each HTTP connection's health ({ name → { ok, state, detail, idle } }): errors for
 * connections that fail where they are newly granted (`fresh`, from newGrants), warnings for the rest, and notes for those
 * nobody has set up yet (`state: "missing"`, the connection's own answer, or `idle`: its service isn't compiled in), which
 * the owner connects on the board when they want them.
 */
export function liveVerdict(cfg: Cfg, health: Record<string, Health>, fresh: Map<string, Set<string>>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const [name, h] of Object.entries(health)) {
    if (h.ok) continue;
    const users = Object.entries(cfg.agents ?? {}).filter(([, a]) => (a.mcp_servers ?? []).includes(name)).map(([k]) => k);
    if (h.idle || h.state === "missing") {
      notes.push(`connection ${name} isn't set up yet (${h.detail}); granted to ${users.join(", ")}`);
      continue;
    }
    const hard = users.filter((k) => fresh.get(k)?.has(name));
    const msg = `connection ${name} isn't healthy or signed in (${h.detail}); granted to ${users.join(", ")}`;
    (hard.length ? errors : warnings).push(hard.length ? `${msg}: newly granted to ${hard.join(", ")}` : msg);
  }
  return { errors, warnings, notes };
}

/**
 * The service names the compiled compose files define (their keys and the names modules' services declare): a connection
 * whose host isn't one of them has no container by design. Undefined when there is no compiled compose to read.
 */
export function definedServices(repo: string) {
  const files = ["compose.yaml", "compose.modules.yaml"].map((f) => resolve(repo, f));
  if (!files.every(existsSync)) return undefined;
  const names = new Set<string>();
  for (const f of files) {
    for (const [k, s] of (Object.entries(YAML.parse(readFileSync(f, "utf8"), { logLevel: "error" })?.services ?? {}) as [string, any][])) {
      names.add(k);
      if (s?.labels?.["aidenhq.service"]) names.add(s.labels["aidenhq.service"]);
    }
  }
  return names;
}

/**
 * Each granted HTTP connection's /healthz, asked from the host at the service's container address, as the kernel reaches it
 * (kernel/src/net.ts): module services share no network with Paperclip any more.
 */
export function connectionHealth(cfg: Cfg, repo: string, defined = definedServices(repo)): Record<string, Health> {
  const used = new Set(Object.values(cfg.agents ?? {}).flatMap((a) => a.mcp_servers ?? []));
  const all = Object.entries(cfg.mcp_servers ?? {}).filter(([n, c]) => used.has(n) && c.url);
  const idle = defined ? all.filter(([, c]) => !defined.has(new URL(c.url!).hostname)) : [];
  const out = Object.fromEntries(idle.map(([n, c]) => [n, { ok: false, idle: true, detail: `no ${new URL(c.url!).hostname} container until it is set up` }]));
  const targets = Object.fromEntries(all.filter(([n]) => !(n in out)).map(([n, c]) => [n, new URL("/healthz", c.url!).href]));
  if (!Object.keys(targets).length) return out;
  const probe = `import { createResolver } from "./kernel/src/net.ts";const s=createResolver({project:process.env.COMPOSE_PROJECT_NAME||"aidenhq"});const t=JSON.parse(process.argv[1]);Promise.all(Object.entries(t).map(([n,u])=>s.resolve(u).then((a)=>fetch("http://"+a.host+":"+a.port+a.path,{signal:AbortSignal.timeout(8000)})).then(async r=>{const b=await r.text();let j={};try{j=JSON.parse(b)}catch{}return [n,{ok:r.ok&&j.ok!==false,state:j.state,detail:r.ok&&j.ok!==false?"ok":String(j.detail??j.state??r.status).slice(0,160)}]}).catch(e=>[n,{ok:false,detail:"unreachable: "+e.message}]))).then(x=>console.log(JSON.stringify(Object.fromEntries(x))))`;
  const probed = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", probe, JSON.stringify(targets)], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  return { ...out, ...JSON.parse(probed.trim().split("\n").at(-1)!) };
}

/** Prints the result; returns the exit code. */
export function report(label: string, { errors, warnings, notes = [] }: { errors: string[]; warnings: string[]; notes?: string[] }) {
  for (const n of notes) console.log(`  ${label} note: ${n}`);
  for (const w of warnings) console.log(`  ${label} warning: ${w}`);
  for (const e of errors) console.error(`  ${label} ERROR: ${e}`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const live = args[0] === "live";
  const cfg = YAML.parse(readFileSync(resolve(repo, opt("--config") ?? "config/paperclip.yaml"), "utf8"));
  if (!live) process.exit(report("agent-check", staticCheck(cfg)));
  const since = opt("--since");
  const prev = since && existsSync(since) && readFileSync(since, "utf8").trim() ? YAML.parse(readFileSync(since, "utf8")) : undefined;
  const fresh = newGrants(cfg, prev);
  let health: Record<string, Health>;
  try {
    health = connectionHealth(cfg, repo);
  } catch (e) {
    // Couldn't ask at all (Paperclip's container down?): a failure only if something was newly granted.
    const added = [...fresh].filter(([, s]) => s.size).map(([k, s]) => `${k}: ${[...s].join(", ")}`);
    process.exit(report("agent-check", { errors: added.length ? [`couldn't ask the connections (${String((e as Error).message ?? e).split("\n")[0]}), newly granted: ${added.join("; ")}`] : [], warnings: added.length ? [] : [`couldn't ask the connections (${String((e as Error).message ?? e).split("\n")[0]})`] }));
  }
  const verdict = liveVerdict(cfg, health, fresh);
  const code = report("agent-check", verdict);
  console.log(`agent-check live: ${Object.values(health).filter((h) => h.ok).length}/${Object.keys(health).length} connections healthy${verdict.notes.length ? `, ${verdict.notes.length} not set up yet` : ""}${code ? "; FAILED for newly granted connections (see above)" : ""}`);
  process.exit(code);
}
