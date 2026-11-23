// Local modules (the instance's own agents) and the Architect: the role template compiles as a local module; a local module
// is a closed allowlist; the Architect can't change the fleet itself.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, copyFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, grantEntry, writeTools } from "../modules.ts";
import { handbookParts } from "../handbook.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const template = join(product, "modules/agent-builder/templates/pr-review-chaser");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq" }; // product_repo: source modules require the warehouse

/**
 * An instance with one local module per key, each holding that one agent: { key: { yaml (merged over the template's agent;
 * undefined drops a field), md, routines (replace the template's), manifest (merged over the module's top level) } }.
 */
function withAgents(folders, modules = [], settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, ...modules], settings: { ...owner, ...settings } }));
  const tpl = YAML.parse(readFileSync(join(template, "module.yaml"), "utf8"));
  for (const [key, { yaml = {}, md, routines, manifest = {} } = {}] of Object.entries(folders)) {
    mkdirSync(join(dir, "modules", key, "agents", key), { recursive: true });
    const def = { ...tpl.agents["pr-review-chaser"], ...yaml };
    for (const [k, v] of Object.entries(yaml)) if (v === undefined) delete def[k];
    const rs = routines ?? Object.fromEntries(Object.entries(tpl.routines).map(([k, r]) => [k.replace("pr-review-chaser", key), { ...r, agent: key }]));
    writeFileSync(join(dir, "modules", key, "module.yaml"), YAML.stringify({ name: key, description: "A test agent.", agents: { [key]: def }, routines: rs, ...manifest }));
    writeFileSync(join(dir, "modules", key, "agents", key, "AGENTS.md"), md ?? readFileSync(join(template, "agents/pr-review-chaser/AGENTS.md"), "utf8"));
  }
  return dir;
}
const writesOf = (r, a, conn) => a.enabled_tools[conn].filter((t) => r.paperclip.mcp_servers[conn].tools.write.includes(t));

test("the role template compiles as a local agent: its designed grants, its routine, tier local", () => {
  const r = compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"]));
  const a = r.paperclip.agents["review-chaser"];
  assert.equal(a.module, "review-chaser");
  assert.equal(a.tier, "local");
  assert.equal(a.reports_to, "chief-of-staff");
  assert.match(a.title, /^Chases pull requests/);
  assert.match(a.instructions, /modules\/review-chaser\/agents\/review-chaser\/AGENTS\.md$/);
  assert.deepEqual(a.roles, []);
  assert.deepEqual(writesOf(r, a, "slack"), ["slack_send_message_draft"]);
  assert.equal(r.paperclip.routines["review-chaser-sweep"].agent, "review-chaser");
  assert.equal(r.paperclip.routines["review-chaser-sweep"].schedules[0].timezone, "Europe/London");
  assert.equal(r.catalog.find((m) => m.name === "review-chaser").enabled, true);
});

test("local modules: every manifest key outside the allowlist fails", () => {
  for (const k of ["prompts", "default_grants", "connections", "roles", "writes", "settings", "contributes", "jobcaps", "check_jobs", "services", "apps", "privileged", "isolation", "skills"]) {
    assert.throws(() => compile(product, withAgents({ x: { manifest: { [k]: {} } } })), new RegExp(`local module x: ${k} isn't allowed`), k);
  }
  // Nor on one of its agents: roles, isolation, jobcaps, delegate_to and the like are new authority.
  assert.throws(() => compile(product, withAgents({ x: { yaml: { roles: ["fleet-admin"] } } })), /x: a local agent may not have roles/);
  for (const f of ["isolation", "jobcaps", "delegate_to", "engines", "trial_writes"]) assert.throws(() => compile(product, withAgents({ x: { yaml: { [f]: [] } } })), new RegExp(`agent x: unknown field ${f}`), f);
});

test("a local agent compiles like today's instance agent, with no trial", () => {
  const r = compile(product, withAgents({ x: {} }, [], { quiet_start: "on" }));
  assert.equal(r.paperclip.agents.x.tier, "local");
  assert.equal(r.paperclip.routines["x-sweep"].status, "active", "a local routine is active under quiet start");
  assert.equal(r.paperclip.routines["x-sweep"].tier, "local");
  assert.equal(r.paperclip.routines["daily-brief"].status, "paused", "a product module's schedule waits under quiet start");
  // A heartbeat the instance turned on runs: quiet start held it off until then.
  const hb = withAgents({}, [], { quiet_start: "on" });
  writeFileSync(join(hb, "instance.yaml"), YAML.stringify({ ...YAML.parse(readFileSync(join(hb, "instance.yaml"), "utf8")), overrides: { agents: { "chief-of-staff": { heartbeat: true } } } }));
  assert.equal(compile(product, hb).paperclip.routines["heartbeat-chief-of-staff"].status, "active");
  assert.throws(() => compile(product, withAgents({ x: { yaml: { trial: true } } })), /agent x: unknown field trial/);
  const sweep = (schedules) => ({ "x-sweep": { title: "Sweep", agent: "x", description: "Sweep, then close this task.", schedules } });
  assert.throws(() => compile(product, withAgents({ x: { routines: sweep([{ cron: "*/5 * * * *", label: "often" }]) } })), /routine x-sweep: a local routine runs at most hourly: its cron minute is one number 0-59 \(got \*\/5\)/);
  assert.throws(() => compile(product, withAgents({ x: { routines: sweep([{ cron: "0 9 * * *", label: "a" }, { cron: "0 13 * * *", label: "b" }]) } })), /routine x-sweep: a local routine has at most one schedule/);
  // Two schedules added by an override fail too: the check runs on the final routine.
  const dir = withAgents({ x: {} });
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ ...YAML.parse(readFileSync(join(dir, "instance.yaml"), "utf8")), overrides: { routines: { "x-sweep": { schedules: [{ cron: "0 9 * * *", label: "a" }, { cron: "5 13 * * *", label: "b" }] } } } }));
  assert.throws(() => compile(product, dir), /routine x-sweep: a local routine has at most one schedule/);
  // A routine names the agent it runs as, which may be any compiled agent (a routine carries no grants).
  assert.equal(compile(product, withAgents({ x: { routines: { "x-brief": { title: "Brief", agent: "chief-of-staff", description: "Brief, then close this task.", schedules: [{ cron: "15 8 * * *", label: "m" }] } } } })).paperclip.routines["x-brief"].agent, "chief-of-staff");
  assert.throws(() => compile(product, withAgents({ x: { routines: { "x-brief": { title: "Brief", schedules: [] } } } })), /routine x-brief: agent is required/);
  // Identity is module.yaml's: a handbook with frontmatter is refused; so is the old folder, and listing a local module.
  assert.throws(() => compile(product, withAgents({ x: { md: "---\nname: Evil\n---\n# X\n" } })), /x: a local agent's AGENTS.md has no frontmatter: identity is in module.yaml/);
  const old = withAgents({ x: {} });
  mkdirSync(join(old, "agents", "y"), { recursive: true });
  writeFileSync(join(old, "agents", "y", "agent.yaml"), "name: Y\n");
  assert.throws(() => compile(product, old), /agents\/y\/agent\.yaml: an owner-built agent is a local module now \(modules\/<name>\/module\.yaml \+ agents\/<key>\/AGENTS\.md\)/);
  assert.throws(() => compile(product, withAgents({ x: {} }, ["x"])), /x is a local module: enabled by its folder/);
  const rules = withAgents({ x: {} });
  mkdirSync(join(rules, "agents"));
  writeFileSync(join(rules, "agents", "x.md"), "More rules.\n");
  assert.throws(() => compile(product, rules), /x is a local agent: its rules are its own AGENTS.md/);
});

test("local agents are validated like module agents, and can't take a module agent's key", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { nope: "read" } } } })), /x: grant to nope, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ architect: {} })), /duplicate agent: architect/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { budget: 10 } } })), /agent x: budget is gone: one install limit/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { reports_to: "nobody" } } })), /x: reports_to nobody, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ x: { routines: { s: { title: "Prepare daily brief", agent: "x", schedules: [] } } } })), /duplicate routine title: Prepare daily brief/);
  // Webhooks and their secrets come from product modules only (a local routine could otherwise take another's secret).
  for (const f of ["webhook", "webhook_base", "secrets_prefix", "status"]) assert.throws(() => compile(product, withAgents({ x: { routines: { s: { title: "S", agent: "x", [f]: "apps_incident_webhook" } } } })), new RegExp(`routine s: ${f} isn't allowed`));
});

test("event routines compile and the lints hold", () => {
  const ev = (event, extra = {}) => ({ "x-watch": { title: "Watch", agent: "x", description: "Watch, then close this task.", event, ...extra } });
  const slack = { connection: "slack", resource: "C0ACME", filter: { kind: "message", contains: ["acme"] } };
  const github = { connection: "github", resource: "acme/widgets", filter: { kind: "issues.opened" } };
  const compiled = (routines, yaml, modules = ["github", "slack"]) => compile(product, withAgents({ x: { routines, ...(yaml ? { yaml } : {}) } }, modules)).paperclip;
  for (const e of [slack, github]) {
    const r = compiled(ev(e)).routines["x-watch"];
    assert.equal(r.concurrency, "always_enqueue");
    assert.match(r.description, /New events: batch \{\{batch\}\} \(\{\{count\}\}\)\. Read them with routine_events\(batch\)/);
  }
  const refuses = (routines, re, yaml, modules) => assert.throws(() => compiled(routines, yaml, modules), re);
  refuses(ev({ ...slack, filter: {} }), /routine x-watch: event\.filter is required/);
  refuses(ev({ ...slack, filter: { color: "red" } }), /event\.filter\.color isn't a filter key of slack/);
  refuses(ev(slack), /agent x holds none of slack's slack_read_channel/, { connections: { github: "read", paperclip_tasks: ["task_current"] } });
  refuses(ev(slack, { webhook: true }), /routine x-watch: webhook isn't allowed/);
  refuses(ev({ ...slack, resource: "*" }), /event\.resource: \* is for product modules/);
  refuses(ev(slack, { tools: ["x"] }), /routine x-watch: tools isn't allowed/);
  refuses(ev(slack, { schedules: [{ cron: "*/5 * * * *", label: "often" }] }), /cron minute is one number|never on a schedule/);
  refuses(ev(slack, { schedules: [{ cron: "5 * * * *", label: "hourly" }] }), /an event routine runs on its events, never on a schedule/);
  refuses(ev({ ...slack, filter: { contains: "acme" } }), /event\.filter\.contains is a list of words/);
  refuses(ev({ ...slack, filter: { bot: "no" } }), /event\.filter\.bot is true or false/);
  refuses(ev({ ...slack, connection: ["slack"] }), /event\.connection is a connection's name/);
  refuses({ "x-r": { title: "R", agent: "x", description: "Go.", schedules: [{ cron: "0 9 * *", label: "x" }] } }, /a cron of five fields/);
  refuses({ "x-r": { title: "R", agent: "x", description: "Go.", schedules: [{ cron: "0 99 * * *", label: "x" }] } }, /a cron of five fields/);
  refuses({ "x-r": { title: "Repeats: DEMO-1", agent: "x", description: "Go.", schedules: [{ cron: "0 9 * * *", label: "x" }] } }, /"Repeats: " is the board's/);
  refuses(ev(slack), /doesn't hold paperclip_tasks\.routine_events/, { connections: { slack: "read", paperclip_tasks: ["task_current"] }, profile: "engineer" });
  refuses(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-w${i}`, { title: `W${i}`, agent: "x", description: "Go.", event: slack }])), /an agent has at most 20 local routines/);
  // The bundle's slack-triage is a product event routine: no webhook, no secrets.
  const bundle = compile(product, withAgents({}, ["slack", "open-loops"])).paperclip;
  const r = bundle.routines["slack-triage"];
  assert.deepEqual([r.event.resource, r.concurrency, r.webhook, r.secrets_prefix], ["*", "always_enqueue", undefined, undefined]);
  assert.match(r.description, /routine_events\(batch\)/);
  assert.ok(bundle.agents[r.agent].enabled_tools.paperclip_tasks.includes("routine_events"), "its agent reads the batch");
});

test("the Architect: max effort, only its own role, no fleet tools, reads every source; it changes the fleet only by delegating", () => {
  const a = compile(product, withAgents({}, ["slack", "github"])).paperclip.agents.architect;
  assert.deepEqual([a.model, a.reasoning_effort], ["~deepseek/deepseek-flash-latest", "max"]);
  assert.deepEqual(a.roles, ["architect", "repo-checkout"]);
  assert.deepEqual(a.enabled_tools.owner_channel, ["notify"]);
  assert.deepEqual(a.enabled_tools.apps, ["app_list", "app_status", "app_logs", "app_view", "web_view", "warehouse_query"]); // research reads only: no deploys, and the request and role reads would refuse it anyway
  assert.ok(a.enabled_tools.slack.includes("slack_read_thread") && !a.enabled_tools.slack.some((t) => /send|draft/.test(t)));
  assert.ok(a.enabled_tools.github.includes("github_issue_read") && !a.enabled_tools.github.some((t) => /comment|create|update|review|rerun/.test(t)));
  for (const t of ["fleet_control", "fleet_status", "task_relay_owner_words", "task_update", "task_create"]) assert.ok(!a.enabled_tools.paperclip_tasks.includes(t), t);
});

test("the web for every crew agent: web_view and app_view granted (an agent may opt its search down); Engineers get their own grants and the task reads", () => {
  const dir = withAgents({ "review-chaser": { yaml: { web_search: "disabled" } } }, ["slack", "github", "open-loops", "meetings", "engineering", "primer"]);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "slack", "github", "open-loops", "meetings", "engineering", "primer"], settings: { ...owner, owner_email: "e@x", product_repo: "acme/aidenhq" } }));
  const r = compile(product, dir);
  const codex = Object.entries(r.paperclip.agents).filter(([, a]) => a.profile === "crew");
  assert.ok(codex.length >= 8);
  // Every codex agent can view apps; web_view goes to all but those with web search off (the email/Slack scouts).
  for (const [key, a] of codex) {
    assert.ok(a.enabled_tools.apps?.includes("app_view"), `${key} lacks app_view`);
    if (a.web_search !== "disabled") assert.ok(a.enabled_tools.apps?.includes("web_view"), `${key} lacks web_view`);
  }
  // The intake agents (Slack and email): untrusted text in, so no web out.
  const intake = Object.entries(r.paperclip.agents).filter(([, a]) => a.module === "open-loops" && a.department.id === "intake");
  assert.ok(intake.length);
  for (const [k, a] of intake) {
    assert.equal(a.web_search, "disabled", k);
    assert.ok(!a.enabled_tools.apps?.includes("web_view"), k);
    // Reads only, plus the owner's page and its own tasks: no tool a connection tags write that reaches anyone else.
    const writes = Object.entries(a.enabled_tools).flatMap(([c, list]) => list.filter((t) => c !== "paperclip_tasks" && t !== "notify" && writeTools(r.paperclip.mcp_servers[c]).includes(t)).map((t) => `${c}.${t}`));
    assert.deepEqual(writes, [], k);
  }
  // An Engineer has what it grants itself (attaching its own task's file, reading its own approval cards, finishing it,
  // recording its wait) and the tasks module's reads.
  assert.deepEqual(r.paperclip.agents.engineer.enabled_tools, { apps: ["app_list", "app_status", "app_view", "app_check", "web_view"], github: ["github_whoami", "github_project_read", "github_issue_read", "github_search_issues", "github_job_log", "github_pr_files", "github_product_issue_status", "github_pr_threads", "github_pr_thread_reply"], code_review: ["code_review_findings", "code_review_resolve"], paperclip_tasks: ["task_file_upload", "task_finish", "task_wait", "task_approvals", "task_get", "task_search"] });
  assert.equal(r.paperclip.agents["review-chaser"].web_search, "disabled");
  assert.equal(r.paperclip.agents.assistant.web_search, undefined);
});

test("the Fleet Steward's grants: reads, its predecessors' writes and settling stuck tasks; no public GitHub write and no web", () => {
  // Roster merge 5.3 (Fleet Ops, Agent Coach, Librarian). It reads every agent's evidence (fleet-audit), so it must never
  // gain a write that reaches outside the fleet: product bugs go to the Maintainer. Inside the fleet it settles stuck work
  // (fleet-settle: task_route, and task_finish/task_cancel on any agent's task) and ends its own part of the owner's task
  // with task_handoff (WOR-10233). An edit that widens this fails here.
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github", "meetings", "grafana", "maintainer", "agent-builder"], settings: owner }));
  const r = compile(product, dir);
  const a = r.paperclip.agents["fleet-steward"];
  const writes = Object.entries(a.enabled_tools).flatMap(([c, list]) => list.filter((t) => writeTools(r.paperclip.mcp_servers[c]).includes(t)).map((t) => `${c}.${t}`)).sort();
  // routing_tune and routing_judge: the routing learning loop, each a reviewed kernel.apply of the instance's own routing.
  // fleet_operate: the operator's typed kernel.fleet_op (pause/resume, stop, restart, roll back; AI-reviewed); task_rebind: a
  // graded task's deliverable moved to the work that landed (owner, 2026-11-23: the Steward owns fleet operations).
  assert.deepEqual(writes, ["apps.person_identity_decide", "fleet_steward.fleet_operate", "fleet_steward.routing_judge", "fleet_steward.routing_tune", "ops_mcp.meeting_note_correct", "owner_channel.notify", "paperclip_tasks.coach_record", "paperclip_tasks.task_amend_rubric", "paperclip_tasks.task_block", "paperclip_tasks.task_cancel", "paperclip_tasks.task_comment", "paperclip_tasks.task_create", "paperclip_tasks.task_delegate", "paperclip_tasks.task_finish", "paperclip_tasks.task_handoff", "paperclip_tasks.task_rebind", "paperclip_tasks.task_route", "paperclip_tasks.task_wait"]);
  assert.deepEqual(a.enabled_tools.github, ["github_product_issue_status", "github_issue_link"]);
  assert.equal(a.web_search, "disabled");
  assert.ok(!a.enabled_tools.apps.includes("web_view"));
  // product-issues: the digest's live-fix check reads the product-bug issues' status (github_product_issue_status); filing is the Maintainer's.
  assert.deepEqual(a.roles, ["fleet-read", "fleet-settle", "fleet-audit", "librarian", "routing-tuner", "product-issues"]);
  assert.deepEqual(a.delegate_to, ["engineer", "app-maintainer", "app-owners", "architect", "maintainer", "chief-of-staff"]);
  assert.ok(r.paperclip.agents.maintainer.enabled_tools.github.includes("github_product_issue"), "the Maintainer files product bugs");
});

test("the own-part ending reaches only agents that hold task_handoff; every crew agent keeps the handoff and report-back guidance", () => {
  // The own-part section names an ending (`task_handoff`) an agent without the tool would be refused, so it goes only to
  // the agents granted it. The delegation and report-back guidance is every crew agent's, whatever its grant.
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "apps-platform"], settings: owner }));
  const r = compile(product, dir);
  const parts = (key) => handbookParts(r.paperclip, key, r.paperclip.agents[key], { repo: product, instanceDir: dir, fleetIssues: "WOR-0" });
  const own = (key) => parts(key).find(([id]) => id === "own-part")?.[1];
  assert.match(own("fleet-steward"), /Your part of the owner's task/);
  assert.ok(r.paperclip.agents["fleet-steward"].enabled_tools.paperclip_tasks.includes("task_handoff"));
  // app-maintainer is a crew agent with no task_handoff: it reads no ending it would be refused.
  assert.ok(!r.paperclip.agents["app-maintainer"].enabled_tools.paperclip_tasks.includes("task_handoff"));
  assert.equal(own("app-maintainer"), undefined);
  const handoff = parts("app-maintainer").find(([id]) => id === "handoff")?.[1] ?? "";
  assert.match(handoff, /Handing work on/);
  assert.match(handoff, /A report back/);
});
test("the security module's agents may hand a fix task to the Fleet Steward, and only to it", () => {
  // Security Watch and the Red Teamer file their fixes as tasks for the Fleet Steward, which routes them to the owner's
  // engineer (#815). Without the list `delegateIds` falls back to their reports and the Engineers, so the task_create with
  // `assignee: fleet-steward` is refused and the task lands on the owner's board. `fleet-steward?` resolves only when the
  // module is on, so an instance running security without it still compiles with an empty list.
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "warehouse", "security"], settings: owner }));
  const r = compile(product, dir);
  for (const key of ["security-watch", "red-teamer"]) assert.deepEqual(r.paperclip.agents[key].delegate_to, ["fleet-steward"], key);
  const without = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(without, "agents"));
  writeFileSync(join(without, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: BUNDLE.filter((n) => n !== "fleet-steward"), settings: owner }));
  const s = compile(product, without);
  for (const key of ["security-watch", "red-teamer"]) assert.deepEqual(s.paperclip.agents[key].delegate_to, [], `${key} without the Fleet Steward`);
});
test("the in-box `aidenhq task|tasks` reads are the tasks module's default grant: crew and Engineer yes; check no", () => {
  const reads = (yaml) => (compile(product, withAgents({ x: { yaml } }, ["slack"])).paperclip.agents.x.enabled_tools.paperclip_tasks ?? []).filter((t) => ["task_get", "task_search"].includes(t)).sort();
  const crew = { connections: { slack: "read" } };
  assert.deepEqual(reads(crew), ["task_get", "task_search"]);
  assert.deepEqual(reads({ ...crew, image: "agent-base" }), ["task_get", "task_search"]);
  assert.deepEqual(reads({ ...crew, profile: "check" }), [], "a check agent");
  assert.deepEqual(reads({ ...crew, profile: "engineer" }), ["task_get", "task_search"], "an Engineer");
});

test("a setting is the shape of its default: a string where a list is meant fails the compile", () => {
  const dir = withAgents({}, ["github"]);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github"], settings: { ...owner, github_orgs: "acme,evil" } }));
  assert.throws(() => compile(product, dir), /settings\.github_orgs: a list, like its default \(got a string\)/);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github"], settings: { ...owner, github_orgs: ["acme"] } }));
  assert.equal(compile(product, dir).paperclip ? "ok" : "", "ok");
});
