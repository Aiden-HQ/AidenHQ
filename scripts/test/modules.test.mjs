import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, ensureOptionalSecrets, grantEntry, hostMounts } from "../modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mods = join(here, "fixtures/mods");
const base = { timezone: "Europe/London", owner_email: "me@example.com" };

/** A throwaway instance dir: instance.yaml with these modules/settings/overrides, plus optional handbook additions. */
function inst(modules, settings = base, extra = {}, agents = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings, ...extra }));
  mkdirSync(join(dir, "agents"));
  for (const [k, v] of Object.entries(agents)) writeFileSync(join(dir, "agents", `${k}.md`), v);
  return dir;
}
const enabledOf = (r) => r.catalog.filter((m) => m.enabled).map((m) => m.name).sort();

test("requires pulls dependencies in", () => assert.deepEqual(enabledOf(compile(mods, inst(["a"]))), ["a", "b", "core"]));
test("missing module is an error", () => assert.throws(() => compile(mods, inst(["nope"])), /unknown module: nope/));
test("cycle is an error", () => assert.throws(() => compile(mods, inst(["cyc1"])), /module cycle: cyc1 → cyc2 → cyc1/));
test("duplicate agent key across modules", () => assert.throws(() => compile(mods, inst(["dup1", "dup2"])), /duplicate agent: x/));
test("grants resolve to tool lists: read, write, or a list", () => {
  const x = compile(mods, inst(["a"])).paperclip.agents.x;
  assert.deepEqual(x.mcp_servers, ["tasks", "bconn", "aconn"]);
  assert.deepEqual(x.enabled_tools, { tasks: ["t"], bconn: ["b_get"], aconn: ["a_get", "a_set"] });
  assert.deepEqual(x.roles, []);
  assert.equal(x.connections, undefined);
});
test("an optional grant (name?) is dropped when its module is off, kept when on", () => {
  assert.equal(compile(mods, inst(["a"])).paperclip.agents.x.enabled_tools.glean, undefined);
  assert.deepEqual(compile(mods, inst(["a", "glean"])).paperclip.agents.x.enabled_tools.glean, ["search"]);
});
test("a grant to a connection that isn't enabled fails compile", () =>
  assert.throws(() => compile(mods, inst(["needy"])), /n: grant to glean, which is not enabled/));
test("a granted tool the connection doesn't have fails compile", () =>
  assert.throws(() => compile(mods, inst(["badtool"])), /n: glean has no tool delete_everything/));
test("the old grant fields fail compile", () => assert.throws(() => compile(mods, inst(["oldstyle"])), /n: use connections:/));
test("roles: unknown ones, and ones a module may not grant, fail compile", () => {
  assert.throws(() => compile(mods, inst(["rolez"])), /r: unknown role helper/);
  assert.throws(() => compile(mods, inst(["roley"])), /r: module roley may not grant fleet-admin/);
});
test("an agent from an untrusted module gets no roles and no write grants", () =>
  assert.throws(() => compile(mods, inst(["wild"])), /w: an untrusted module's agent may not have tasks write tools \(t2\)/));
test("every connection tags its tools read or write", () => assert.throws(() => compile(mods, inst(["untagged"])), /connection u: tools\.read and tools\.write/));
test("HTTP connections send the run key; their service gets the grants table", () => {
  const r = compile(mods, inst(["a"]));
  assert.deepEqual(r.paperclip.mcp_servers.aconn.env_http_headers, { "X-Agent-Key": "PAPERCLIP_API_KEY" });
  assert.equal(r.paperclip.mcp_servers.tasks.env_http_headers, undefined);
  const s = r.compose.services["a-mcp"];
  assert.equal(s.environment.AIDENHQ_CONNECTION, "aconn");
  assert.equal(s.environment.AIDENHQ_GRANTS_FILE, "/grants/grants.json");
  assert.equal(s.environment.PAPERCLIP_URL, "http://paperclip:3100");
  assert.ok(s.volumes.includes("${AIDENHQ_CONFIG_DIR:-./config}/grants:/grants:ro"));
});
test("unset required setting", () => assert.throws(() => compile(mods, inst(["a"], { timezone: "UTC" })), /setting owner_email is required by a/));
test("unknown ${settings.x}", () => assert.throws(() => compile(mods, inst(["typo"])), /unknown setting: tz/));
test("settings substitute and {{date}} passes through", () => {
  const r = compile(mods, inst(["a"]));
  assert.equal(r.paperclip.routines.r.description, "Today is {{date}}; mail me@example.com");
  assert.equal(r.paperclip.routines.daily.schedules[0].timezone, "Europe/London");
  assert.equal(r.paperclip.company.name, "work");
});
test("overrides apply to allowed fields only", () => {
  assert.equal(compile(mods, inst(["a"], base, { overrides: { agents: { x: { model: "m2" } } } })).paperclip.agents.x.model, "m2");
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { x: { mcp_servers: [] } } } })), /override not allowed: agents\.x\.mcp_servers/);
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { nope: { model: "m" } } } })), /unknown agent: nope/);
  assert.deepEqual(compile(mods, inst([], base, { overrides: { routines: { daily: { status: "paused" } } } })).paperclip.routines.daily.status, "paused");
});
test("grants entry: models, fleet caps under the agent's override, graded off by default; a bad cap fails compile", () => {
  const r = compile(mods, inst(["a"], base, { overrides: { agents: { x: { model: "openrouter/m2", caps: { task_usd: 20 } } } } })).paperclip;
  assert.deepEqual(grantEntry("x", r.agents.x, { r1: { agent: "x", model: "m3" }, r2: { agent: "y", model: "m4" } }), { models: ["m2", "m3"], caps: { run_usd: 2, task_usd: 20, day_usd: 30 }, graded: false });
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { x: { caps: { month_usd: 5 } } } } })), /x: caps\.month_usd isn't a cap/);
});
test("reports_to a disabled agent is an error", () => assert.throws(() => compile(mods, inst(["orphan"])), /z: reports_to y, which is not enabled/));
test("untrusted app compiles to untrusted: true", () => {
  const [app] = compile(mods, inst(["appmod"])).apps.apps;
  assert.equal(app.untrusted, true); assert.equal(app.isolation, undefined); assert.equal(app.module, "appmod");
  assert.equal(app.path, "modules/appmod/apps/web");
});
test("untrusted module may not ship connections", () => assert.throws(() => compile(mods, inst(["shady"])), /untrusted module shady may not declare connections/));
test("bearer connections add their token secret to paperclip", () => {
  assert.deepEqual(compile(mods, inst(["a"])).compose.services.paperclip, { secrets: ["a_mcp_token"] });
});
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
  const dir = inst(["appmod"]);
  writeFileSync(join(dir, "apps.yaml"), "apps:\n  - { name: web, repo: o/x, owner: a, description: d }\n");
  assert.throws(() => compile(mods, dir), /app web is already in the instance apps.yaml; rename that app before enabling appmod/);
});

// ------------------------------------------------------------------ the real modules
const repo = join(here, "../..");

test("disabling open-loops removes its agents, routines and labels only", () => {
  const dir = inst(["meetings", "engineering", "warehouse", "github", "glean", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", product_repo: "acme/aidenhq", owner_email: "o@x" });
  const r = compile(repo, dir);
  for (const k of ["open-loops", "slack-triage", "slack-scout", "inbox-agent"]) assert.equal(r.paperclip.agents[k], undefined);
  for (const k of ["chief-of-staff", "assistant", "app-maintainer", "fleet-engineer", "meeting-librarian"]) assert.ok(r.paperclip.agents[k], k);
  assert.ok(!r.paperclip.labels.some((l) => l.name === "waiting-on"));
  assert.ok(r.paperclip.mcp_servers.slack_live, "owner channel stays: core requires it");
});
test("Slack Scout's read grant has no draft tool", () => {
  const dir = inst(["open-loops", "primer"], { timezone: "Europe/London", owner_name: "Sam", owner_slack_user_id: "U1", owner_email: "e@x" });
  const r = compile(repo, dir);
  assert.ok(r.paperclip.agents["slack-scout"].enabled_tools.slack.includes("slack_read_thread"));
  assert.ok(!r.paperclip.agents["slack-scout"].enabled_tools.slack.includes("slack_send_message_draft"));
});
test("module apps are pinned to the product revision", () => {
  const rev = "e".repeat(40);
  assert.equal(compile(mods, inst(["appmod"]), { revision: rev }).apps.apps[0].pin, rev);
  assert.equal(compile(mods, inst(["appmod"])).apps.apps[0].pin, undefined);
});

// The real product: core no longer needs Slack; the owner channel is its own module.
const product = join(here, "../..");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" };
test("core compiles without the slack module", () => {
  const r = compile(product, inst(["core"], owner));
  assert.equal(r.compose.services["slack-mcp"], undefined);
  assert.ok(r.compose.services["slack-live-mcp"]);
  assert.ok(r.paperclip.mcp_servers.slack_live);
  assert.ok(r.compose.secrets.telegram_notify_bot_token, "owner-channel declares its secrets");
  assert.deepEqual(r.compose.services.whisper.networks, ["backplane", "egress"]);
});
test("channels must be web, telegram or slack, and not empty", () => {
  assert.throws(() => compile(product, inst(["core"], { ...owner, channels: ["web", "fax"] })), /settings\.channels: each must be web, telegram or slack/);
  assert.throws(() => compile(product, inst(["core"], { ...owner, channels: [] })), /settings\.channels: at least one/);
});

test("optional secrets are created only where the secrets dir is really there (never into a locked vault's bare mountpoint)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sec-"));
  assert.deepEqual(ensureOptionalSecrets(dir, ["telegram_notify_bot_token"], "slack_live_mcp_token"), [], "no known secret yet: looks like an unmounted vault");
  writeFileSync(join(dir, "slack_live_mcp_token"), "x");
  assert.deepEqual(ensureOptionalSecrets(dir, ["telegram_notify_bot_token"], "slack_live_mcp_token"), ["telegram_notify_bot_token"]);
  assert.equal(readFileSync(join(dir, "telegram_notify_bot_token"), "utf8"), "");
  assert.deepEqual(ensureOptionalSecrets(dir, ["primer_mcp_publish_token"], "slack_live_mcp_token", true), ["primer_mcp_publish_token"]);
  assert.match(readFileSync(join(dir, "primer_mcp_publish_token"), "utf8"), /^[0-9a-f]{64}$/);
});
test("secrets the setup must not leave to a manual step are generated", () => {
  const g = compile(product, inst(["core", "primer"], owner)).generatedSecrets;
  for (const k of ["primer_mcp_publish_token", "owner_decide_key", "computer_launcher_token"]) assert.ok(g.includes(k), k);
});
test("autonomy: off by default, reaches the compiled config, a bad value fails; the reviewer and watcher keys are generated", () => {
  assert.equal(compile(product, inst(["core"], owner)).paperclip.autonomy, "off");
  assert.equal(compile(product, inst(["core"], { ...owner, autonomy: "tier0" })).paperclip.autonomy, "tier0");
  assert.throws(() => compile(product, inst(["core"], { ...owner, autonomy: "yes" })), /autonomy/);
  const generated = compile(product, inst(["core"], owner)).generatedSecrets;
  assert.ok(generated.includes("reviewer_key") && generated.includes("watcher_decide_key"));
});

test("two modules extending the same service merge environment and secrets", () => {
  const board = compile(mods, inst(["ext1", "ext2"])).compose.services.board;
  assert.deepEqual(board.environment, { A: "1", B: "2" });
  assert.deepEqual(board.secrets, ["s1", "s2"]);
});
