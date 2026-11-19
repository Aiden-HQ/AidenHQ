import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUNDLE } from "./bundle.mjs";
import { ensureIdentityKeys } from "../identity.mjs";
import { checkEntries, compile, composeSecretFiles, ensureMountedSecrets, writeKinds, ensureOptionalSecrets, grantEntry, hostMounts, kernelModuleTable, LEGACY_HOST_ENV, LEGACY_LINKS, LEGACY_SECRETS, mapLimit, OPS_NETWORKS } from "../modules.mjs";

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
test("a remote source in the product's own marketplace is refused (third-party marketplaces hold those)", () =>
  assert.throws(() => compile(market((m) => ({ ...m, plugins: m.plugins.map((p) => (p.name === "b" ? { name: "b", source: { source: "github", repo: "acme/b", sha: "1".repeat(40) } } : p)) })), finst(["a"])), /a remote source belongs in a third-party marketplace/));
test("engines: two modules with one engine kind fail compile", () =>
  assert.throws(() => compile(mods, finst(["engdup"])), /two modules declare engine kind codex-openrouter: eng and engdup/));
test("engines: a runner agent on an engine no enabled module provides fails compile", () => {
  compile(mods, finst(["engrunner"]));
  assert.throws(() => compile(mods, finst(["engrunner"], base, { overrides: { agents: { coder: { engine: "nope" } } } })), /agent coder: unknown engine nope \(enabled: codex, codex-openrouter\)/);
});
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
  assert.deepEqual(compile(mods, finst(["roleopt"])).paperclip.agents.o.roles, [], "an optional role whose module is off is dropped");
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
  assert.deepEqual(grantEntry("x", r.agents.x, { r1: { agent: "x", model: "m3" }, r2: { agent: "y", model: "m4" } }), { name: "X", models: ["m2", "m3"], caps: { run_usd: 2, task_usd: 20, day_usd: 30 }, graded: false, profile: "crew", reports_to: "boss", engine: "codex-openrouter", model: "m2", max_parallel: 1, routines: { r1: { model: "m3" } } });
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
  const { PRIVILEGED } = await import("../compiler/services.ts");
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
  // A service shared through the gate (share.host) is reached only through it: another module may not join its network.
  add("docs", `services:\n  run:\n    srv: { ${img}, port: 3000, ui_port: 3141, share: { host: docs.example.com } }\n`);
  add("docs-reader", `requires: [docs]\nservices:\n  run:\n    srv: { ${img}, join: [docs] }\n`);
  assert.throws(() => compile(dir, finst(["docs", "docs-reader"])), /module docs-reader: docs-reader-srv joins docs, whose service is shared through the gate/);
  add("copycat", `services:\n  run:\n    a-mcp: { ${img} }\n`);
  assert.throws(() => compile(dir, finst(["a", "copycat"])), /module copycat: the service name a-mcp is already module a's/);
  add("boardy", `services:\n  run:\n    board: { ${img} }\n`);
  assert.throws(() => compile(dir, finst(["boardy"])), /module boardy: the service name board is already a root service's/);
});
test("legacy lists stay closed: links, root secrets and host variables may only shrink", () => {
  const was = {
    links: { "owner-channel": ["board", "paperclip", "sources"], monitoring: ["board"], tasks: ["backplane"], meetings: ["backplane", "sources"], google: ["board", "sources"], jira: ["board", "sources"], hubspot: ["board", "sources"], glean: ["board"], grafana: ["board"], clickhouse: ["board"], github: ["board", "sources"], primer: ["board"], slack: ["board"], security: ["paperclip", "sources"] },
    secrets: { "owner-channel": ["paperclip_board_key", "board_internal_token", "owner_decide_key"], tasks: ["board_internal_token"], google: ["google_auth_token", "gateway_source_key"], jira: ["gateway_source_key"], glean: ["glean_auth_token"], grafana: ["grafana_auth_token"], clickhouse: ["clickhouse_auth_token"], github: ["github_token"] },
    host: { "owner-channel": ["OWNER_SLACK_USER_ID", "SLACK_LIVE_IGNORE_CHANNELS", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_TASK_URL", "OWNER_COMMAND_CHANNEL", "AIDENHQ_GATEWAY_URL"], google: ["BOARD_LAN_URL", "GOOGLE_CALENDAR_ID", "AIDENHQ_GATEWAY_URL"], jira: ["AIDENHQ_GATEWAY_URL"], tasks: ["AIDENHQ_GATEWAY_URL"], github: ["GITHUB_COMMENT_ORGS"], slack: ["SLACK_CLIENT_ID"] },
  };
  // 2f split owner-channel into channel-telegram, channel-slack and chat-lane: each may keep only a part of what it had.
  const split = { "channel-telegram": "owner-channel", "chat-lane": "owner-channel", grading: "board-grades" };
  // The connections build merged channel-slack into slack: slack keeps what both had (the sign-in's board link, the writer's warehouse and Paperclip links); the owner is the paired one, so no host variable carries over.
  was.links.slack = ["board", "sources", "paperclip"];
  // 3h moved the grade rows out of the board into the grading module: its one link is the pair network to the board, for the
  // board's reads of those rows, until the board is a module (4a). No root secret, no host variable.
  // One-way phase 2: and a pair link to apps-mcp for the grader's app reads (role apps.read), until 4c.
  was.links["board-grades"] = ["board", "apps-mcp"];
  // The Fleet Steward service reads apps-mcp as a module holding apps.read (the detector moved out of the board).
  was.links["fleet-steward"] = ["apps-mcp"];
  const within = (now, before) => Object.entries(now).every(([m, l]) => l.every((x) => (before[m] ?? before[split[m]] ?? []).includes(x)));
  assert.ok(within(Object.fromEntries(Object.entries(LEGACY_LINKS).map(([m, v]) => [m, v.to])), was.links));
  assert.ok(within(LEGACY_SECRETS, was.secrets));
  assert.ok(within(LEGACY_HOST_ENV, was.host));
  assert.deepEqual(OPS_NETWORKS, { ci: "aidenhq-ci" });
});
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

test("kernel roles are the kernel's: no module declares one or a write kind's name, and requests only defined ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "prod-"));
  cpSync(join(here, "fixtures/mods"), dir, { recursive: true });
  const file = join(dir, "modules", "a", "module.yaml");
  const orig = readFileSync(file, "utf8");
  const roles = (r) => writeFileSync(file, `${orig}\nroles:\n${r}\n`);
  roles("  declares: [ kernel.apply ]");
  assert.throws(() => compile(dir, finst(["a"])), /declares role kernel\.apply, which is the kernel's namespace/);
  roles("  declares: [ github.merge ]");
  assert.doesNotThrow(() => compile(dir, finst(["a"])), "no module here has that kind");
  roles("  declares: [ kernel.raise_cap ]");
  assert.throws(() => compile(dir, finst(["a"])), /declares role kernel\.raise_cap/);
  roles("  requests: [ kernel.anything ]");
  assert.throws(() => compile(dir, finst(["a"])), /requests role kernel\.anything, which the kernel doesn't define/);
  roles("  requests: [ kernel.apply ]");
  assert.doesNotThrow(() => compile(dir, finst(["a"])));
});
// ------------------------------------------------------------------ the real modules
const repo = join(here, "../..");

test("the intake agents' Slack read grant has no draft tool", () => {
  const dir = pinst(["open-loops", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", owner_email: "e@x", product_repo: "acme/aidenhq" });
  const r = compile(repo, dir);
  const scanners = Object.values(r.paperclip.agents).filter((a) => a.module === "open-loops" && a.department.id === "intake" && a.enabled_tools.slack?.includes("slack_read_thread"));
  assert.ok(scanners.length);
  for (const a of scanners) assert.ok(!a.enabled_tools.slack.includes("slack_send_message_draft"), a.name);
});

// The real product: nothing needs Slack; the owner channel is its own module.
const product = join(here, "../..");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" };
test("an instance written before the fleet-steward merge (coach, fleet-ops, librarian; no dispatch or owner-channel) compiles as it stands", () => {
  const old = BUNDLE.filter((n) => !["fleet-steward", "dispatch", "owner-channel"].includes(n));
  const r = compile(product, inst([...old, "coach", "fleet-ops", "librarian"], { product_repo: "acme/aidenhq", ...owner }));
  const enabled = enabledOf(r);
  for (const n of ["fleet-steward", "dispatch", "owner-channel"]) assert.ok(enabled.includes(n), n);
  for (const n of ["coach", "fleet-ops", "librarian"]) assert.ok(!enabled.includes(n), n);
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
  for (const k of ["primer_service_key", "telegram_service_key"]) assert.ok(g.includes(k), k);
  assert.ok(!g.includes("computer_launcher_token"));
});
test("autonomy: off by default, reaches the compiled config, a bad value fails; the reviewer key is generated, no decide key", () => {
  assert.equal(compile(product, pinst([], owner)).paperclip.autonomy, "off");
  assert.equal(compile(product, pinst([], { ...owner, autonomy: "tier0" })).paperclip.autonomy, "tier0");
  assert.throws(() => compile(product, pinst([], { ...owner, autonomy: "yes" })), /autonomy/);
  const generated = compile(product, pinst([], owner)).generatedSecrets;
  assert.ok(generated.includes("reviewer_key") && !generated.some((g) => /decide_key/.test(g)));
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
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([id, k]) => [id, k.floor])), { "apps-platform.deploy": 0, "apps-platform.run": 1, "apps-platform.restart": 0, "apps-platform.rollback": 0, "apps-platform.api_write": 0, "code-review.post": 1, "code-review.notice": 0, "hubspot.crm_write": 1, "primer.publish": 1, "primer.reply": 1, "slack.post": 1, "slack.memory": 1, "slack.bind": 0, "github.push": 0, "github.pr": 0, "github.merge": 0, "github.close": 0, "github.create_repo": 0 });
  assert.deepEqual(["primer.primer_create_document", "primer.primer_add_version", "primer.primer_reply_to_thread", "primer.primer_resolve_thread"].map((ct) => kindOf[ct]), ["primer.publish", "primer.publish", "primer.reply", "primer.reply"]);
  assert.equal(kindOf["slack_live.slack_post"], "slack.post");
  assert.equal(kindOf["slack_live.channel_memory"], "slack.memory");
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
test("a module's token holds the kernel roles and the enabled modules' declared roles it requests (whoami's roles)", () => {
  const t = kernelModuleTable({ apps: { roles: { declares: [{ id: "apps.read", description: "d" }] } }, grading: { roles: { requests: ["kernel.wake", "apps.read", "nobody.declares"] } } });
  assert.deepEqual(t.grading.roles, ["kernel.wake", "apps.read"]);
});
test("a channel's transport is a compose service (the kernel sends the channel's token there); credentials need a transport", () => {
  const ch = (channel) => ({ x: { privileged: ["speaks-as-owner"], providers: { channel }, generated_secrets: ["x_token"] } });
  assert.deepEqual(kernelModuleTable(ch({ transport: "http://telegram:8089/transport/send", credentials: true })).x.channel, { transport: "http://telegram:8089/transport/send", credentials: true });
  for (const t of ["http://127.0.0.1:8089/t", "http://localhost:8089/t", "http://169.254.169.254:80/t", "https://example.com:443/t"]) assert.throws(() => kernelModuleTable(ch({ transport: t })), /a compose service/, t);
  assert.throws(() => kernelModuleTable(ch({ credentials: true })), /credentials is true, on a channel with a transport/);
});

test("journeys: phases name declared facts; two modules may declare one journey only alike", () => {
  const pr = { name: "pr", label: "Pull requests", subject: "pr", phases: [{ name: "open", label: "Open", from: ["pr.opened"] }, { name: "review", label: "Review", from: ["record.filed"], where: { kind: ["acme.merge"] } }], end: ["pr.deployed"] };
  const host = (journeys) => ({ roles: { requests: ["kernel.facts"] }, facts: { "pr.opened": { subject: "pr" } }, journeys });
  assert.deepEqual(kernelModuleTable({ a: host([pr]), b: host([pr]) }).b.journeys, [pr]);
  assert.throws(() => kernelModuleTable({ a: host([{ ...pr, end: ["pr.landed"] }]) }), /journey pr: end names undeclared fact pr.landed/);
  assert.throws(() => kernelModuleTable({ a: host([{ ...pr, phases: [{ name: "open", label: "Open", from: ["pr.opened"], where: { kind: "x" } }] }]) }), /where maps data fields to lists/);
  assert.throws(() => kernelModuleTable({ a: host([pr]), b: host([{ ...pr, label: "PRs" }]) }), /journey pr differs from module a's/);
});
test("a codehost grant is taken literally: settings are refused, the kernel's @ names pass", async () => {
  const { kernelModuleTable } = await import("../modules.mjs");
  assert.throws(() => kernelModuleTable({ m: { codehost: { token: { repos: ["${settings.agents_org}/*"], perms: { contents: "read" } } } } }), /names no settings/);
  assert.deepEqual(kernelModuleTable({ m: { codehost: { token: { repos: ["@instance", "@agents/*"], perms: { contents: "write" } } } } }).m.codehost.token.repos, ["@instance", "@agents/*"]);
});
test("teams: any module agent becomes a team record over named members (template, then defaults, then member)", () => {
  const teams = { research: { template: "chief-of-staff.assistant", defaults: { max_parallel: 2, reasoning_effort: "high", handbook: "Cite every source." }, caps: { day_usd: 40 }, routing: { weights: { repo: 2 } },
    members: { kai: { name: "Kai", repos: ["acme/*"] }, mina: { name: "Mina", max_parallel: 1, model: "~deepseek/deepseek-flash-latest" } } } };
  const r = compile(product, pinst([], owner, { teams })).paperclip;
  const tpl = r.agents.assistant, kai = r.agents.kai, mina = r.agents.mina;
  assert.deepEqual(tpl.team, { name: "research", members: ["kai", "mina"], weights: { repo: 2, continuity: 1, load: 1 } });
  assert.equal(grantEntry("assistant", tpl, r.routines).caps.day_usd, 40); // the team's day cap, on its record
  assert.deepEqual([kai.name, kai.member_of, kai.repos, kai.max_parallel, kai.handbook_line, kai.module], ["Kai", "assistant", ["acme/*"], 2, "Cite every source.", "chief-of-staff"]);
  assert.deepEqual([mina.max_parallel, mina.model, mina.description], [1, "~deepseek/deepseek-flash-latest", tpl.description]);
  assert.equal(kai.reasoning_effort, "high"); // the board's typed change on the team record lands in teams.<t>.defaults
  assert.deepEqual(kai.enabled_tools, tpl.enabled_tools); // the template's grants, resolved for each member
  assert.deepEqual(grantEntry("kai", kai, r.routines).member_of, "assistant");
  const bad = (t, extra = {}) => () => compile(product, pinst([], owner, { teams: { research: { ...teams.research, ...t } }, ...extra }));
  assert.throws(bad({ template: "chief-of-staff.nobody" }), /isn't an enabled module agent/);
  assert.throws(bad({ members: { architect: { name: "Arch" } } }), /the key is already an agent's/);
  assert.throws(bad({ members: { kai: { name: "Kai" }, mina: { name: "Kai" } } }), /already called Kai/);
  assert.throws(bad({}, { overrides: { agents: { assistant: { max_parallel: 2 } } } }), /assistant is team research's record/);
});
