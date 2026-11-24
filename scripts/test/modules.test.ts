import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { BUNDLE } from "./bundle.ts";
import { ensureIdentityKeys } from "../identity.ts";
import { productsOf } from "../modules.ts";
import { checkEntries, checkJobs, codeReviewGated, compile, composeSecretFiles, ensureMountedSecrets, writeKinds, ensureOptionalSecrets, grantEntry, hostMounts, kernelModuleTable, LEGACY_HOST_ENV, LEGACY_LINKS, LEGACY_SECRETS, mapLimit, OPS_NETWORKS } from "../modules.ts";

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
test("an official module's setting without a comment above it fails compile; the comment is its doc", () => {
  const add = (settings) => {
    const dir = market((m) => ({ ...m, plugins: [...m.plugins, { name: "doc", source: "./doc" }] }));
    mkdirSync(join(dir, "modules", "doc"));
    writeFileSync(join(dir, "modules", "doc", "module.yaml"), `name: doc\ndescription: d\nsettings:\n${settings}`);
    return dir;
  };
  assert.throws(() => compile(add("  host: { default: x }\n"), finst(["doc"])), /module doc: settings host need a comment above them/);
  const out = compile(add("  # Where it listens.\n  host: { default: x, pattern: '^[a-z]+$' }\n"), finst(["doc"]));
  assert.deepEqual(out.catalog.find((m) => m.name === "doc").settings.host, { default: "x", pattern: "^[a-z]+$", doc: "Where it listens." });
});
test("a list setting's entries are checked against its pattern: a map entry is refused unless the setting names its `entry` field", () => {
  const add = (settings) => {
    const dir = market((m) => ({ ...m, plugins: [...m.plugins, { name: "doc", source: "./doc" }] }));
    mkdirSync(join(dir, "modules", "doc"));
    writeFileSync(join(dir, "modules", "doc", "module.yaml"), `name: doc\ndescription: d\nsettings:\n${settings}`);
    return dir;
  };
  const list = "  # The repos to skip.\n  skip: { default: [], pattern: '^[\\w.-]+/[\\w.-]+$' }\n";
  // A map entry would reach the service as JSON its reader takes for comma-joined text: it falls back to the empty default.
  assert.deepEqual(compile(add(list), finst(["doc"], { ...base, skip: ["acme/app", { repo: "acme/probe" }] })).warnings, ["settings.skip: {\"repo\":\"acme/probe\"} doesn't match ^[\\w.-]+/[\\w.-]+$; using the default until it is fixed"]);
  assert.deepEqual(compile(add(list), finst(["doc"], { ...base, skip: ["acme/app", "acme/probe"] })).warnings, []);
  // A setting whose entries are maps says which field holds the owner/name (maintainer_repos's `repo`).
  const dir = add("  # The repos to skip.\n  skip:\n    default: []\n    entry: repo\n    pattern: '^[\\w.-]+/[\\w.-]+$'\n");
  assert.deepEqual(compile(dir, finst(["doc"], { ...base, skip: [{ repo: "acme/probe" }] })).warnings, []);
  assert.deepEqual(compile(dir, finst(["doc"], { ...base, skip: [{ repo: { name: "acme/probe" } }] })).warnings, ["settings.skip: {\"repo\":{\"name\":\"acme/probe\"}} doesn't match ^[\\w.-]+/[\\w.-]+$; using the default until it is fixed"]);
});
test("a validate hook is compiled for the module's own service only: another module's service, an IP or localhost is refused", () => {
  const def = (post) => ({ secrets: { provided: ["acme_key"] }, services: { run: { hook: {} } }, validate: { post, auth: "acme_key" } });
  assert.deepEqual(checkEntries("acme", def("http://hook:8080/validate"))["acme.validate"], { module: "acme", at: "validate", url: "http://hook:8080/validate", auth_secret: "acme_key" });
  for (const post of ["http://other-mcp:8080/validate", "http://10.0.0.5:8080/validate", "http://localhost:8080/validate"]) assert.throws(() => checkEntries("acme", def(post)), /post must be one of the module's own services/);
});
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
// `upstream: off` is one rule for every grant path: an agent's own list, a shorthand, and a module's `default_grants:`. The
// default-grant loop runs after the connection loop, so without the same gate it put back the upstream tool that the opt-out
// had stripped (WOR-6794).
test("upstream: off strips an upstream tool a default grant names too, and a connection's other tools stay", () => {
  const grants = (settings) => Object.fromEntries(Object.entries(compile(mods, finst(["up"], { ...base, ...settings })).paperclip.agents).map(([k, a]) => [k, a.enabled_tools]));
  const off = grants({ upstream: "off" });
  for (const [key, tools] of Object.entries(off)) for (const t of Object.values(tools)) assert.ok(!["up_status", "up_file"].includes(t), `${key} still has an upstream tool`);
  assert.deepEqual(off.user, { upconn: ["up_get"] }, "the agent's own grant loses the upstream read, and keeps the rest");
  assert.deepEqual(off.boss, { tasks: ["t"] }, "a default grant that names only an upstream tool adds no connection at all");
  // The same fixture with the setting on: the default grant and the agent's own list both resolve, so the assertion above
  // is about the setting, not about a fixture that never granted them.
  const on = grants({ upstream: "issues" });
  assert.deepEqual(on.boss, { tasks: ["t"], upconn: ["up_file"] });
  assert.deepEqual(on.user, { upconn: ["up_get", "up_file"] });
  assert.deepEqual(on.status, { upconn: ["up_get", "up_status", "up_file"] });
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
test("slack-live gets the instance's own name and the owner's, so a new Slack app is named per instance", () => {
  const env = (settings: any) => compile(product, pinst([], { ...owner, ...settings })).compose.services["slack-live"].environment;
  assert.deepEqual([env({ instance_name: "acme" }).INSTANCE_NAME, env({ instance_name: "acme" }).OWNER_NAME], ["acme", "Sam"]);
  // instance_name is optional: unset, it is the empty string and the service falls back to the owner's name.
  assert.deepEqual([env({}).INSTANCE_NAME, env({}).OWNER_NAME], ["", "Sam"]);
});
test("overrides apply to allowed fields only", () => {
  assert.equal(compile(mods, finst(["a"], base, { overrides: { agents: { x: { model: "m2" } } } })).paperclip.agents.x.model, "m2");
  assert.equal(compile(mods, finst(["a"], base, { overrides: { agents: { x: { max_parallel: 4 } } } })).paperclip.agents.x.max_parallel, 4);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { max_parallel: 0 } } } })), /max_parallel must be 1 to 10/);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { mcp_servers: [] } } } })), /override not allowed: agents\.x\.mcp_servers/);
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { nope: { model: "m" } } } })), /unknown agent: nope/);
  // A routine's status is Paperclip's after setup creates it: the live controls pause and resume it, never an override.
  assert.throws(() => compile(mods, finst([], base, { overrides: { routines: { daily: { status: "paused" } } } })), /override not allowed: routines\.daily\.status/);
});
test("grants entry: models, graded off by default; a removed spend key fails compile naming the replacement", () => {
  const r = compile(mods, finst(["a"], base, { overrides: { agents: { x: { model: "openrouter/m2" } } } })).paperclip;
  assert.deepEqual(grantEntry("x", r.agents.x, { r1: { agent: "x", model: "m3" }, r2: { agent: "y", model: "m4" } }), { name: "X", models: ["m2", "m3"], graded: false, profile: "crew", reports_to: "boss", engine: "codex-openrouter", model: "m2", max_parallel: 1, routines: { r1: { model: "m3" } } });
  assert.throws(() => compile(mods, finst(["a"], base, { overrides: { agents: { x: { caps: { day_usd: 5 } } } } })), /overrides\.agents\.x\.caps is gone: one install limit, spend_day_usd \/ spend_month_usd/);
  assert.throws(() => compile(mods, finst(["a"], { ...base, eval_day_usd: 5 })), /settings\.eval_day_usd is gone/);
  assert.throws(() => compile(mods, finst(["a"], { ...base, code_review: { repos: [{ repo: "a/b", on_open: [{ engine: "codex", model: "m", effort: "low", run_usd: 5 }] }] } })), /code_review\.repos\.0\.on_open: run_usd is gone/);
});
test("jobcaps: compiled for the gateway, carried in the grants entry; unknown fails", () => {
  const out = compile(mods, finst(["jc"]));
  assert.deepEqual(out.jobcaps["jc-read"], { connection: "jconn", url: "http://j-mcp:81/mcp/read", bearer_secret: "j_mcp_read_token", tools: ["j_get", "j_list"] });
  assert.equal(out.jobcaps["jc-secret"].tool_timeout_s, 90);
  assert.deepEqual(grantEntry("eng", out.paperclip.agents.eng).jobcaps, ["jc-read"]); // nope-read? is optional
  assert.deepEqual(out.paperclip.agents.deep.jobcaps, ["jc-read", "jc-secret"]);
  assert.throws(() => compile(mods, finst(["jcunknown"])), /lost: unknown jobcap nope-read/);
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
    host: { "owner-channel": ["OWNER_SLACK_USER_ID", "SLACK_LIVE_IGNORE_CHANNELS", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_TASK_URL", "OWNER_COMMAND_CHANNEL", "AIDENHQ_GATEWAY_URL"], google: ["BOARD_LAN_URL", "GOOGLE_CALENDAR_ID", "AIDENHQ_GATEWAY_URL"], jira: ["AIDENHQ_GATEWAY_URL"], tasks: ["AIDENHQ_GATEWAY_URL"], slack: ["SLACK_CLIENT_ID"] },
  };
  // 2f split owner-channel into channel-telegram, channel-slack and chat-lane: each may keep only a part of what it had.
  const split = { "channel-telegram": "owner-channel", "chat-lane": "owner-channel", grading: "board-grades" };
  // The connections build merged channel-slack into slack: slack keeps what both had (the sign-in's board link, the writer's warehouse link); the owner is the paired one, so no host variable carries over.
  was.links.slack = ["board", "sources"];
  // 3h moved the grade rows out of the board into the grading module: its one link is the pair network to the board, for the
  // board's reads of those rows, until the board is a module (4a). No root secret, no host variable.
  // One-way phase 2: and a pair link to apps-mcp for the grader's app reads (role apps.read), until 4c.
  was.links["board-grades"] = ["board", "apps-mcp"];
  // The Fleet Steward service reads apps-mcp as a module holding apps.read (the detector moved out of the board).
  was.links["fleet-steward"] = ["apps-mcp"];
  // Task search left the kernel for the warehouse module (2026-11-23): its service writes src_tasks and calls the model
  // gateway as a source writer, the same link and key as every other writer until 3g.
  was.links.warehouse = ["sources"];
  was.secrets.warehouse = ["gateway_source_key"];
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
  roles("  declares: [ kernel.something ]");
  assert.throws(() => compile(dir, finst(["a"])), /declares role kernel\.something, which is the kernel.s namespace/);
  roles("  requests: [ kernel.anything ]");
  assert.throws(() => compile(dir, finst(["a"])), /requests role kernel\.anything, which the kernel doesn't define/);
  roles("  requests: [ kernel.apply ]");
  assert.doesNotThrow(() => compile(dir, finst(["a"])));
});
// ------------------------------------------------------------------ the real modules
const repo = join(here, "../..");

test("the intake agents' Slack read grant has no draft tool", () => {
  const dir = pinst(["open-loops", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_email: "e@x", product_repo: "acme/aidenhq" });
  const r = compile(repo, dir);
  const scanners = Object.values(r.paperclip.agents).filter((a) => a.module === "open-loops" && a.department.id === "intake" && a.enabled_tools.slack?.includes("slack_read_thread"));
  assert.ok(scanners.length);
  for (const a of scanners) assert.ok(!a.enabled_tools.slack.includes("slack_send_message_draft"), a.name);
});

// The real product: nothing needs Slack; the owner channel is its own module.
const product = join(here, "../..");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" };
test("upstream: off leaves every agent without an upstream tool; with issues only the chief of staff resolves them", () => {
  const agents = (upstream) => compile(product, pinst([], { ...owner, upstream })).paperclip.agents;
  const granted = (r, tool) => Object.entries(r).filter(([, a]) => (a.enabled_tools.github ?? []).includes(tool)).map(([k]) => k).sort();
  // What a call resolves to: github-mcp refuses a product issue to a caller without the product-issues role whatever its grant
  // says (modules/github/connections/github-mcp/src/projects.ts productTarget), and the chief of staff is that role's holder
  // (modules/chief-of-staff/module.yaml); the Fleet Steward holds it too, for the digest's live-fix check (modules/fleet-steward/module.yaml).
  const resolves = (r, tool) => granted(r, tool).filter((key) => r[key].roles.includes("product-issues"));
  const on = agents("issues");
  assert.deepEqual(on["chief-of-staff"].enabled_tools.github.filter((t) => t.startsWith("github_product_issue")), ["github_product_issue", "github_product_issue_status"]);
  // Filing is the destructive write no shorthand reaches, so no other agent even holds it.
  assert.deepEqual(granted(on, "github_product_issue"), ["chief-of-staff"]);
  // The status read is a plain read `github: read` also reaches; every other holder lacks the role, so only the chief of staff
  // files and, with the Fleet Steward, reads status.
  assert.deepEqual(resolves(on, "github_product_issue"), ["chief-of-staff"]);
  assert.deepEqual(resolves(on, "github_product_issue_status"), ["chief-of-staff", "fleet-steward"]);
  // `off` strips both from every agent however they were granted: an own list, a read shorthand, a default grant.
  const off = agents("off");
  for (const tool of ["github_product_issue", "github_product_issue_status"]) assert.deepEqual(granted(off, tool), [], tool);
});

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

test("enumeration (spec §9): every shipped write or destructive tool maps to a kind or to conn.tool, each tool to at most one kind", () => {
  const product = join(here, "../..");
  const kinds = {};
  const writes = [];
  const names = JSON.parse(readFileSync(join(product, "modules/marketplace.json"), "utf8")).plugins.map((p) => p.name);
  for (const name of names) {
    const root = join(product, "modules", name);
    const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));
    Object.assign(kinds, writeKinds(name, def, root, {}, kinds, names));
    for (const [c, x] of Object.entries(def.connections ?? {})) writes.push(...x.tools.write.map((t) => [`${c}.${t}`, 0]), ...(x.tools.destructive ?? []).map((t) => [`${c}.${t}`, 1]));
  }
  const routed = Object.fromEntries(Object.entries(kinds).flatMap(([id, k]) => k.tools.map((ct) => [ct, id])));
  // Every routed tool is a write or destructive tool of its own module; the rest are conn.tool records (floor 0, destructive 1).
  for (const ct of Object.keys(routed)) assert.ok(writes.some(([w]) => w === ct), `${ct} is routed but is no write tool`);
  const kindOf = Object.fromEntries(writes.map(([ct, floor]) => [ct, routed[ct] ?? `conn.tool@${floor}`]));
  assert.deepEqual(["apps.app_deploy", "apps.app_run_request", "apps.app_restart", "apps.app_rollback", "apps.app_api", "apps.app_remove", "apps.app_create"].map((ct) => kindOf[ct]),
    ["apps-platform.deploy", "apps-platform.run", "apps-platform.restart", "apps-platform.rollback", "apps-platform.api_write", "conn.tool@1", "conn.tool@0"]);
  assert.deepEqual(Object.fromEntries(Object.entries(kinds).map(([id, k]) => [id, k.floor])), { "apps-platform.deploy": 0, "apps-platform.run": 1, "apps-platform.restart": 0, "apps-platform.rollback": 0, "apps-platform.api_write": 0, "code-review.post": 0, "code-review.notice": 0, "code-review.reply": 0, "code-review.status": 0, "hubspot.crm_write": 1, "primer.publish": 1, "primer.reply": 1, "slack.post": 1, "slack.memory": 1, "slack.bind": 0, "github.push": 0, "github.pr": 0, "github.merge": 0, "github.close": 0, "github.create_repo": 0, "github.setup": 1, "github.publish_module": 2, "github.approve": 0, "github.enqueue": 0, "github.repair": 0, "github.retarget": 0 });
  assert.deepEqual(["primer.primer_create_document", "primer.primer_add_version", "primer.primer_reply_to_thread", "primer.primer_resolve_thread"].map((ct) => kindOf[ct]), ["primer.publish", "primer.publish", "primer.reply", "primer.reply"]);
  assert.equal(kindOf["slack_live.slack_post"], "slack.post");
  assert.equal(kindOf["slack_live.channel_memory"], "slack.memory");
  // A kind naming a tool that isn't one of its module's writes, or one another kind took, fails compile.
  // filed_by names other modules that exist, never itself or the kernel.
  const withFiled = (filed_by) => ({ providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], writes: { k: { floor: 1, filed_by } } });
  assert.deepEqual(writeKinds("m", withFiled(["n"]), product, {}, {}, ["m", "n"])["m.k"].filed_by, ["n"]);
  for (const bad of [["m"], ["kernel"], ["ghost"], [], "n"]) assert.throws(() => writeKinds("m", withFiled(bad), product, {}, {}, ["m", "n"]), /filed_by lists other modules/);
  assert.throws(() => writeKinds("m", { providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], connections: { c: { tools: { read: ["r"], write: ["w"] } } }, writes: { k: { floor: 0, tools: ["r"] } } }, product), /r is no write or destructive tool/);
  assert.throws(() => writeKinds("m", { providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], connections: { c: { tools: { read: [], write: ["w"] } } }, writes: { k: { floor: 0, tools: ["w"] }, j: { floor: 1, tools: ["w"] } } }, product), /c\.w is already routed/);
  // binds: a head-bound kind names the target fields it acts on (repo, ref, commit), and nothing else; it compiles through.
  const def = { providers: { executor: { url: "http://m:1/x", auth: "m_service_key" } }, generated_secrets: ["m_service_key"], connections: { c: { tools: { read: [], write: ["w"] } } } };
  assert.deepEqual(writeKinds("m", { ...def, writes: { k: { floor: 1, binds: ["repo", "ref", "commit"], tools: ["w"] } } }, product)["m.k"].binds, ["repo", "ref", "commit"]);
  assert.throws(() => writeKinds("m", { ...def, writes: { k: { floor: 1, binds: ["head"], tools: ["w"] } } }, product), /binds is a list of target fields/);
  assert.throws(() => writeKinds("m", { ...def, writes: { k: { floor: 1, binds: [], tools: ["w"] } } }, product), /binds is a list of target fields/);
});

test("checks: a task.finish check may observe; a hard gate or a write.filed check may not", () => {
  const def = (c) => ({ secrets: { provided: ["k"] }, checks: [{ id: "finish", at: "task.finish", post: "http://m:1/check", auth: "k", ...c }] });
  assert.equal(checkEntries("judge", def({ mode: "observe" }))["judge.finish"].mode, "observe");
  assert.equal(checkEntries("judge", def({}))["judge.finish"].mode, undefined);
  assert.throws(() => checkEntries("judge", def({ mode: "warn" })), /mode is observe or enforce/);
  assert.throws(() => checkEntries("platform", { checks: [{ id: "product-gate", at: "write.filed", mode: "observe" }] }), /hard gate: it always enforces/);
  assert.throws(() => checkEntries("judge", { checks: [{ id: "lint", at: "write.filed", mode: "observe" }] }), /write\.filed check gates writes/);
  // A write.filed check reaches the kernel with its kinds (it runs in process there), and names at least one.
  assert.deepEqual(checkEntries("platform", { checks: [{ id: "product-gate", at: "write.filed", kinds: ["github.push"] }] }), { "platform.product-gate": { module: "platform", at: "write.filed", kinds: ["github.push"] } });
  assert.throws(() => checkEntries("platform", { checks: [{ id: "product-gate", at: "write.filed" }] }), /names the write kinds/);
});
test("a module's token holds the kernel roles and the enabled modules' declared roles it requests (whoami's roles)", () => {
  const t = kernelModuleTable({ apps: { roles: { declares: [{ id: "apps.read", description: "d" }] } }, grading: { roles: { requests: ["kernel.wake", "apps.read", "nobody.declares"] } } });
  assert.deepEqual(t.grading.roles, ["kernel.wake", "apps.read"]);
});
test("a module's display name for the kernel: its own sign-in's label, else its setup flow's title, else none", () => {
  const t = kernelModuleTable({
    github: { contributes: { "board.signins": [{ id: "github", label: "GitHub" }], "board.setup_flows": [{ title: "GitHub setup" }] } },
    google: { contributes: { "board.setup_flows": [{ title: "Google" }] } },
    plain: { roles: { requests: ["kernel.wake"] } },
  });
  assert.equal(t.github.label, "GitHub");
  assert.equal(t.google.label, "Google");
  assert.equal(t.plain.label, undefined);
});
test("a channel's transport is a compose service (the kernel sends the channel's token there); a credentials key is gone", () => {
  const ch = (channel) => ({ x: { privileged: ["speaks-as-owner"], providers: { channel }, generated_secrets: ["x_token"] } });
  assert.deepEqual(kernelModuleTable(ch({ transport: "http://telegram:8089/transport/send" })).x.channel, { transport: "http://telegram:8089/transport/send" });
  for (const t of ["http://127.0.0.1:8089/t", "http://localhost:8089/t", "http://169.254.169.254:80/t", "https://example.com:443/t"]) assert.throws(() => kernelModuleTable(ch({ transport: t })), /a compose service/, t);
  assert.throws(() => kernelModuleTable(ch({ credentials: true })), /providers.channel.credentials is not allowed/);
});

test("journeys: the end names declared facts, a phase any fact (absent when no module records it); two modules may declare one journey only alike", () => {
  const pr = { name: "pr", label: "Pull requests", subject: "pr", phases: [{ name: "open", label: "Open", from: ["pr.opened"] }, { name: "review", label: "Review", from: ["record.filed"], where: { kind: ["acme.merge"] } }], end: ["pr.deployed"] };
  const host = (journeys) => ({ roles: { requests: ["kernel.facts"] }, facts: { "pr.opened": { subject: "pr" } }, journeys });
  assert.deepEqual(kernelModuleTable({ a: host([pr]), b: host([pr]) }).b.journeys, [pr]);
  const work = { name: "work", label: "Work", subject: "task", phases: [{ name: "open", label: "PR open", from: ["pr.opened"] }], end: ["task.status_changed"], end_where: { to: ["done"] } };
  assert.deepEqual(kernelModuleTable({ tasks: { journeys: [work] } }).tasks.journeys, [work]);
  assert.throws(() => kernelModuleTable({ a: host([{ ...pr, end: ["pr.landed"] }]) }), /journey pr: end names undeclared fact pr.landed/);
  assert.throws(() => kernelModuleTable({ a: host([{ ...pr, phases: [{ name: "open", label: "Open", from: ["Opened"] }] }]) }), /names no fact Opened/);
  assert.throws(() => kernelModuleTable({ a: host([{ ...pr, phases: [{ name: "open", label: "Open", from: ["pr.opened"], where: { kind: "x" } }] }]) }), /where maps data fields to lists/);
  assert.throws(() => kernelModuleTable({ a: host([pr]), b: host([{ ...pr, label: "PRs" }]) }), /journey pr differs from module a's/);
});
test("a codehost grant is taken literally: settings are refused, the kernel's @ names pass", async () => {
  const { kernelModuleTable } = await import("../modules.ts");
  assert.throws(() => kernelModuleTable({ m: { codehost: { fetch: { repos: ["${settings.fleet_org}/*"] } } } }), /names no settings/);
  assert.deepEqual(kernelModuleTable({ m: { codehost: { fetch: { repos: ["@instance", "@agents/*"] } } } }).m.codehost.fetch.repos, ["@instance", "@agents/*"]);
  assert.throws(() => kernelModuleTable({ m: { codehost: { token: { repos: ["@instance"], perms: { contents: "read" } } } } }), /no field token/);
});
test("teams: any module agent becomes a team record over named members (template, then defaults, then member)", () => {
  const teams = { research: { template: "chief-of-staff.assistant", defaults: { max_parallel: 2, reasoning_effort: "high", handbook: "Cite every source." }, routing: { weights: { repo: 2 } },
    members: { kai: { name: "Kai", repos: ["acme/*"] }, mina: { name: "Mina", max_parallel: 1, model: "~deepseek/deepseek-flash-latest" } } } };
  const r = compile(product, pinst([], owner, { teams })).paperclip;
  const tpl = r.agents.assistant, kai = r.agents.kai, mina = r.agents.mina;
  assert.deepEqual(tpl.team, { name: "research", members: ["kai", "mina"], weights: { repo: 2, continuity: 1, load: 1 } });
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

test("code review gates a repo with a mandatory combo in on_open (on_push's optional); one only in on_push, or a repo-level flag, fails the compile", () => {
  const c = (mandatory?: boolean) => ({ engine: "codex", model: "~a/b", effort: "low", ...(mandatory ? { mandatory } : {}) });
  assert.deepEqual(codeReviewGated({ repos: [{ repo: "Acme/App", on_open: [c(true)], on_push: [c(), c(true)] }, { repo: "acme/lib" }] }), ["acme/app"]);
  assert.deepEqual(codeReviewGated({ repos: [{ repo: "acme/app", on_open: [c(true)], on_push: [] }] }), ["acme/app"], "on_push's mandatory combo is optional");
  assert.throws(() => codeReviewGated({ repos: [{ repo: "acme/app", on_open: [c()], on_push: [c(true)] }] }), /needs a mandatory on_open one/);
  assert.throws(() => codeReviewGated({ repos: [{ repo: "acme/app", mandatory: true }] }), /a repo's mandatory is gone/);
});

test("check job limits: a recipe may run 180 minutes; a recipe's own model cap is gone", () => {
  const job = (r) => ({ check_jobs: { big: { argv: ["node", "x.ts"], title: "big", spec: { budget_usd: "usd" }, timeout_min: 180, ...r } } });
  const root = mkdtempSync(join(tmpdir(), "cj-"));
  assert.equal(checkJobs("m", job({ model: true }), root).big.model, true);
  assert.equal(checkJobs("m", job({}), root).big.timeout_min, 180);
  assert.throws(() => checkJobs("m", job({ timeout_min: 181 }), root), /1 to 180/);
  assert.throws(() => checkJobs("m", job({ model: { max_usd: 100 } }), root), /spend cap is gone/);
  // the real code review module declares both profiles: the tools one with no model
  const real = checkJobs("code-review", YAML.parse(readFileSync(join(here, "../../modules/code-review/module.yaml"), "utf8")), join(here, "../../modules/code-review"));
  assert.equal(real["code-review"].model, true);
  assert.equal(real["code-review-tools"].model, undefined);
  assert.equal(real["code-review-tools"].result, true);
});

test("product names that differ only in case are refused", () => {
  assert.throws(() => productsOf({ Billing: ["acme/a"], billing: ["acme/b"] }), /differ only in case/);
  assert.deepEqual(productsOf({ Billing: ["acme/a"], Hiring: ["acme/b"] }), { Billing: ["acme/a"], Hiring: ["acme/b"] });
});

test("subscribes: compiled from settings into the kernel's module table, kinds checked, * only for product modules", () => {
  const gh = { connections: { github: { events: { kinds: ["pull_request.opened", "push"] } } } };
  const settings = { code_review: { repos: [{ repo: "Org/A" }, { repo: "org/b" }] }, maintainer_repos: ["org/c", { repo: "Org/D" }] };
  const t = kernelModuleTable({ github: gh, cr: { subscribes: { github: { kinds: ["pull_request.opened"], resources: { setting: "code_review", path: "repos[].repo" } } } }, mt: { subscribes: { github: { kinds: ["push"], resources: { setting: "maintainer_repos", path: "[].repo" } } } }, ship: { subscribes: { github: { kinds: ["push"], resources: "*" } } } }, settings, new Set(["ship"]));
  assert.deepEqual(t.cr.subscribes, { github: { kinds: ["pull_request.opened"], resources: ["org/a", "org/b"] } });
  assert.deepEqual(t.mt.subscribes, { github: { kinds: ["push"], resources: ["org/c", "org/d"] } });
  assert.deepEqual(t.ship.subscribes, { github: { kinds: ["push"], resources: "*" } });
  assert.throws(() => kernelModuleTable({ github: gh, x: { subscribes: { github: { kinds: ["push"], resources: "*" } } } }, {}), /product modules/);
  assert.throws(() => kernelModuleTable({ github: gh, x: { subscribes: { github: { kinds: ["status"], resources: [] } } } }, {}), /isn't one of github's events.kinds/);
  assert.throws(() => kernelModuleTable({ github: gh, x: { subscribes: { github: { kinds: ["push"], resources: ["org/a"] } } } }, {}), /"\*" or \{ setting, path \}/);
});
