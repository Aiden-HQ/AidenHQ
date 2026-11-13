#!/usr/bin/env node
// The pre-launch agent check (wave 2, item 7): what can be known about each agent before it runs.
//
// At compile (scripts/compile.mjs calls staticCheck on the compiled config; errors fail the build):
//   - every model id an agent or its routines name is an OpenRouter id (gateway grants are built from them: grantEntry);
//   - an agent in trial has no write tools beyond the trial ones (modules.mjs enforces it too; this is the second lock).
// Advisory (warnings in the compile and apply output, never a failure): every tool the agent's handbook names in
// backticks (scripts/handbook-tools.mjs) is granted to it, and every routine of the agent says when it is done (closes or
// finishes its task). Heuristics: handbooks legitimately name other agents' tools ("hand it to the DevOps Engineer, who
// files `app_run_request`"), and no instance commit is checked before it lands, so a hard failure here would land and then
// stop every later apply until reverted.
// At apply (ops/apply-config.sh runs `node scripts/agent-check.mjs live --since <the previous config>` at the end):
//   - each connection an agent is granted answers its /healthz (which also reports sign-in: 503 until signed in).
//   A failing connection is an error (exit 1) where it is newly granted since --since (a new agent: all of its
//   connections); a warning where it was granted before, so one vendor being down doesn't fail every apply.
// Kill switch: instance setting `agent_check: off` (both steps print that they're off and pass).
//
//   node scripts/agent-check.mjs [--config config/paperclip.yaml]              the compile checks on a compiled config
//   node scripts/agent-check.mjs live [--config ...] [--since <old paperclip.yaml>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { knownTools, namedTools } from "./handbook-tools.mjs";
import { TRIAL_WRITES } from "./modules.mjs";

/** An OpenRouter model id: vendor/model, optionally `~` (latest alias) and the `openrouter/` engine prefix. */
const MODEL_ID = /^(openrouter\/)?~?[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][\w.:-]*$/;
/** A routine description that says when it is done: it closes or finishes its task. */
const DONE = /\b(close|closes|finish|finishes|task_finish|done when|done once)\b/i;

const readText = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");

/**
 * The compile checks on a compiled config (config/paperclip.yaml's shape). Pure but for reading handbooks through
 * `read` (path → text). Returns { errors, warnings }, each a list of one-line messages.
 */
export function staticCheck(cfg, { read = readText } = {}) {
  const errors = [];
  const warnings = [];
  const servers = cfg.mcp_servers ?? {};
  const known = knownTools(servers);
  const routines = Object.entries(cfg.routines ?? {});
  for (const [key, a] of Object.entries(cfg.agents ?? {})) {
    const flag = (msg) => warnings.push(`${key}${a.trial === true ? " (in trial)" : ""}: ${msg}`);
    for (const m of [a.model, ...(a.models ?? []), ...routines.filter(([, r]) => r.agent === key).map(([, r]) => r.model)]) {
      if (m != null && !(typeof m === "string" && MODEL_ID.test(m))) errors.push(`${key}: model ${JSON.stringify(m)} isn't an OpenRouter model id (vendor/model)`);
    }
    const granted = new Set(Object.values(a.enabled_tools ?? {}).flat());
    if (a.trial === true) {
      for (const [name, list] of Object.entries(a.enabled_tools ?? {})) {
        const writes = list.filter((t) => (servers[name]?.tools?.write ?? []).includes(t) && !(TRIAL_WRITES[name] ?? []).includes(t));
        if (writes.length) errors.push(`${key} (in trial): has ${name} write tools (${writes.join(", ")}); an agent in trial is read-only`);
      }
    }
    const text = [a.instructions, a.instructions_extra].map(read).join("\n");
    const missing = namedTools(text, known).filter((t) => !granted.has(t));
    if (missing.length) flag(`its handbook names ${missing.map((t) => `\`${t}\``).join(", ")}, not granted to it (grant it, or don't name it)`);
    for (const [rk, r] of routines) if (r.agent === key && !DONE.test(String(r.description ?? ""))) flag(`routine ${rk} doesn't say when it is done (e.g. "then close this task with one line")`);
  }
  return { errors, warnings };
}

/**
 * Each agent's connections granted since `prev` (a compiled config): agent key → Set. Without one (a first install, where
 * nothing is signed in yet) nothing counts as new: every finding is a warning.
 */
export function newGrants(cfg, prev) {
  if (!prev) return new Map();
  return new Map(Object.entries(cfg.agents ?? {}).map(([k, a]) => [k, new Set((a.mcp_servers ?? []).filter((c) => !(prev?.agents?.[k]?.mcp_servers ?? []).includes(c)))]));
}

/**
 * The live check's verdict, given each HTTP connection's health ({ name → { ok, detail } }): errors for connections that
 * fail where they are newly granted (`fresh`, from newGrants), warnings for the rest.
 */
export function liveVerdict(cfg, health, fresh) {
  const errors = [];
  const warnings = [];
  for (const [name, h] of Object.entries(health)) {
    if (h.ok) continue;
    const users = Object.entries(cfg.agents ?? {}).filter(([, a]) => (a.mcp_servers ?? []).includes(name)).map(([k]) => k);
    const hard = users.filter((k) => fresh.get(k)?.has(name));
    const msg = `connection ${name} isn't healthy or signed in (${h.detail}); granted to ${users.join(", ")}`;
    (hard.length ? errors : warnings).push(hard.length ? `${msg}: newly granted to ${hard.join(", ")}` : msg);
  }
  return { errors, warnings };
}

/** Each granted HTTP connection's /healthz, asked from inside the Paperclip container (where agents reach them). */
export function connectionHealth(cfg, repo) {
  const used = new Set(Object.values(cfg.agents ?? {}).flatMap((a) => a.mcp_servers ?? []));
  const targets = Object.fromEntries(Object.entries(cfg.mcp_servers ?? {}).filter(([n, c]) => used.has(n) && c.url).map(([n, c]) => [n, new URL("/healthz", c.url).href]));
  if (!Object.keys(targets).length) return {};
  const probe = `const t=JSON.parse(process.argv[1]);Promise.all(Object.entries(t).map(([n,u])=>fetch(u,{signal:AbortSignal.timeout(8000)}).then(async r=>{const b=await r.text();let j={};try{j=JSON.parse(b)}catch{}return [n,{ok:r.ok&&j.ok!==false,detail:r.ok&&j.ok!==false?"ok":String(j.detail??j.state??r.status).slice(0,160)}]}).catch(e=>[n,{ok:false,detail:"unreachable: "+e.message}]))).then(x=>console.log(JSON.stringify(Object.fromEntries(x))))`;
  const out = execFileSync("docker", ["compose", "exec", "-T", "paperclip", "node", "-e", probe, JSON.stringify(targets)], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  return JSON.parse(out.trim().split("\n").at(-1));
}

/** Whether the check is on: the instance's `agent_check` setting (off = the kill switch). */
export function checkOn(instanceDir) {
  try {
    return String(YAML.parse(readFileSync(join(instanceDir, "instance.yaml"), "utf8"))?.settings?.agent_check ?? "on") !== "off";
  } catch {
    return true;
  }
}

/** Prints the result; returns the exit code. */
export function report(label, { errors, warnings }) {
  for (const w of warnings) console.log(`  ${label} warning: ${w}`);
  for (const e of errors) console.error(`  ${label} ERROR: ${e}`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const live = args[0] === "live";
  const instanceDir = process.env.AIDENHQ_INSTANCE_DIR;
  if (instanceDir && !checkOn(instanceDir)) {
    console.log("agent-check: off (settings.agent_check)");
    process.exit(0);
  }
  const cfg = YAML.parse(readFileSync(resolve(repo, opt("--config") ?? "config/paperclip.yaml"), "utf8"));
  if (!live) process.exit(report("agent-check", staticCheck(cfg)));
  const since = opt("--since");
  const prev = since && existsSync(since) && readFileSync(since, "utf8").trim() ? YAML.parse(readFileSync(since, "utf8")) : undefined;
  const fresh = newGrants(cfg, prev);
  let health;
  try {
    health = connectionHealth(cfg, repo);
  } catch (e) {
    // Couldn't ask at all (Paperclip's container down?): a failure only if something was newly granted.
    const added = [...fresh].filter(([, s]) => s.size).map(([k, s]) => `${k}: ${[...s].join(", ")}`);
    process.exit(report("agent-check", { errors: added.length ? [`couldn't ask the connections (${String(e.message ?? e).split("\n")[0]}), newly granted: ${added.join("; ")}`] : [], warnings: added.length ? [] : [`couldn't ask the connections (${String(e.message ?? e).split("\n")[0]})`] }));
  }
  const code = report("agent-check", liveVerdict(cfg, health, fresh));
  console.log(`agent-check live: ${Object.values(health).filter((h) => h.ok).length}/${Object.keys(health).length} connections healthy${code ? "; FAILED for newly granted connections (see above)" : ""}`);
  process.exit(code);
}
