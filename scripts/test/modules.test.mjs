import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, ensureOptionalSecrets, grantEntry, healthProbeAgent, hostMounts, mapLimit } from "../modules.mjs";

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
  assert.deepEqual(enabledOf(compile(dir, inst(["a"]))), ["a", "b", "core", "eng"]);
});
test("a module directory missing from the marketplace fails", () =>
  assert.throws(() => compile(market((m) => ({ ...m, plugins: m.plugins.filter((p) => p.name !== "b") })), inst(["a"])), /modules\/b is not in modules\/marketplace.json/));
test("a remote source fails until unit 5a", () =>
  assert.throws(() => compile(market((m) => ({ ...m, plugins: m.plugins.map((p) => (p.name === "b" ? { name: "b", source: { source: "github", repo: "acme/b" } } : p)) })), inst(["a"])), /remote sources/));
test("requires pulls dependencies in", () => assert.deepEqual(enabledOf(compile(mods, inst(["a"]))), ["a", "b", "core", "eng"]));
test("engines: the registry lists each kind's module, bin and data; crew args come from the engine module", () => {
  const out = compile(mods, inst([]));
  assert.deepEqual(Object.keys(out.engines).sort(), ["codex", "codex-openrouter"]);
  assert.deepEqual(out.engines["codex-openrouter"], { kind: "codex-openrouter", bin: "modules/eng/bin/engine", gateway: true, box: true, state: "task", seed: [{ from: "bin/engine", to: "x/engine" }], module: "eng", dir: "modules/eng", live_input: false });
  assert.deepEqual(out.paperclip.codex_args, ["--sandbox", "read-only"]);
});
test("engines: two modules with one engine kind fail compile", () =>
  assert.throws(() => compile(mods, inst(["engdup"])), /two modules declare engine kind codex-openrouter: eng and engdup/));
test("engines: a runner agent on an engine no enabled module provides fails compile", () => {
  compile(mods, inst(["engrunner"]));
  assert.throws(() => compile(mods, inst(["engrunner"], base, { overrides: { agents: { coder: { engine: "nope" } } } })), /agent coder: unknown engine nope \(enabled: codex, codex-openrouter\)/);
});
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
test("roles: unknown ones, and ones a module may not grant, fail compile", () => {
  assert.throws(() => compile(mods, inst(["rolez"])), /r: unknown role helper/);
  assert.throws(() => compile(mods, inst(["roley"])), /r: module roley may not grant fleet-admin/);
});
test("an agent from an untrusted module gets no roles and no write grants", () =>
  assert.throws(() => compile(mods, inst(["wild"])), /w: an untrusted module's agent may not have tasks write tools \(t2\)/));
test("every connection tags its tools read or write", () => assert.throws(() => compile(mods, inst(["untagged"])), /connection u: tools\.read and tools\.write/));
test("connections go through the kernel: no compiled service mounts grants; the kernel's table names each endpoint and key", () => {
  const r = compile(mods, inst(["a"]));
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
  assert.equal(compile(mods, inst(["a"], base, { overrides: { agents: { x: { max_parallel: 4 } } } })).paperclip.agents.x.max_parallel, 4);
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { x: { max_parallel: 0 } } } })), /max_parallel must be 1 to 10/);
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { x: { mcp_servers: [] } } } })), /override not allowed: agents\.x\.mcp_servers/);
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { nope: { model: "m" } } } })), /unknown agent: nope/);
  assert.deepEqual(compile(mods, inst([], base, { overrides: { routines: { daily: { status: "paused" } } } })).paperclip.routines.daily.status, "paused");
});
test("grants entry: models, fleet caps under the agent's override, graded off by default; a bad cap fails compile", () => {
  const r = compile(mods, inst(["a"], base, { overrides: { agents: { x: { model: "openrouter/m2", caps: { task_usd: 20 } } } } })).paperclip;
  assert.deepEqual(grantEntry("x", r.agents.x, { r1: { agent: "x", model: "m3" }, r2: { agent: "y", model: "m4" } }), { models: ["m2", "m3"], caps: { run_usd: 2, task_usd: 20, day_usd: 30 }, graded: false });
  assert.throws(() => compile(mods, inst(["a"], base, { overrides: { agents: { x: { caps: { month_usd: 5 } } } } })), /x: caps\.month_usd isn't a cap/);
});
test("jobcaps: compiled for the gateway, carried in the grants entry; unknown or private-without-private_reads fail", () => {
  const out = compile(mods, inst(["jc"]));
  assert.deepEqual(out.jobcaps["jc-read"], { connection: "jconn", url: "http://127.0.0.1:3199/mcp/read", bearer_secret: "j_mcp_read_token", tools: ["j_get", "j_list"] });
  assert.equal(out.jobcaps["jc-secret"].tool_timeout_s, 90);
  assert.deepEqual(grantEntry("eng", out.paperclip.agents.eng).jobcaps, ["jc-read"]); // nope-read? is optional
  assert.deepEqual(out.paperclip.agents.deep.jobcaps, ["jc-read", "jc-secret"]);
  assert.throws(() => compile(mods, inst(["jcunknown"])), /lost: unknown jobcap nope-read/);
  assert.throws(() => compile(mods, inst(["jcpriv"])), /nosy: jobcap jc-secret reads private data: set private_reads: true/);
});
test("reports_to a disabled agent is an error", () => assert.throws(() => compile(mods, inst(["orphan"])), /z: reports_to y, which is not enabled/));
test("untrusted app compiles to untrusted: true", () => {
  const [app] = compile(mods, inst(["appmod"])).apps.apps;
  assert.equal(app.untrusted, true); assert.equal(app.isolation, undefined); assert.equal(app.module, "appmod");
  assert.equal(app.path, "modules/appmod/apps/web");
});
test("untrusted module may not ship connections", () => assert.throws(() => compile(mods, inst(["shady"])), /untrusted module shady may not declare connections/));
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
test("destructive tools: `write` never grants them, a list must name them; compile refuses a delete-looking tool tagged write", () => {
  const { agents } = compile(mods, inst(["wiper"])).paperclip;
  assert.deepEqual(agents.w.enabled_tools.wconn, ["w_get", "w_set"]);
  assert.deepEqual(agents.wd.enabled_tools.wconn, ["w_get", "w_delete"]);
  assert.throws(() => compile(mods, inst(["sloppy"])), /deleteIssue looks destructive/);
});
test("routine autonomy: full by default, tier0 for a webhook routine unless it says otherwise; an override must be a known value", () => {
  const { routines } = compile(mods, inst(["wiper"])).paperclip;
  assert.deepEqual([routines.sweep.autonomy, routines.hook.autonomy, routines.hookfull.autonomy], ["full", "tier0", "full"]);
  assert.throws(() => compile(mods, inst(["wiper"], base, { overrides: { routines: { sweep: { autonomy: "yes" } } } })), /routine sweep: autonomy is off, tier0, full/);
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
