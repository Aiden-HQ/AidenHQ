import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUNDLE } from "./bundle.mjs";
import { ensureIdentityKeys } from "../identity.mjs";
import { checkEntries, compile, composeSecretFiles, ensureMountedSecrets, writeKinds, ensureOptionalSecrets, grantEntry, healthProbeAgent, hostMounts, LEGACY_HOST_ENV, LEGACY_LINKS, LEGACY_SECRETS, mapLimit, OPS_NETWORKS } from "../modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "fixtures/mods");
const base = { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" };

/** A throwaway instance dir: instance.yaml with these modules/settings/overrides, plus optional handbook additions. */
function inst(modules, settings = base, extra = {}, agents = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings, ...extra }));
  mkdirSync(join(dir, "agents"));
  for (const [k, v] of Object.entries(agents)) writeFileSync(join(dir, "agents", `${k}.md`), v);
  return dir;
}
/** An instance of the fixture product: its `core` module is ordinary, so it is listed. */
const finst = (modules, ...rest) => inst(["core", ...modules], ...rest);
/** An instance of the real product: the default bundle (compile enables exactly what an instance lists) plus these modules. */
const pinst = (modules, settings, ...rest) => inst([...BUNDLE, ...modules], { product_repo: "acme/aidenhq", ...settings }, ...rest);
const enabledOf = (r) => r.catalog.filter((m) => m.enabled).map((m) => m.name).sort();

/** A copy of the fixture product with its marketplace rewritten by `edit`. */
function market(edit) {
  const dir = mkdtempSync(join(tmpdir(), "product-"));
  cpSync(mods, dir, { recursive: true });
  const file = join(dir, "modules", "marketplace.json");
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8")))));
  return dir;
}
test("unknown marketplace fields are ignored", () => {
  const dir = market((m) => ({ ...m, extra: 1, plugins: m.plugins.map((p) => ({ ...p, version: "1.0.0", tags: ["x"] })) }));
  assert.deepEqual(enabledOf(compile(dir, finst(["a"]))), ["a", "b", "core", "eng", "kernel"]);
});
test("a module directory missing from the marketplace fails", () =>
  assert.throws(() => compile(market((m) => ({ ...m, plugins: m.plugins.filter((p) => p.name !== "b") })), finst(["a"])), /modules\/b is not in modules\/marketplace.json/));
test("a remote source in the product's own marketplace is refused (third-party marketplaces hold those)", () =>
  assert.throws(() => compile(market((m) => ({ ...m, plugins: m.plugins.map((p) => (p.name === "b" ? { name: "b", source: { source: "github", repo: "acme/b", sha: "1".repeat(40) } } : p)) })), finst(["a"])), /a remote source belongs in a third-party marketplace/));
test("requires pulls dependencies in", () => assert.deepEqual(enabledOf(compile(mods, finst(["a"]))), ["a", "b", "core", "eng", "kernel"]));
test("engines: the registry lists each kind's module, bin and data; crew args come from the engine module", () => {
  const out = compile(mods, finst([]));
  assert.deepEqual(Object.keys(out.engines).sort(), ["codex", "codex-openrouter"]);
  assert.deepEqual(out.engines["codex-openrouter"], { kind: "codex-openrouter", bin: "modules/eng/bin/engine", gateway: true, box: true, state: "task", seed: [{ from: "bin/engine", to: "x/engine" }], module: "eng", dir: "modules/eng", live_input: false });
  assert.deepEqual(out.paperclip.codex_args, ["--sandbox", "read-only"]);
});
test("engines: two modules with one engine kind fail compile", () =>
  assert.throws(() => compile(mods, finst(["engdup"])), /two modules declare engine kind codex-openrouter: eng and engdup/));
test("engines: a runner agent on an engine no enabled module provides fails compile", () => {
  compile(mods, finst(["engrunner"]));
  assert.throws(() => compile(mods, finst(["engrunner"], base, { overrides: { agents: { coder: { engine: "nope" } } } })), /agent coder: unknown engine nope \(enabled: codex, codex-openrouter\)/);
});
test("missing module is an error", () => assert.throws(() => compile(mods, finst(["nope"])), /unknown module: nope/));
test("cycle is an error", () => assert.throws(() => compile(mods, finst(["cyc1"])), /module cycle: cyc1 → cyc2 → cyc1/));
test("duplicate agent key across modules", () => assert.throws(() => compile(mods, finst(["dup1", "dup2"])), /duplicate agent: x/));
test("grants resolve to tool lists: read, write, or a list", () => {
  const x = compile(mods, finst(["a"])).paperclip.agents.x;
  assert.deepEqual(x.mcp_servers, ["tasks", "bconn", "aconn"]);
  assert.deepEqual(x.enabled_tools, { tasks: ["t"], bconn: ["b_get"], aconn: ["a_get", "a_set"] });
  assert.deepEqual(x.roles, []);
  assert.equal(x.connections, undefined);
});
test("an optional grant (name?) is dropped when its module is off, kept when on", () => {
  assert.equal(compile(mods, finst(["a"])).paperclip.agents.x.enabled_tools.glean, undefined);
  assert.deepEqual(compile(mods, finst(["a", "glean"])).paperclip.agents.x.enabled_tools.glean, ["search"]);
});
test("a grant to a connection that isn't enabled fails compile", () =>
  assert.throws(() => compile(mods, finst(["needy"])), /n: grant to glean, which is not enabled/));
test("a granted tool the connection doesn't have fails compile", () =>
  assert.throws(() => compile(mods, finst(["badtool"])), /n: glean has no tool delete_everything/));
test("roles: unknown ones, and ones a module may not grant, fail compile", () => {
  assert.throws(() => compile(mods, finst(["rolez"])), /r: unknown role helper/);
  assert.throws(() => compile(mods, finst(["roley"])), /r: module roley may not grant fleet-admin/);
});
test("an agent from an untrusted module gets no roles and no write grants", () =>
  assert.throws(() => compile(mods, finst(["wild"])), /w: an untrusted module's agent may not have tasks write tools \(t2\)/));
test("every connection tags its tools read or write", () => assert.throws(() => compile(mods, finst(["untagged"])), /connection u: tools\.read and tools\.write/));
test("connections go through the kernel: no compiled service mounts grants; the kernel's table names each endpoint and key", () => {
  const r = compile(mods, finst(["a"]));
  const s = r.compose.services["a-mcp"];
  assert.equal(s.environment.AIDENHQ_MODULE, "a");
  assert.equal(s.environment.AIDENHQ_KERNEL_URL, "${AIDENHQ_KERNEL_URL:-http://10.231.0.1:3130}");
  for (const svc of Object.values(r.compose.services)) {
    assert.ok(!(svc.volumes ?? []).some((v) => String(v).includes("grants")), "no compiled service mounts grants");
    assert.equal(svc.environment?.AIDENHQ_GRANTS_FILE, undefined);
  }
  assert.equal(r.compose.services.paperclip, undefined, "no connection token reaches paperclip");
  assert.deepEqual(r.connections.aconn, { url: "http://a-mcp:1/mcp", auth_secret: "a_service_key", module: "a", returns: "untrusted", tools: { read: ["a_get"], write: ["a_set"], destructive: [] } });
});
test("unset required setting", () => assert.throws(() => compile(mods, finst(["a"], { timezone: "UTC", owner_email: "me@example.com" })), /setting owner_name is required by the kernel/));
test("unknown ${settings.x}", () => assert.throws(() => compile(mods, finst(["typo"])), /unknown setting: tz/));
test("settings substitute and {{date}} passes through", () => {
  const r = compile(mods, finst(["a"]));
  assert.equal(r.paperclip.routines.r.description, "Today is {{date}}; mail me@example.com");
  assert.equal(r.paperclip.routines.daily.schedules[0].timezone, "Europe/London");
  assert.equal(r.paperclip.company.name, "work");
});
test("overrides apply to allowed fields only", () => {
  assert.equal(compile(mods, finst(["a"], base, { overrides: { agents: { x: { model: "m2" } } } })).paperclip.agents.x.model, "m2");
  assert.equal(compile(mods, finst(["a"], base, { overrides: { agents: { x: { max_parallel: 4 } } } })).paperclip.agents.x.max_parallel, 4);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { max_parallel: 0 } } } })), /max_parallel must be 1 to 10/);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { mcp_servers: [] } } } })), /override not allowed: agents\.x\.mcp_servers/);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { nope: { model: "m" } } } })), /unknown agent: nope/);
  assert.deepEqual(compile(mods, finst([], base, { overrides: { routines: { daily: { status: "paused" } } } })).paperclip.routines.daily.status, "paused");
});
test("grants entry: models, fleet caps under the agent's override, graded off by default; a bad cap fails compile", () => {
  const r = compile(mods, finst(["a"], base, { overrides: { agents: { x: { model: "openrouter/m2", caps: { task_usd: 20 } } } } })).paperclip;
  assert.deepEqual(grantEntry("x", r.agents.x, { r1: { agent: "x", model: "m3" }, r2: { agent: "y", model: "m4" } }), { models: ["m2", "m3"], caps: { run_usd: 2, task_usd: 20, day_usd: 30 }, graded: false });
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { caps: { month_usd: 5 } } } } })), /x: caps\.month_usd isn't a cap/);
});
test("jobcaps: compiled for the gateway, carried in the grants entry; unknown or private-without-private_reads fail", () => {
  const out = compile(mods, finst(["jc"]));
  assert.deepEqual(out.jobcaps["jc-read"], { connection: "jconn", url: "http://j-mcp:81/mcp/read", bearer_secret: "j_mcp_read_token", tools: ["j_get", "j_list"] });
  assert.equal(out.jobcaps["jc-secret"].tool_timeout_s, 90);
  assert.deepEqual(grantEntry("eng", out.paperclip.agents.eng).jobcaps, ["jc-read"]); // nope-read? is optional
  assert.deepEqual(out.paperclip.agents.deep.jobcaps, ["jc-read", "jc-secret"]);
  assert.throws(() => compile(mods, finst(["jcunknown"])), /lost: unknown jobcap nope-read/);
  assert.throws(() => compile(mods, finst(["jcpriv"])), /nosy: jobcap jc-secret reads private data: set private_reads: true/);
});
test("generated compose: module services from services:, root services only gain board_env, links and secrets; compose fragments fail", () => {
  const a = compile(mods, finst(["a"])).compose;
  assert.deepEqual(a.services["a-mcp"].volumes, ["${AIDENHQ_DATA_DIR:-./data}/modules/a/a:/data"]);
  assert.deepEqual(Object.keys(a.services["a-mcp"].networks), ["mod-a"]);
  assert.equal(a.networks["mod-a"].name, "aidenhq-mod-a");
  const dir = mkdtempSync(join(tmpdir(), "prod-"));
  cpSync(join(here, "fixtures/mods"), dir, { recursive: true });
  writeFileSync(join(dir, "modules/a/compose.yaml"), "services: {}\n");
  writeFileSync(join(dir, "modules/a/module.yaml"), readFileSync(join(dir, "modules/a/module.yaml"), "utf8") + "compose: compose.yaml\n");
  assert.throws(() => compile(dir, finst(["a"])), /module a: compose fragments are gone/);
});
test("privileged: entries from the closed list only, at most 8 official modules (spec §5.6, raised from 7 for host-metrics)", async () => {
  const { PRIVILEGED } = await import("../../kernel/src/loader/services.ts");
  const product = join(here, "../..");
  const priv = JSON.parse(readFileSync(join(product, "modules/marketplace.json"), "utf8")).plugins.map((p) => [p.name, [YAML.parse(readFileSync(join(product, "modules", p.name, "module.yaml"), "utf8")).privileged ?? []].flat()]).filter(([, l]) => l.length);
  for (const [, l] of priv) for (const e of l) assert.ok(PRIVILEGED.includes(e), e);
  assert.ok(priv.length <= 8, priv.map(([n]) => n).join(", "));
});
test("H4: a module can't take another's network or service name (a link network's, a declared name the kernel resolves)", () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-"));
  cpSync(join(here, "fixtures/mods"), dir, { recursive: true });
  cpSync(join(here, "../../compose.yaml"), join(dir, "compose.yaml")); // the root services
  const add = (name, yaml) => {
    mkdirSync(join(dir, "modules", name), { recursive: true });
    writeFileSync(join(dir, "modules", name, "module.yaml"), `name: ${name}\ndescription: hostile\n${yaml}`);
    const m = JSON.parse(readFileSync(join(dir, "modules/marketplace.json"), "utf8"));
    m.plugins.push({ name, source: `./${name}` });
    writeFileSync(join(dir, "modules/marketplace.json"), JSON.stringify(m));
  };
  const img = `image: "example.com/acme/x:1@sha256:${"b".repeat(64)}"`;
  writeFileSync(join(dir, "modules/a/module.yaml"), readFileSync(join(dir, "modules/a/module.yaml"), "utf8").replace("      data: [\"a:/data\"]", "      data: [\"a:/data\"]\n      egress: true"));
  add("a-egress", `services:\n  run:\n    srv: { ${img} }\n`);
  assert.throws(() => compile(dir, finst(["a", "a-egress"])), /module a-egress: its network aidenhq-mod-a-egress is already a's/);
  add("glean-board", ""); // an empty module named like another's link network
  add("joiner", `requires: [glean-board]\nservices:\n  run:\n    srv: { ${img}, join: [glean-board] }\n`);
  assert.throws(() => compile(dir, finst(["joiner"])), /module joiner: joiner-srv joins glean-board, which defines no network of its own/);
  add("copycat", `services:\n  run:\n    a-mcp: { ${img} }\n`);
  assert.throws(() => compile(dir, finst(["a", "copycat"])), /module copycat: the service name a-mcp is already module a's/);
  add("boardy", `services:\n  run:\n    board: { ${img} }\n`);
  assert.throws(() => compile(dir, finst(["boardy"])), /module boardy: the service name board is already a root service's/);
});
test("legacy lists stay closed: links, root secrets and host variables may only shrink", () => {
  const was = {
    links: { "owner-channel": ["board", "paperclip", "sources"], monitoring: ["board"], tasks: ["backplane"], meetings: ["backplane", "sources"], google: ["board", "sources"], jira: ["board", "sources"], hubspot: ["board", "sources"], glean: ["board"], grafana: ["board"], clickhouse: ["board"], github: ["board", "sources"], primer: ["board"], slack: ["board"], security: ["paperclip", "sources"] },
    secrets: { "owner-channel": ["paperclip_board_key", "board_internal_token", "owner_decide_key"], tasks: ["board_internal_token"], google: ["google_auth_token", "gateway_source_key"], jira: ["gateway_source_key"], glean: ["glean_auth_token"], grafana: ["grafana_auth_token"], clickhouse: ["clickhouse_auth_token"], github: ["github_token", "github_app"] },
    host: { "owner-channel": ["OWNER_SLACK_USER_ID", "SLACK_LIVE_IGNORE_CHANNELS", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_TASK_URL", "OWNER_COMMAND_CHANNEL", "AIDENHQ_GATEWAY_URL"], google: ["BOARD_LAN_URL", "GOOGLE_CALENDAR_ID", "AIDENHQ_GATEWAY_URL"], jira: ["AIDENHQ_GATEWAY_URL"], tasks: ["AIDENHQ_GATEWAY_URL"], github: ["GITHUB_COMMENT_ORGS"], slack: ["SLACK_CLIENT_ID"] },
  };
  // 2f split owner-channel into channel-telegram, channel-slack and chat-lane: each may keep only a part of what it had.
  const split = { "channel-telegram": "owner-channel", "channel-slack": "owner-channel", "chat-lane": "owner-channel", grading: "board-grades" };
  // 3h moved the grade rows out of the board into the grading module: its one link is the pair network to the board, for the
  // board's reads of those rows, until the board is a module (4a). No root secret, no host variable.
  was.links["board-grades"] = ["board"];
  const within = (now, before) => Object.entries(now).every(([m, l]) => l.every((x) => (before[m] ?? before[split[m]] ?? []).includes(x)));
  assert.ok(within(Object.fromEntries(Object.entries(LEGACY_LINKS).map(([m, v]) => [m, v.to])), was.links));
  assert.ok(within(LEGACY_SECRETS, was.secrets));
  assert.ok(within(LEGACY_HOST_ENV, was.host));
  assert.deepEqual(OPS_NETWORKS, { ci: "aidenhq-ci" });
});
test("reports_to a disabled agent is an error", () => assert.throws(() => compile(mods, finst(["orphan"])), /z: reports_to y, which is not enabled/));
test("untrusted app compiles to untrusted: true", () => {
  const [app] = compile(mods, finst(["appmod"])).apps.apps;
  assert.equal(app.untrusted, true); assert.equal(app.isolation, undefined); assert.equal(app.module, "appmod");
  assert.equal(app.path, "modules/appmod/apps/web");
});
test("untrusted module may not ship connections", () => assert.throws(() => compile(mods, finst(["shady"])), /untrusted module shady may not declare connections/));
test("vault and knowledge mounts come from the host env, validated", () => {
  assert.deepEqual(hostMounts({ VAULT_DIR: "/v", VAULT_FOLDERS: "Meetings,/Notes/", KNOWLEDGE_BASES: "kb=/k" }),
    ["/v/Meetings:/vault/Meetings", "/v/Notes:/vault/Notes", "/k:/knowledge/kb:ro"]);
  assert.deepEqual(hostMounts({}), []);
  assert.throws(() => hostMounts({ VAULT_DIR: "/v", VAULT_FOLDERS: "../etc" }), /invalid vault folder: \.\.\/etc/);
  assert.throws(() => hostMounts({ VAULT_DIR: "/v", VAULT_FOLDERS: ".ssh" }), /invalid vault folder: \.ssh/);
  assert.throws(() => hostMounts({ VAULT_DIR: "/v", VAULT_FOLDERS: "a:b" }), /invalid vault folder: a:b/);
  assert.throws(() => hostMounts({ KNOWLEDGE_BASES: "bad name=/k" }), /invalid KNOWLEDGE_BASES entry: bad name=\/k/);
  assert.throws(() => hostMounts({ KNOWLEDGE_BASES: "kb=/k:/etc" }), /invalid KNOWLEDGE_BASES entry/);
});
test("a module app name taken by an instance app is an error", () => {
  const dir = finst(["appmod"]);
  writeFileSync(join(dir, "apps.yaml"), "apps:\n  - { name: web, repo: o/x, owner: a, description: d }\n");
  assert.throws(() => compile(mods, dir), /app web is already in the instance apps.yaml; rename that app before enabling appmod/);
});

// ------------------------------------------------------------------ the real modules
const repo = join(here, "../..");

test("disabling open-loops removes its agents, routines and labels only", () => {
  const dir = pinst(["meetings", "engineering", "warehouse", "github", "glean", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", product_repo: "acme/aidenhq", owner_email: "o@x" });
  const r = compile(repo, dir);
  for (const k of ["open-loops", "slack-triage", "slack-scout", "inbox-agent"]) assert.equal(r.paperclip.agents[k], undefined);
  for (const k of ["chief-of-staff", "assistant", "app-maintainer", "fleet-engineer", "meeting-librarian"]) assert.ok(r.paperclip.agents[k], k);
  assert.ok(!r.paperclip.labels.some((l) => l.name === "waiting-on"));
  assert.ok(r.paperclip.mcp_servers.telegram && r.paperclip.mcp_servers.chat_lane, "the Telegram channel and the chat lane stay: the bundle lists them");
  assert.ok(r.kernelModules.mounts.github_token.includes("apps-mcp"), "a setup secret's services include other modules' that mount it");
});
// Lean-core 3h: graded done is the grading module: its finish check for the kernel, its own token, the
// board's read key and the tasks module on its network; nothing of the control plane's.
test("the grading module: its finish check, its token, the board's key, tasks on its network", () => {
  const r = compile(repo, pinst([], { timezone: "UTC", owner_name: "Sam", owner_email: "o@x" }));
  assert.deepEqual(r.checks["grading.finish"], { module: "grading", at: "task.finish", url: "http://grading:8096/check/finish", auth_secret: "grading_check_key", label: "grading" });
  assert.equal(r.kernelModules.modules.grading.token, "grading_token");
  assert.deepEqual(r.kernelModules.modules.grading.roles, ["kernel.cp-read"]);
  assert.deepEqual(r.kernelModules.services.grading, ["grading-grading"], "the services the kernel recreates for its setup secrets");
  const g = r.compose.services["grading-grading"];
  assert.ok(g && !g.ports && !JSON.stringify(g).includes("paperclip_board_key"), "no published port, no control-plane key");
  assert.equal(r.compose.services.board.environment.GRADING_URL, "http://grading:8096");
  assert.ok(r.compose.services.board.secrets.includes("grading_board_key"));
  assert.ok(Object.keys(r.compose.services["tasks-mcp"].networks).includes("mod-grading"));
});
// Lean-core 3e: the runner starts jobs through the kernel as engineering, with its own generated token, for every engine-run
// agent (the Platform Engineer included); engineering needs any engine, which engine-codex provides.
test("engineering is the job dispatcher: its token, and every dispatch: runner agent in dispatches", () => {
  const dir = pinst(["meetings", "engineering", "warehouse", "github", "glean", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", product_repo: "acme/aidenhq", owner_email: "o@x" });
  const r = compile(repo, dir);
  const e = r.kernelModules.modules.engineering;
  assert.deepEqual([e.roles, e.token], [["kernel.jobs"], "engineering_token"]);
  assert.ok(r.generatedSecrets.includes("engineering_token"));
  const runAgents = Object.entries(r.paperclip.agents).filter(([, a]) => a.dispatch === "runner").map(([k]) => k).sort();
  assert.ok(runAgents.includes("fleet-engineer") && runAgents.includes("engineer-openrouter"), runAgents.join(","));
  assert.deepEqual(e.dispatches, runAgents);
  for (const [n, m] of Object.entries(r.kernelModules.modules)) if (n !== "engineering") assert.equal(m.dispatches, undefined, n);
});
test("upstream: off grants no upstream tool; issues grants both; the scrub's terms and the instance reach github-mcp", () => {
  const settings = (upstream) => ({ timezone: "Europe/London", owner_name: "Ada Lovelace", company_name: "Acme Labs", owner_slack_user_id: "U1", owner_email: "ada.l@acme.example", instance_name: "acme", github_orgs: ["acme-co", "upstream-org"], product_repo: "upstream-org/product", jira_url: "https://jira.acme.example/x", ...(upstream ? { upstream } : {}) });
  const fleet = (upstream) => compile(repo, pinst(["github", "fleet-ops", "primer"], settings(upstream))).paperclip.agents["fleet-ops"];
  assert.equal(fleet("off").enabled_tools.github, undefined);
  for (const v of [undefined, "issues", "prs"]) assert.deepEqual(fleet(v).enabled_tools.github, ["github_app_issue", "github_app_issue_status"], String(v));
  assert.throws(() => fleet("maybe"), /upstream/);
  const r = compile(repo, pinst(["github", "fleet-ops", "primer"], settings()));
  const env = r.compose.services["github-mcp"].environment;
  // The origin ids' own key: generated, and mounted for github-mcp only.
  assert.ok(r.generatedSecrets.includes("github_origin_key"));
  assert.match(env.GITHUB_ORIGIN_KEY_FILE, /github_origin_key/);
  for (const [svc, def] of Object.entries(r.compose.services)) if (svc !== "github-mcp") assert.ok(!JSON.stringify(def).includes("github_origin_key"), svc);
  // Names and each word of them (but common words), the instance and its org, emails with their local part and domain, hosts.
  assert.deepEqual(env.GITHUB_OWNER_TERMS.split(",").sort(), ["Ada Lovelace", "Ada", "Lovelace", "Acme Labs", "Acme", "acme", "aidenhq-acme", "acme-co", "upstream-org", "ada.l@acme.example", "ada.l", "acme.example", "jira.acme.example"].sort());
});
test("Slack Scout's read grant has no draft tool", () => {
  const dir = pinst(["open-loops", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", owner_email: "e@x", product_repo: "acme/aidenhq" });
  const r = compile(repo, dir);
  assert.ok(r.paperclip.agents["slack-scout"].enabled_tools.slack.includes("slack_read_thread"));
  assert.ok(!r.paperclip.agents["slack-scout"].enabled_tools.slack.includes("slack_send_message_draft"));
});
test("module apps are pinned to the product revision", () => {
  const rev = "e".repeat(40);
  assert.equal(compile(mods, finst(["appmod"]), { revision: rev }).apps.apps[0].pin, rev);
  assert.equal(compile(mods, finst(["appmod"])).apps.apps[0].pin, undefined);
});

// The real product: nothing needs Slack; the owner channel is its own module.
const product = join(here, "../..");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" };
test("the default bundle compiles without the slack module", () => {
  const r = compile(product, pinst([], owner));
  assert.equal(r.compose.services["slack-mcp"], undefined);
  assert.ok(r.compose.services["channel-telegram-telegram"] && r.compose.services["chat-lane-lane"]);
  // channel-slack joined the bundle (set up from the board): its connection is declared, but it needs no secret to compile.
  assert.ok(r.paperclip.mcp_servers.slack_live?.setup, "channel-slack is in the bundle and says how to set it up");
  assert.ok(r.compose.secrets.telegram_notify_bot_token, "channel-telegram declares its secrets");
  // Voice notes are their own module, off by default: the default install builds no speech-to-text image.
  assert.ok(!Object.keys(r.compose.services).some((k) => k.includes("whisper")), "no whisper in the default install");
});
test("voice notes, once turned on: Whisper joins channel-telegram's network under the name its WHISPER_URL uses", () => {
  const r = compile(product, pinst(["voice"], owner));
  const w = r.compose.services["voice-whisper"];
  assert.ok(w, Object.keys(r.compose.services).join(", "));
  assert.deepEqual(w.networks["mod-channel-telegram"], { aliases: ["whisper"] });
  assert.equal(r.compose.services["channel-telegram-telegram"].environment.WHISPER_URL, "http://whisper:9000");
});
test("optional secrets are created only where the secrets dir is really there (never into a locked vault's bare mountpoint)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sec-"));
  assert.deepEqual(ensureOptionalSecrets(dir, ["telegram_notify_bot_token"], "slack_live_mcp_token"), [], "no known secret yet: looks like an unmounted vault");
  writeFileSync(join(dir, "slack_live_mcp_token"), "x");
  assert.deepEqual(ensureOptionalSecrets(dir, ["telegram_notify_bot_token"], "slack_live_mcp_token"), ["telegram_notify_bot_token"]);
  assert.equal(readFileSync(join(dir, "telegram_notify_bot_token"), "utf8"), "");
  assert.deepEqual(ensureOptionalSecrets(dir, ["primer_service_key"], "slack_live_mcp_token", true), ["primer_service_key"]);
  assert.match(readFileSync(join(dir, "primer_service_key"), "utf8"), /^[0-9a-f]{64}$/);
});
test("an install with no model key: an optional mounted secret starts empty, a missing auth secret fails loudly", () => {
  const r = compile(product, pinst([], owner));
  const mounts = composeSecretFiles(YAML.parse(readFileSync(join(product, "compose.yaml"), "utf8")), r.compose);
  assert.ok(mounts.openrouter_key.includes("board"), "the board mounts the model key");
  assert.equal(mounts.github_app, undefined, "a folder mounted under another name is left alone");
  const dir = mkdtempSync(join(tmpdir(), "sec-"));
  writeFileSync(join(dir, "paperclip_auth_secret"), "x");
  writeFileSync(join(dir, "telegram_service_key"), ""); // made empty earlier: still generated
  ensureOptionalSecrets(dir, r.generatedSecrets, "paperclip_auth_secret", true);
  assert.match(readFileSync(join(dir, "telegram_service_key"), "utf8"), /^[0-9a-f]{64}$/);
  const optional = [...r.optionalSecrets, ...r.askedSecrets];
  const { created, missing } = ensureMountedSecrets(dir, mounts, optional, "paperclip_auth_secret");
  assert.ok(created.includes("openrouter_key"));
  assert.equal(readFileSync(join(dir, "openrouter_key"), "utf8"), "");
  // A missing auth secret is never made empty: it is named, with what mounts it.
  const jwt = missing.find((m) => m.secret === "paperclip_agent_jwt_secret");
  assert.ok(jwt && jwt.services.includes("paperclip"), JSON.stringify(missing));
  assert.ok(!missing.some((m) => optional.includes(m.secret)));
  assert.throws(() => readFileSync(join(dir, "paperclip_agent_jwt_secret")));
  // A fresh host after scripts/bootstrap.sh and compile's own steps misses nothing: the bundle, and setup's default (+ google).
  for (const extra of [[], ["google"]]) {
    const g = compile(product, pinst(extra, owner));
    const m = composeSecretFiles(YAML.parse(readFileSync(join(product, "compose.yaml"), "utf8")), g.compose);
    const fresh = mkdtempSync(join(tmpdir(), "sec-"));
    for (const [, n] of readFileSync(join(product, "scripts/bootstrap.sh"), "utf8").matchAll(/^(?:gen_secret|placeholder) ([a-z_]+)\s/gm)) writeFileSync(join(fresh, n), "x");
    ensureOptionalSecrets(fresh, g.optionalSecrets, "paperclip_auth_secret");
    ensureOptionalSecrets(fresh, g.generatedSecrets, "paperclip_auth_secret", true);
    ensureIdentityKeys(fresh);
    assert.deepEqual(ensureMountedSecrets(fresh, m, [...g.optionalSecrets, ...g.askedSecrets], "paperclip_auth_secret").missing, [], extra.join());
  }
});
test("secrets the setup must not leave to a manual step are generated", () => {
  const g = compile(product, pinst(["primer"], owner)).generatedSecrets;
  for (const k of ["primer_service_key", "telegram_service_key", "computer_launcher_token"]) assert.ok(g.includes(k), k);
});
test("autonomy: off by default, reaches the compiled config, a bad value fails; the reviewer key is generated, no decide key", () => {
  assert.equal(compile(product, pinst([], owner)).paperclip.autonomy, "off");
  assert.equal(compile(product, pinst([], { ...owner, autonomy: "tier0" })).paperclip.autonomy, "tier0");
  assert.throws(() => compile(product, pinst([], { ...owner, autonomy: "yes" })), /autonomy/);
  const generated = compile(product, pinst([], owner)).generatedSecrets;
  assert.ok(generated.includes("reviewer_key") && !generated.some((g) => /decide_key/.test(g)));
});

test("two modules extending the same service merge environment and secrets", () => {
  const board = compile(mods, finst(["ext1", "ext2"])).compose.services.board;
  assert.deepEqual(board.environment, { A: "1", S1_FILE: "/run/secrets/s1", B: "2", S2_FILE: "/run/secrets/s2" });
  assert.deepEqual(board.secrets, ["s1", "s2"]);
});
test("destructive tools: `write` never grants them, a list must name them; compile refuses a delete-looking tool tagged write", () => {
  const { agents } = compile(mods, finst(["wiper"])).paperclip;
  assert.deepEqual(agents.w.enabled_tools.wconn, ["w_get", "w_set"]);
  assert.deepEqual(agents.wd.enabled_tools.wconn, ["w_get", "w_delete"]);
  assert.throws(() => compile(mods, finst(["sloppy"])), /deleteIssue looks destructive/);
});
test("exposure: unset is tailscale (installs before the setting), one mode reaches the compiled output, a list or a bad value fails", () => {
  assert.equal(compile(product, pinst([], owner)).exposure, "tailscale");
  assert.equal(compile(product, pinst([], { ...owner, exposure: "public" })).exposure, "public");
  assert.throws(() => compile(product, pinst([], { ...owner, exposure: "open" })), /exposure/);
  assert.throws(() => compile(product, pinst([], { ...owner, exposure: ["public", "local"] })), /exposure/);
});

test("routine autonomy: full by default, tier0 for a webhook routine unless it says otherwise; an override must be a known value", () => {
  const { routines } = compile(mods, finst(["wiper"])).paperclip;
  assert.deepEqual([routines.sweep.autonomy, routines.hook.autonomy, routines.hookfull.autonomy], ["full", "tier0", "full"]);
  assert.throws(() => compile(mods, finst(["wiper"], base, { overrides: { routines: { sweep: { autonomy: "yes" } } } })), /routine sweep: autonomy is off, tier0, full/);
});

test("health check probes call as the least-granted agent holding every probe tool, or none", () => {
  const agents = {
    librarian: { enabled_tools: { google_workspace: ["calendar_list_events"] } },
    assistant: { enabled_tools: { google_workspace: ["gmail_search", "calendar_list_events", "docs_read"], github: ["github_whoami", "github_issue_read"] } },
    inbox: { enabled_tools: { google_workspace: ["gmail_search", "calendar_list_events"] } },
  };
  assert.equal(healthProbeAgent(agents, "google_workspace"), "inbox");
  assert.equal(healthProbeAgent(agents, "github"), "assistant");
  assert.equal(healthProbeAgent({ librarian: agents.librarian }, "google_workspace"), undefined);
});

test("mapLimit runs at most `limit` at a time and keeps the input order", async () => {
  let running = 0, peak = 0;
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("enumeration (spec §9): every shipped write or destructive tool maps to a kind or to conn.tool, each tool to at most one kind", () => {
  const product = join(here, "../..");
  const kinds = {};
  const writes = [];
  for (const { name } of JSON.parse(readFileSync(join(product, "modules/marketplace.json"), "utf8")).plugins) {
    const root = join(product, "modules", name);
    const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));
    Object.assign(kinds, writeKinds(name, def, root, {}, kinds));
    for (const [c, x] of Object.entries(def.connections ?? {})) writes.push(...x.tools.write.map((t) => [`${c}.${t}`, 0]), ...(x.tools.destructive ?? []).map((t) => [`${c}.${t}`, 1]));
  }
  const routed = Object.fromEntries(Object.entries(kinds).flatMap(([id, k]) => k.tools.map((ct) => [ct, id])));
  // Every routed tool is a write or destructive tool of its own module; the rest are conn.tool records (floor 0, destructive 1).
  for (const ct of Object.keys(routed)) assert.ok(writes.some(([w]) => w === ct), `${ct} is routed but is no write tool`);
  const kindOf = Object.fromEntries(writes.map(([ct, floor]) => [ct, routed[ct] ?? `conn.tool@${floor}`]));
  assert.deepEqual(["apps.app_deploy", "apps.app_run_request", "apps.app_restart", "apps.app_rollback", "apps.app_api", "apps.app_remove", "apps.app_create"].map((ct) => kindOf[ct]),
    ["apps-platform.deploy", "apps-platform.run", "apps-platform.restart", "apps-platform.rollback", "apps-platform.api_write", "conn.tool@1", "conn.tool@0"]);
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([id, k]) => [id, k.floor])), { "apps-platform.deploy": 0, "apps-platform.run": 1, "apps-platform.restart": 0, "apps-platform.rollback": 0, "apps-platform.api_write": 0, "hubspot.crm_write": 1, "primer.publish": 1, "channel-slack.post": 1, "channel-slack.bind": 0 });
  assert.deepEqual(["primer.primer_create_document", "primer.primer_add_version"].map((ct) => kindOf[ct]), ["primer.publish", "primer.publish"]);
  assert.equal(kindOf["slack_live.slack_post"], "channel-slack.post");
  // A kind naming a tool that isn't one of its module's writes, or one another kind took, fails compile.
  assert.throws(() => writeKinds("m", { providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], connections: { c: { tools: { read: ["r"], write: ["w"] } } }, writes: { k: { floor: 0, tools: ["r"] } } }, product), /r is no write or destructive tool/);
  assert.throws(() => writeKinds("m", { providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], connections: { c: { tools: { read: [], write: ["w"] } } }, writes: { k: { floor: 0, tools: ["w"] }, j: { floor: 1, tools: ["w"] } } }, product), /c\.w is already routed/);
});

test("checks: a task.finish check may observe; a hard gate or a write.filed check may not", () => {
  const def = (c) => ({ secrets: { provided: ["k"] }, checks: [{ id: "finish", at: "task.finish", post: "http://m:1/check", auth: "k", ...c }] });
  assert.equal(checkEntries("judge", def({ mode: "observe" }))["judge.finish"].mode, "observe");
  assert.equal(checkEntries("judge", def({}))["judge.finish"].mode, undefined);
  assert.throws(() => checkEntries("judge", def({ mode: "warn" })), /mode is observe or enforce/);
  assert.throws(() => checkEntries("platform", { checks: [{ id: "product-gate", at: "write.filed", mode: "observe" }] }), /hard gate: it always enforces/);
  assert.throws(() => checkEntries("judge", { checks: [{ id: "lint", at: "write.filed", mode: "observe" }] }), /write\.filed check gates writes/);
});
