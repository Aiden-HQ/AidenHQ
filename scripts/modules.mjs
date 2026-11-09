// Compiles modules + an instance into what the stack consumes: the Paperclip config (scripts/paperclip-setup.mjs),
// module apps (apps-mcp), compose services (compose.modules.yaml) and the module catalog. Pure: reads files, writes
// nothing (scripts/compile.mjs writes). See docs/configuration.md.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { validateImages } from "./computers.mjs";
import { AUTH_PORT, checkPorts, edgeConfig, GATE_PORT } from "./edge.mjs";

const PROFILES = ["trusted", "untrusted", "code-exec"];
// image: the agent's computer (scripts/computers.mjs); the instance turns it on or off per agent.
const OVERRIDABLE = { agents: ["model", "reasoning_effort", "timeout_sec", "image"], routines: ["schedules", "status", "model"] };
// The Codex launcher (services/paperclip-tasks-mcp/codex-model, mounted at /opt/aidenhq) for agents with a per-routine model.
const CODEX_MODEL_COMMAND = "/opt/aidenhq/codex-model";
const SETTING = /\$\{settings\.([A-Za-z0-9_]+)\}/g;
// Roles (checked by the services: board fleet tools, tasks bridge, apps-mcp, setup) and the modules allowed to grant each.
const ROLES = {
  "fleet-admin": ["core"], // the board's fleet tools and relaying the owner's words
  "board-writer": ["core"], // board moves and recurring tasks
  "engineer-dispatch": ["core"], // Engineer sub-tasks
  "app-incidents": ["core"], // change any app with an open incident
  "app-requests": ["core"], // in-app requests and people roles of every shared app (apps-mcp app_requests, app_role_set)
  "security-verdict": ["security"], // finding_verdict: apps-mcp records a verdict on a src_security finding
  "ops-key": ["meetings"], // the agent ops-mcp acts as in Paperclip
  architect: ["core"], // its Platform Engineer tasks may use the trial exception (the runner reads it from the grants table)
  librarian: ["librarian"], // read every handbook, decide proposed identity links, hand rule proposals to the Platform Engineer (tasks bridge, apps-mcp)
  "fleet-read": ["fleet-ops"], // the board's fleet status only (never fleet_control or relaying the owner's words)
  "repo-checkout": ["design"], // a commit of an agents-org repo placed in its computer (services/computer/launcher.mjs POST /repo)
  "design-review": ["design"], // the design-review commit status on agents-org PRs (github-mcp commit_status_set)
};
// Agents defined in the instance repo (agents/<key>/agent.yaml + AGENTS.md): their fields, and the
// write tools an agent in trial keeps (to report on its own tasks; everything else it may only read).
const INSTANCE_AGENT_FIELDS = ["name", "description", "reports_to", "model", "reasoning_effort", "timeout_sec", "connections", "routines", "budget", "max_parallel", "image", "trial", "catch_up", "web_search"];
const INSTANCE_ROUTINE_FIELDS = ["title", "description", "concurrency", "schedules", "status", "agent", "model"];
// paperclip-tasks-mcp limits these to the trial agent's own tasks (the grants table marks it in trial); source_ack moves only
// the caller's own source cursor.
const TRIAL_WRITES ={ paperclip_tasks: ["task_comment", "task_handoff", "task_finish", "task_set_status"], apps: ["source_ack"] };
// The grants table (scripts/paperclip-setup.mjs writes it into config/grants/), mounted read-only into every connection.
const GRANTS_FILE = "/grants/grants.json";
const GRANTS_MOUNT = "${AIDENHQ_CONFIG_DIR:-./config}/grants:/grants:ro";

const readYaml = (path) => YAML.parse(readFileSync(path, "utf8")) ?? {};
const fail = (msg) => { throw new Error(msg); };

/** `---\nkey: value\n---\nbody` → { meta, body }. */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? { meta: YAML.parse(m[1]) ?? {}, body: text.slice(m[0].length) } : { meta: {}, body: text };
}

/** Every module under <productDir>/modules, as { name, root, def }. */
function discover(productDir) {
  const dir = join(productDir, "modules");
  const out = new Map();
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "module.yaml");
    if (!existsSync(file)) continue;
    const def = readYaml(file);
    if (def.name !== name) fail(`modules/${name}/module.yaml: name is ${def.name}, expected ${name}`);
    out.set(name, { name, root: join(dir, name), def });
  }
  return out;
}

/** core + the instance's modules, closed over `requires`, in name order with core first. */
function resolveEnabled(all, wanted) {
  const enabled = new Set();
  const visit = (name, path) => {
    if (path.includes(name)) fail(`module cycle: ${[...path.slice(path.indexOf(name)), name].join(" → ")}`);
    if (!all.has(name)) fail(`unknown module: ${name}${path.length ? ` (required by ${path.at(-1)})` : ""}`);
    if (enabled.has(name)) return;
    for (const dep of all.get(name).def.requires ?? []) visit(dep, [...path, name]);
    enabled.add(name);
  };
  for (const name of ["core", ...wanted]) visit(name, []);
  return [...enabled].sort((a, b) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
}

/** The agents org: github_agents_org, else aidenhq-<instance_name> (services/runner/src/config.mjs agrees). */
const agentsOrg = (settings) => settings.github_agents_org || (settings.instance_name ? `aidenhq-${settings.instance_name}` : "");

/** Replaces ${settings.x} in every string. */
function substitute(value, settings) {
  const one = (s) => s.replace(SETTING, (_, k) => (k in settings ? String(settings[k]) : fail(`unknown setting: ${k}`)));
  if (typeof value === "string") return one(value);
  if (Array.isArray(value)) return value.map((v) => substitute(v, settings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, settings)]));
  return value;
}

/** A path in a module's compose fragment: ./x or ../x become absolute from the module root; everything else stays. */
const rootPath = (root, p) => (typeof p === "string" && /^\.\.?\//.test(p) ? resolve(root, p) : p);

function rewriteService(root, svc) {
  const s = { ...svc };
  if (typeof s.build === "string") s.build = rootPath(root, s.build);
  else if (s.build?.context) s.build = { ...s.build, context: rootPath(root, s.build.context) };
  if (s.extends?.file) s.extends = { ...s.extends, file: rootPath(root, s.extends.file) };
  if (s.env_file) s.env_file = [].concat(s.env_file).map((f) => rootPath(root, f));
  if (s.volumes) {
    s.volumes = s.volumes.map((v) => {
      if (typeof v === "string") { const [src, ...rest] = v.split(":"); return [rootPath(root, src), ...rest].join(":"); }
      return v.type === "bind" ? { ...v, source: rootPath(root, v.source) } : v;
    });
  }
  return s;
}

const isolationOf = (v, where, allowed = PROFILES) => {
  const p = v ?? "trusted";
  if (!allowed.includes(p)) fail(`${where}: isolation must be one of ${allowed.join(", ")} (got ${p})`);
  return p;
};

/**
 * A module's compose service; two modules (or a module and the edge) may both extend the same service (e.g. each adds a
 * secret, an env var or a mount to the board): their environment maps and secrets and volumes lists merge. Anything else
 * declared twice, or one env var set two ways, fails.
 */
function mergeService(services, key, svc) {
  const prev = services[key];
  if (!prev) return void (services[key] = svc);
  const extra = (x) => Object.keys(x).filter((f) => !["environment", "secrets", "volumes"].includes(f));
  if (extra(prev).length || extra(svc).length) fail(`duplicate compose service: ${key}`);
  const env = { ...(prev.environment ?? {}) };
  for (const [n, v] of Object.entries(svc.environment ?? {})) {
    if (n in env && env[n] !== v) fail(`compose service ${key}: ${n} set two ways`);
    env[n] = v;
  }
  const list = (f) => [...new Set([...(prev[f] ?? []), ...(svc[f] ?? [])])];
  services[key] = { ...(Object.keys(env).length ? { environment: env } : {}), secrets: list("secrets"), ...(list("volumes").length ? { volumes: list("volumes") } : {}) };
}

function put(target, key, value, kind) {
  if (key in target) fail(`duplicate ${kind}: ${key}`);
  target[key] = value;
}

/**
 * compile(productDir, instanceDir, { revision }) → { paperclip, apps, compose, catalog, warnings, edge }.
 * productDir holds modules/<name>/module.yaml; instanceDir holds instance.yaml, agents/<key>.md additions to a module
 * agent's handbook, and agents/<key>/ folders (agent.yaml + AGENTS.md): the instance's own agents.
 */
export function compile(productDir, instanceDir, { revision } = {}) {
  const instFile = join(instanceDir, "instance.yaml");
  if (!existsSync(instFile)) fail(`no instance.yaml in ${instanceDir}: set AIDENHQ_INSTANCE_DIR to your instance checkout (see docs/USAGE.md)`);
  const instance = readYaml(instFile);
  const all = discover(productDir);
  if (!all.has("core")) fail("modules/core is missing");
  const enabled = resolveEnabled(all, instance.modules ?? []);
  const warnings = [];

  // Settings: module defaults, then the instance; required ones must end up set.
  const settings = {};
  for (const name of enabled) for (const [k, d] of Object.entries(all.get(name).def.settings ?? {})) if (d && "default" in d) settings[k] = d.default;
  Object.assign(settings, instance.settings ?? {});
  for (const name of enabled) {
    for (const [k, d] of Object.entries(all.get(name).def.settings ?? {})) {
      if (d?.required && settings[k] == null) fail(`setting ${k} is required by ${name}`);
      // `values`: the allowed values (a list setting must hold at least one, each allowed).
      if (d?.values && settings[k] != null) {
        const v = [settings[k]].flat();
        const words = d.values.length > 1 ? `${d.values.slice(0, -1).join(", ")} or ${d.values.at(-1)}` : d.values[0];
        if (!v.length) fail(`settings.${k}: at least one`);
        if (v.some((x) => !d.values.includes(x))) fail(`settings.${k}: each must be ${words}`);
      }
    }
  }

  // settings.owner_email is the owner's board account (the only one setup creates, ops/setup.sh); core passes it to the
  // board (BOARD_OWNER_EMAIL). Checked here, after the modules' own required settings.
  if (!settings.owner_email) fail("settings.owner_email is required (the owner's board account)");

  // Derived (not settable): the orgs the src_github sync covers, github_orgs plus the agents org.
  settings.agents_org = agentsOrg(settings); // the only org github-mcp's commit_status_set may write to
  settings.github_sync_orgs = [...new Set([...[settings.github_orgs ?? []].flat(), agentsOrg(settings)].filter(Boolean))].join(",");

  const core = substitute(all.get("core").def, settings);
  const paperclip = { company: core.company, ...(settings.owner_name ? { owner_name: String(settings.owner_name) } : {}), ...(agentsOrg(settings) ? { github_agents_org: agentsOrg(settings) } : {}), autonomy: String(settings.autonomy ?? "off"), labels: [], mcp_servers: {}, codex_args: core.codex_args ?? [], agents: {}, routines: {} };
  const apps = [];
  const instanceAppDefs = existsSync(join(instanceDir, "apps.yaml")) ? (readYaml(join(instanceDir, "apps.yaml")).apps ?? []) : [];
  const instanceApps = instanceAppDefs.map((a) => a.name);
  const compose = { services: {}, secrets: {}, volumes: {}, networks: {} };
  const labelNames = new Set();
  const routineTitles = new Set();

  for (const name of enabled) {
    const { root } = all.get(name);
    const def = substitute(all.get(name).def, settings);
    const isolation = isolationOf(def.isolation, `module ${name}`);
    if (isolation === "untrusted" && (Object.keys(def.connections ?? {}).length || def.compose)) fail(`untrusted module ${name} may not declare connections or compose services`);
    for (const l of def.labels ?? []) { if (labelNames.has(l.name)) fail(`duplicate label: ${l.name}`); labelNames.add(l.name); paperclip.labels.push(l); }
    for (const [k, c] of Object.entries(def.connections ?? {})) {
      if (!Array.isArray(c.tools?.read) || !Array.isArray(c.tools?.write)) fail(`connection ${k}: tools.read and tools.write must list its tools`);
      // Every HTTP call carries the agent's run key; the service checks it against the grants table (whoami).
      put(paperclip.mcp_servers, k, c.url ? { ...c, env_http_headers: { "X-Agent-Key": "PAPERCLIP_API_KEY", ...c.env_http_headers } } : c, "connection");
    }
    for (const [key, a] of Object.entries(def.agents ?? {})) {
      if (a.mcp_servers || a.enabled_tools) fail(`agent ${key}: use connections: (mcp_servers and enabled_tools are gone)`);
      const file = join(root, "agents", key, "AGENTS.md");
      if (!existsSync(file)) fail(`agent ${key}: missing ${relative(productDir, file)}`);
      const { meta } = frontmatter(readFileSync(file, "utf8"));
      const extra = join(instanceDir, "agents", `${key}.md`);
      put(paperclip.agents, key, {
        name: meta.name, title: meta.title, ...(meta.avatar ? { avatar: meta.avatar } : {}), ...(meta.reportsTo ? { reports_to: meta.reportsTo } : {}), instructions: file,
        ...a, module: name, isolation: isolationOf(a.isolation ?? def.isolation, `agent ${key}`),
        ...(existsSync(extra) ? { instructions_extra: extra } : {}),
      }, "agent");
    }
    for (const [key, r] of Object.entries(def.routines ?? {})) {
      if (routineTitles.has(r.title)) fail(`duplicate routine title: ${r.title}`);
      routineTitles.add(r.title);
      put(paperclip.routines, key, r, "routine");
    }
    for (const app of def.apps ?? []) {
      const { isolation: iso, ...rest } = app;
      const untrusted = isolationOf(iso ?? def.isolation, `app ${app.name}`, ["trusted", "untrusted"]) === "untrusted";
      if (apps.some((x) => x.name === app.name)) fail(`duplicate app: ${app.name}`);
      if (instanceApps.includes(app.name)) fail(`app ${app.name} is already in the instance apps.yaml; rename that app before enabling ${name}`);
      apps.push({ ...rest, path: relative(productDir, join(root, app.path)), ...(untrusted ? { untrusted: true } : {}), module: name, ...(revision ? { pin: revision } : {}) });
    }
    if (def.compose) {
      const frag = substitute(readYaml(join(root, def.compose)), settings);
      for (const [k, s] of Object.entries(frag.services ?? {})) mergeService(compose.services, k, rewriteService(root, s));
      for (const kind of ["secrets", "volumes", "networks"]) {
        for (const [k, v] of Object.entries(frag[kind] ?? {})) {
          if (k in compose[kind] && JSON.stringify(compose[kind][k]) !== JSON.stringify(v)) fail(`conflicting compose ${kind.slice(0, -1)}: ${k}`);
          compose[kind][k] = v;
        }
      }
    }
  }

  // Shared access: the gate and cloudflared, only when the instance sets `edge` (scripts/edge.mjs).
  const edge = edgeConfig(settings, instanceAppDefs, apps);
  if (edge) {
    for (const [k, svc] of Object.entries(edge.compose.services)) mergeService(compose.services, k, svc);
    Object.assign(compose.secrets, edge.compose.secrets);
  }
  // One host port, one owner: the product's compose, the modules', the gate, the board's auth listener and the apps.
  const base = existsSync(join(productDir, "compose.yaml")) ? readYaml(join(productDir, "compose.yaml")) : {};
  checkPorts([base, compose], [[GATE_PORT, "gate"], [AUTH_PORT, "board"], ...[...instanceAppDefs, ...apps].filter((a) => Number.isInteger(a.port)).map((a) => [a.port, `app ${a.name}`])]);

  instanceAgents(instanceDir, settings, paperclip, routineTitles);

  // Grants: `connection: read | write | [tools]` resolve to tool lists (Codex scoping and the grants table setup writes).
  // A grant to a connection that isn't enabled fails, unless marked optional as `name?`.
  for (const [key, a] of Object.entries(paperclip.agents)) {
    if (a.reports_to && !paperclip.agents[a.reports_to]) fail(`${key}: reports_to ${a.reports_to}, which is not enabled`);
    const tools = {};
    for (const [raw, grant] of Object.entries(a.connections ?? {})) {
      const name = raw.replace(/\?$/, "");
      const c = paperclip.mcp_servers[name];
      if (!c) {
        if (raw.endsWith("?")) continue;
        fail(`${key}: grant to ${name}, which is not enabled (enable its module, or write "${name}?" to make the grant optional)`);
      }
      const all = [...c.tools.read, ...c.tools.write];
      const list = grant === "read" ? c.tools.read : grant === "write" ? all : Array.isArray(grant) ? grant : fail(`${key}: grant to ${name} must be read, write or a list of tools`);
      for (const t of list) if (!all.includes(t)) fail(`${key}: ${name} has no tool ${t}`);
      tools[name] = [...list];
    }
    // Every Codex agent can reply to and ask the owner (notify_owner, the "Asking the owner" shared section), except in
    // trial or in an untrusted module, where write tools stay off.
    const untrusted = a.isolation === "untrusted" || all.get(a.module)?.def.isolation === "untrusted";
    if (a.adapter === "codex_local" && !a.trial && !untrusted && paperclip.mcp_servers.slack_live && !tools.slack_live?.includes("notify_owner")) tools.slack_live = [...(tools.slack_live ?? []), "notify_owner"];
    delete a.connections;
    a.mcp_servers = Object.keys(tools);
    a.enabled_tools = tools;
    a.roles = a.roles ?? [];
    for (const r of a.roles) {
      if (!ROLES[r]) fail(`${key}: unknown role ${r} (known: ${Object.keys(ROLES).join(", ")})`);
      if (!ROLES[r].includes(a.module)) fail(`${key}: module ${a.module} may not grant ${r}`);
    }
    // In trial (tap 1): read-only but for reporting on its own tasks, and reporting to the Agent Architect, which reviews its work.
    if (a.trial) {
      if (a.reports_to !== "architect") fail(`${key}: an agent in trial reports to architect (got ${a.reports_to ?? "nobody"})`);
      for (const [name, list] of Object.entries(tools)) {
        const writes = list.filter((t) => paperclip.mcp_servers[name].tools.write.includes(t) && !(TRIAL_WRITES[name] ?? []).includes(t));
        if (writes.length) fail(`${key}: an agent in trial may not have ${name} write tools (${writes.join(", ")}); they come with tap 2`);
      }
    }
    // The module's own isolation counts too: an agent can't opt itself out of an untrusted module.
    if (a.isolation === "untrusted" || all.get(a.module)?.def.isolation === "untrusted") {
      if (a.roles.length) fail(`${key}: an untrusted module's agent may not have roles`);
      for (const [name, list] of Object.entries(tools)) {
        const writes = list.filter((t) => paperclip.mcp_servers[name].tools.write.includes(t));
        if (writes.length) fail(`${key}: an untrusted module's agent may not have ${name} write tools (${writes.join(", ")})`);
      }
    }
  }
  catchUpRoutines(paperclip, settings, routineTitles); // before the overrides, which may change their schedules
  for (const [key, r] of Object.entries(paperclip.routines)) if (!paperclip.agents[r.agent]) fail(`routine ${key}: agent ${r.agent} is not enabled`);

  // Instance overrides: a fixed set of fields, on things that exist.
  for (const [kind, entries] of Object.entries(instance.overrides ?? {})) {
    if (!OVERRIDABLE[kind]) fail(`override not allowed: ${kind}`);
    for (const [key, fields] of Object.entries(entries ?? {})) {
      const target = paperclip[kind][key] ?? fail(`unknown ${kind.slice(0, -1)}: ${key}`);
      for (const [f, v] of Object.entries(fields ?? {})) {
        if (!OVERRIDABLE[kind].includes(f)) fail(`override not allowed: ${kind}.${key}.${f}`);
        target[f] = v;
      }
    }
  }

  // model: and reasoning_effort: on a routine run its tasks with those instead of the agent's (setup puts them in the routine's
  // env; the launcher swaps them in). Codex agents Paperclip runs locally get the codex-model launcher; a computer agent's
  // launcher (services/computer) applies them to the exec in the box. Not runner-dispatched agents.
  for (const [key, r] of Object.entries(paperclip.routines)) {
    if (r.model == null && r.reasoning_effort == null) continue;
    const a = paperclip.agents[r.agent];
    for (const f of ["model", "reasoning_effort"]) if (r[f] != null && (typeof r[f] !== "string" || !r[f].trim())) fail(`routine ${key}: ${f} must be a string`);
    if (a.adapter !== "codex_local" || a.dispatch === "runner") fail(`routine ${key}: model and reasoning_effort work only for a codex_local agent without dispatch: runner`);
    if (!a.image) a.command = CODEX_MODEL_COMMAND;
  }

  // Each HTTP connection's service learns its name, where Paperclip is (whoami) and gets the grants table setup writes
  // (read-only). A connection served from the root compose (apps-mcp) is wired the same way there, by hand.
  const owners = {};
  for (const [name, c] of Object.entries(paperclip.mcp_servers)) {
    const host = c.url && new URL(c.url).hostname;
    const svc = host && compose.services[host];
    if (!svc) continue;
    if (owners[host]) fail(`connections ${owners[host]} and ${name} share the service ${host}`);
    owners[host] = name;
    if (Array.isArray(svc.environment)) fail(`compose service ${host}: environment must be a map`);
    // AIDENHQ_LAUNCHER_URL: run tokens from agent computers are resolved there (services/computer).
    svc.environment = { PAPERCLIP_URL: "http://paperclip:3100", ...svc.environment, AIDENHQ_CONNECTION: name, AIDENHQ_GRANTS_FILE: GRANTS_FILE, AIDENHQ_LAUNCHER_URL: "${AIDENHQ_LAUNCHER_URL:-http://10.231.0.1:8199}" };
    svc.volumes = [...(svc.volumes ?? []), GRANTS_MOUNT];
  }

  // Each enabled bearer connection's token reaches the paperclip container (exported generically by its entrypoint).
  const tokens = Object.values(paperclip.mcp_servers).map((c) => c.bearer_token_env_var).filter(Boolean)
    .map((v) => v.replace(/^AIDENHQ_/, "").toLowerCase()).filter((s) => s in compose.secrets);
  if (tokens.length) compose.services.paperclip = { secrets: tokens };

  const catalog = [...all.values()].map(({ name, def }) => ({
    name, description: def.description ?? "", enabled: enabled.includes(name), chosen: (instance.modules ?? []).includes(name), requires: def.requires ?? [],
    agents: Object.keys(def.agents ?? {}), routines: Object.keys(def.routines ?? {}), connections: Object.keys(def.connections ?? {}),
    apps: (def.apps ?? []).map((a) => a.name), ...(revision ? { revision } : {}),
  }));
  // Secrets of channels the owner may not use: created empty when missing so compose starts (compile.mjs).
  const optionalSecrets = enabled.flatMap((name) => all.get(name).def.optional_secrets ?? []);
  // Host-only tokens a module needs: created random when missing (compile.mjs).
  const generatedSecrets = enabled.flatMap((name) => all.get(name).def.generated_secrets ?? []);
  validateImages(paperclip.agents); // image: an agent computer (module, instance override or instance agent)
  return { paperclip, apps: { apps }, compose, catalog, warnings, optionalSecrets, generatedSecrets, edge: edge && { gate: edge.gate, cloudflared: edge.cloudflared, gateSecrets: edge.gateSecrets } };
}

/**
 * The instance's own agents: each folder agents/<key>/ with agent.yaml and AGENTS.md. Module "instance", which the roles
 * registry allows nothing. Name and reporting line come from agent.yaml only (the handbook's frontmatter is ignored), so
 * a handbook-only edit can't move anything. A key a module already uses fails (an instance can't redefine `architect`).
 */
function instanceAgents(instanceDir, settings, paperclip, routineTitles) {
  const dir = join(instanceDir, "agents");
  for (const key of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const file = join(dir, key, "agent.yaml");
    if (!existsSync(file)) continue;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(key)) fail(`agents/${key}: the folder name is the agent's key (lowercase letters, digits and -)`);
    const handbook = join(dir, key, "AGENTS.md");
    if (!existsSync(handbook)) fail(`agent ${key}: missing agents/${key}/AGENTS.md`);
    const def = substitute(readYaml(file), settings);
    for (const f of Object.keys(def)) if (!INSTANCE_AGENT_FIELDS.includes(f)) fail(`agent ${key}: ${f === "roles" ? "an instance agent may not have roles" : `unknown field ${f} (known: ${INSTANCE_AGENT_FIELDS.join(", ")})`}`);
    for (const f of ["name", "description", "model", "budget"]) if (def[f] == null || def[f] === "") fail(`agent ${key}: ${f} is required`);
    if (typeof def.budget !== "number" || !(def.budget > 0)) fail(`agent ${key}: budget is USD per month, a number above 0`);
    if (def.max_parallel != null && !(Number.isInteger(def.max_parallel) && def.max_parallel >= 1 && def.max_parallel <= 10)) fail(`agent ${key}: max_parallel must be 1 to 10`);
    if (def.trial != null && def.trial !== true) fail(`agent ${key}: trial is true or absent`);
    const { description, routines, ...rest } = def;
    put(paperclip.agents, key, { adapter: "codex_local", ...rest, title: String(description).trim(), instructions: handbook, module: "instance", isolation: "trusted" }, "agent");
    for (const [rk, r] of Object.entries(routines ?? {})) {
      // Schedules only: webhooks and their secrets (webhook, webhook_base, secrets_prefix) come from modules.
      for (const f of Object.keys(r ?? {})) if (!INSTANCE_ROUTINE_FIELDS.includes(f)) fail(`agent ${key}: routine ${rk}: ${f} isn't allowed (known: ${INSTANCE_ROUTINE_FIELDS.join(", ")})`);
      if (r.agent && r.agent !== key) fail(`agent ${key}: routine ${rk} must run as ${key}`);
      if (!r.title || routineTitles.has(r.title)) fail(`agent ${key}: routine ${rk} needs a title no other routine has`);
      routineTitles.add(r.title);
      put(paperclip.routines, `${key}-${rk}`, { ...r, agent: key }, "routine");
    }
  }
}

// Catch-up wake-ups: `catch_up: true` on an agent adds one routine that wakes it on a schedule to check the work it
// waits on, so a missed event doesn't stall it. Runner-dispatched agents (Software and Platform Engineers) are woken by the runner.
const CATCH_UP_TOOLS = ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"];
const CATCH_UP_PROMPT = `Today is {{date}}. This is a catch-up run: follow "Catching up" in your instructions. This task is only the
catch-up: delegate under the original work task, never this one, and finish this one with task_finish when done.
`;
/** A minute 0-29 per agent key, so the catch-ups of different agents don't all fire at once. */
const catchUpMinute = (key) => [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 30;

function catchUpRoutines(paperclip, settings, routineTitles) {
  for (const [key, a] of Object.entries(paperclip.agents)) {
    if (a.catch_up == null) continue;
    if (a.catch_up !== true) fail(`agent ${key}: catch_up is true or absent`);
    if (a.dispatch === "runner") fail(`agent ${key}: a runner-dispatched agent can't have catch_up (the runner wakes it)`);
    const tools = a.enabled_tools.paperclip_tasks ?? [];
    const missing = CATCH_UP_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length) fail(`agent ${key}: catch_up needs paperclip_tasks: ${missing.join(", ")}`);
    const title = `Catch up: ${key}`;
    if (routineTitles.has(title)) fail(`duplicate routine title: ${title}`);
    routineTitles.add(title);
    const m = catchUpMinute(key), tz = settings.timezone;
    // Hourly on weekdays 08:00-20:00, every 2 hours otherwise (one cadence for every agent). A catch-up only looks and nudges,
    // so it runs on the cheap model at low effort.
    put(paperclip.routines, `catch-up-${key}`, {
      title, agent: key, description: CATCH_UP_PROMPT, concurrency: "skip_if_active",
      model: "~deepseek/deepseek-flash-latest", reasoning_effort: "low",
      schedules: [
        { cron: `${m} 8-19 * * 1-5`, timezone: tz, label: "catch-up work hours" },
        { cron: `${m} 0,2,4,6,20,22 * * 1-5`, timezone: tz, label: "catch-up weekday nights" },
        { cron: `${m} */2 * * 0,6`, timezone: tz, label: "catch-up weekends" },
      ],
    }, "routine");
  }
}

/** The shared "Catching up" handbook section (modules/core/catching-up.md) for an agent with catch_up, naming the Fleet issues task. */
export function catchUpSection(agent, fleetIssues, productDir) {
  if (agent.catch_up !== true) return "";
  if (!fleetIssues) fail("catch_up: the Fleet issues task is missing");
  return `\n\n${readFileSync(join(productDir, "modules/core/catching-up.md"), "utf8").trim().replaceAll("{{fleet_issues}}", fleetIssues)}\n`;
}

/**
 * The one unassigned "Fleet issues" task (label system-error) where catch-up runs note missed wake-ups and stuck work for
 * the watcher to triage. Unassigned, so a note wakes nobody. Found by title and label; returns its identifier.
 */
export async function ensureFleetIssues({ api, companyId, step }) {
  const { json: labels } = await api("GET", `/api/companies/${companyId}/labels`);
  let label = labels.find((l) => l.name === "system-error");
  if (!label) label = (await api("POST", `/api/companies/${companyId}/labels`, { name: "system-error", color: "#dc2626" })).json;
  const q = new URLSearchParams({ labelId: label.id, status: "backlog,todo,in_progress,in_review,blocked", limit: "200", excludeRoutineExecutions: "true" });
  const { json: open } = await api("GET", `/api/companies/${companyId}/issues?${q}`);
  const found = open.find((i) => i.title === "Fleet issues" && !i.assigneeAgentId);
  if (found) return found.identifier;
  const { json: made } = await api("POST", `/api/companies/${companyId}/issues`, {
    title: "Fleet issues", status: "todo", priority: "low", labelIds: [label.id],
    description: "Missed wake-ups and stuck work that agents noticed on their catch-up runs, one comment per issue keyed `key: <task> · <failure kind> · <id>`. Triaged by the person or Claude; fixes go to their own tasks.",
  });
  step(`Created task Fleet issues (${made.identifier})`);
  return made.identifier;
}

/**
 * ops-mcp's vault folders and reference docs, from the host's .env (never from instance.yaml, which agents can edit
 * through apply): VAULT_DIR + VAULT_FOLDERS (comma-separated, vault-relative) and KNOWLEDGE_BASES (name=/path, read-only).
 */
export function hostMounts(env) {
  const out = [];
  const plain = (p) => typeof p === "string" && p.startsWith("/") && !p.includes(":");
  for (const raw of String(env.VAULT_FOLDERS ?? "").split(",")) {
    const f = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!f) continue;
    if (f.includes("..") || f.startsWith(".") || f.includes(":")) fail(`invalid vault folder: ${raw.trim()}`);
    if (!plain(env.VAULT_DIR)) fail("VAULT_DIR must be an absolute path without ':'");
    out.push(`${env.VAULT_DIR}/${f}:/vault/${f}`);
  }
  for (const raw of String(env.KNOWLEDGE_BASES ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = raw.indexOf("=");
    const name = raw.slice(0, i), path = raw.slice(i + 1);
    if (i < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || !plain(path)) fail(`invalid KNOWLEDGE_BASES entry: ${raw} (expected name=/path)`);
    out.push(`${path}:/knowledge/${name}:ro`);
  }
  return out;
}

/**
 * Creates each missing optional secret as an empty 0600 file (empty = channel not configured), but only when the
 * directory already holds `known` (a secret every instance has): a locked vault shows a bare, empty mountpoint, and
 * writing into it would stop gocryptfs from mounting. `generate`: a random token instead (a module's generated_secrets).
 * Returns the files created.
 */
export function ensureOptionalSecrets(dir, names, known, generate = false) {
  if (!existsSync(join(dir, known))) return [];
  const made = names.filter((n) => !existsSync(join(dir, n)));
  for (const n of made) writeFileSync(join(dir, n), generate ? randomBytes(32).toString("hex") : "", { mode: 0o600 });
  return made;
}

/**
 * What each of an agent's connections is best for (a connection's `guide:`), appended to its handbook so it picks the
 * right source. Glean first: one search across the company beats searching each system.
 */
export function sourcesSection(agent, mcpServers) {
  const names = (agent.mcp_servers ?? []).filter((n) => mcpServers[n]?.guide);
  if (!names.length) return "";
  names.sort((a, b) => (a === "glean" ? -1 : b === "glean" ? 1 : 0));
  return `\n\n## Your sources\n\n${names.map((n) => `- \`${n}\`: ${String(mcpServers[n].guide).trim()}`).join("\n")}\n`;
}
