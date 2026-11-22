// Instance-defined agents and the Architect: the role template compiles in trial (tap 1) and graduated
// (tap 2); trial is enforced by compile; the Architect can't change the fleet itself.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, copyFileSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, grantEntry, TRIAL_WRITE_ALLOWED, writeTools } from "../modules.ts";
import { handbookParts } from "../handbook.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const template = join(product, "modules/agent-builder/templates/pr-review-chaser");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq" }; // product_repo: source modules require the warehouse

/** An instance with agents/<key>/ folders: { key: { yaml (merged over the template; undefined drops a field), md } }. */
function withAgents(folders, modules = []) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, ...modules], settings: owner }));
  mkdirSync(join(dir, "agents"));
  for (const [key, { yaml = {}, md } = {}] of Object.entries(folders)) {
    mkdirSync(join(dir, "agents", key));
    const def = { ...YAML.parse(readFileSync(join(template, "agent.yaml"), "utf8")), ...yaml };
    for (const [k, v] of Object.entries(yaml)) if (v === undefined) delete def[k];
    writeFileSync(join(dir, "agents", key, "agent.yaml"), YAML.stringify(def));
    writeFileSync(join(dir, "agents", key, "AGENTS.md"), md ?? readFileSync(join(template, "AGENTS.md"), "utf8"));
  }
  return dir;
}
const writesOf = (r, a, conn) => a.enabled_tools[conn].filter((t) => r.paperclip.mcp_servers[conn].tools.write.includes(t));

test("the role template compiles as an instance agent in trial (tap 1): read-only, reporting to the Architect", () => {
  const r = compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"]));
  const a = r.paperclip.agents["review-chaser"];
  assert.equal(a.module, "instance");
  assert.equal(a.trial, true);
  assert.equal(a.reports_to, "architect");
  assert.match(a.title, /^Chases pull requests/);
  assert.match(a.instructions, /agents\/review-chaser\/AGENTS\.md$/);
  assert.deepEqual(a.roles, []);
  assert.deepEqual(writesOf(r, a, "paperclip_tasks"), ["task_comment", "task_handoff", "task_finish", "task_block", "task_cancel"]);
  assert.deepEqual(writesOf(r, a, "slack"), []);
  assert.equal(r.paperclip.routines["review-chaser-sweep"].agent, "review-chaser");
  assert.equal(r.paperclip.routines["review-chaser-sweep"].schedules[0].timezone, "Europe/London");
});
test("an agent in trial gets no write tools and reports to the Architect", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { slack: "write" } } } }, ["slack"])), /x: an agent in trial may not have slack write tools/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { paperclip_tasks: ["task_create"] } } } })), /x: an agent in trial may not have paperclip_tasks write tools \(task_create\)/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { reports_to: "chief-of-staff", connections: {} } } })), /x: an agent in trial reports to architect/);
});
// Trial writes: an agent in trial may declare the owner-channel writes it keeps (as connection.tool), and only those.
const ariaWrites = ["paperclip_tasks.task_create", "chat_lane.wake_at", "chat_lane.chat_send"];
const ariaYaml = { connections: { slack: "read", paperclip_tasks: ["task_current", "task_comments", "task_comment", "task_finish", "task_create", "task_update"], chat_lane: ["wake_at", "chat_send"] }, trial_writes: ariaWrites };

test("trial_writes: an agent in trial compiles with the writes it names, and keeps exactly those writes", () => {
  const r = compile(product, withAgents({ x: { yaml: ariaYaml } }, ["slack"]));
  const a = r.paperclip.agents.x;
  assert.deepEqual(a.trial_writes, ariaWrites);
  assert.deepEqual(writesOf(r, a, "paperclip_tasks"), ["task_comment", "task_finish", "task_create"]);
  assert.deepEqual(writesOf(r, a, "chat_lane"), ["wake_at", "chat_send"]);
  // The tool it granted but didn't name is withheld: not offered to the agent, and named so the handbook check stays quiet.
  assert.deepEqual(a.trial_withheld, ["paperclip_tasks.task_update"]);
  // Its reads are untouched.
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_current"));
});

test("trial_writes: any other name is a compile error naming the agent and the tool", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: [...ariaWrites, "paperclip_tasks.task_update"] } } }, ["slack"])), /x: trial_writes names paperclip_tasks\.task_update, which it may not use in trial \(only paperclip_tasks\.task_create, chat_lane\.wake_at, chat_lane\.chat_send, owner_channel\.notify\)/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["chat_lane.slack_post"] } } }, ["slack"])), /x: trial_writes names chat_lane\.slack_post, which it may not use in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["slack.wake_at"] } } }, ["slack"])), /x: trial_writes names slack\.wake_at, which it may not use in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["task_create"] } } }, ["slack"])), /x: trial_writes names "task_create", not a tool written connection\.tool/);
});
test("trial_writes: an entry the definition does not grant is a compile error", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, connections: { ...ariaYaml.connections, chat_lane: ["wake_at"] } } } }, ["slack"])), /x: trial_writes names chat_lane\.chat_send, which the definition does not grant/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, connections: { paperclip_tasks: ["task_comment"], slack: "read" } } } }, ["slack"])), /x: trial_writes names paperclip_tasks\.task_create, which the definition does not grant/);
});
test("trial_writes: only on an agent in trial, and only as a list", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial: undefined } } }, ["slack"])), /x: trial_writes is for an agent in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial: "yes" } } }, ["slack"])), /x: trial is true or absent/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: "paperclip_tasks.task_create" } } }, ["slack"])), /x: trial_writes must be a list of tools/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: { 0: "paperclip_tasks.task_create" } } } }, ["slack"])), /x: trial_writes must be a list of tools/);
});

test("trial_writes: a write it grants but doesn't name is absent from what the agent gets and the grants table, so it is refused by name", async () => {
  // Aria's real three names, with chat_send in her grants but left out of trial_writes.
  const r = compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ariaWrites.slice(0, 2) } } }, ["slack"]));
  const a = r.paperclip.agents.x;
  assert.equal(a.trial_writes.includes("chat_lane.chat_send"), false);
  assert.ok(!a.enabled_tools.chat_lane.includes("chat_send"), "the tool isn't offered to the agent");
  // Compile's enabled_tools go into the grants table setup writes, which every service checks: no chat_send, and the
  // declared task_create and the trial writes are there.
  assert.deepEqual(a.enabled_tools.chat_lane, ["wake_at"]);
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_create"));
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_comment") && !a.enabled_tools.paperclip_tasks.includes("task_update"));
});

test("instance agents are validated like module agents, and can't take roles or a module agent's key", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { nope: "read" } } } })), /x: grant to nope, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { roles: ["fleet-admin"] } } })), /x: an instance agent may not have roles/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { roles: ["architect"] } } })), /x: an instance agent may not have roles/);
  assert.throws(() => compile(product, withAgents({ architect: {} })), /duplicate agent: architect/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { budget: 10 } } })), /agent x: budget is gone: one install limit/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { reports_to: "nobody", trial: undefined } } })), /x: reports_to nobody, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { routines: { s: { title: "Prepare daily brief", schedules: [] } } } } })), /routine s needs a title no other routine has/);
  // Webhooks and their secrets come from modules only (an instance routine could otherwise take another's secret).
  for (const f of ["webhook", "webhook_base", "secrets_prefix"]) assert.throws(() => compile(product, withAgents({ x: { yaml: { routines: { s: { title: "S", [f]: "apps_incident_webhook" } } } } })), new RegExp(`routine s: ${f} isn't allowed`));
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
  // An Engineer has what it grants itself (attaching its own task's file, finishing it, recording its wait) and the tasks module's reads.
  assert.deepEqual(r.paperclip.agents.engineer.enabled_tools, { apps: ["app_list", "app_status", "app_view", "app_check", "web_view"], github: ["github_whoami", "github_project_read", "github_issue_read", "github_search_issues", "github_job_log", "github_pr_files", "github_product_issue_status", "github_pr_threads", "github_pr_thread_reply"], code_review: ["code_review_findings", "code_review_resolve"], paperclip_tasks: ["task_file_upload", "task_finish", "task_wait", "task_get", "task_search"] });
  assert.equal(r.paperclip.agents["review-chaser"].web_search, "disabled");
  assert.equal(r.paperclip.agents.assistant.web_search, undefined);
});

test("trial_writes: all four names compile, including notify, which a trial agent doesn't get automatically", () => {
  const r = compile(product, withAgents({ x: { yaml: { connections: { slack: "read", paperclip_tasks: ["task_create"], chat_lane: ["wake_at", "chat_send"], owner_channel: ["notify"] }, trial_writes: TRIAL_WRITE_ALLOWED } } }, ["slack"]));
  assert.deepEqual(r.paperclip.agents.x.trial_writes, TRIAL_WRITE_ALLOWED);
  assert.deepEqual(writesOf(r, r.paperclip.agents.x, "chat_lane"), ["wake_at", "chat_send"]);
  assert.deepEqual(writesOf(r, r.paperclip.agents.x, "owner_channel"), ["notify"]);
  // A trial agent that names nothing still gets no notify added for it (the "Asking the owner" grant is post-trial).
  assert.equal(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"].enabled_tools.owner_channel, undefined);
});

test("trial_writes: an agent that names none keeps today's behaviour, and a granted write outside trial_writes is still refused", () => {
  const none = compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"];
  assert.equal(none.trial_writes, undefined);
  assert.deepEqual(writesOf(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])), none, "paperclip_tasks"), ["task_comment", "task_handoff", "task_finish", "task_block", "task_cancel"]);
  // A write it grants but doesn't name is withheld from trial, not a compile error: it isn't offered, and the handbook can
  // still describe it as "after trial". Without a list, granting it is still the old error.
  const partial = compile(product, withAgents({ x: { yaml: { connections: { slack: "read", chat_lane: ["chat_send", "wake_at"] }, trial_writes: ["chat_lane.chat_send"] } } }, ["slack"]));
  assert.deepEqual(partial.paperclip.agents.x.trial_writes, ["chat_lane.chat_send"]);
  assert.deepEqual(writesOf(partial, partial.paperclip.agents.x, "chat_lane"), ["chat_send"]);
  assert.deepEqual(partial.paperclip.agents.x.trial_withheld, ["chat_lane.wake_at"]);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { trial_writes: undefined, connections: { slack: "read", chat_lane: ["chat_send", "wake_at"] } } } }, ["slack"])), /x: an agent in trial may not have chat_lane write tools \(chat_send, wake_at\); they come with tap 2/);
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
  assert.deepEqual(writes, ["apps.person_identity_decide", "fleet_steward.routing_judge", "fleet_steward.routing_tune", "ops_mcp.meeting_note_correct", "owner_channel.notify", "paperclip_tasks.coach_record", "paperclip_tasks.task_amend_rubric", "paperclip_tasks.task_block", "paperclip_tasks.task_cancel", "paperclip_tasks.task_comment", "paperclip_tasks.task_create", "paperclip_tasks.task_delegate", "paperclip_tasks.task_finish", "paperclip_tasks.task_handoff", "paperclip_tasks.task_propose_rule", "paperclip_tasks.task_route", "paperclip_tasks.task_wait"]);
  assert.deepEqual(a.enabled_tools.github, ["github_product_issue_status", "github_issue_link"]);
  assert.equal(a.web_search, "disabled");
  assert.ok(!a.enabled_tools.apps.includes("web_view"));
  // product-issues: the digest's live-fix check reads the product-bug issues' status (github_product_issue_status); filing is the Maintainer's.
  assert.deepEqual(a.roles, ["fleet-read", "fleet-settle", "fleet-audit", "librarian", "routing-tuner", "product-issues"]);
  assert.deepEqual(a.delegate_to, ["engineer", "app-maintainer", "app-owners", "architect", "maintainer"]);
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
test("the in-box `aidenhq task|tasks` reads are the tasks module's default grant: crew and Engineer yes; trial and check no", () => {
  const reads = (yaml) => (compile(product, withAgents({ x: { yaml } }, ["slack"])).paperclip.agents.x.enabled_tools.paperclip_tasks ?? []).filter((t) => ["task_get", "task_search"].includes(t)).sort();
  const graduated = { connections: { slack: "read" }, trial: undefined, reports_to: "chief-of-staff" };
  assert.deepEqual(reads(graduated), ["task_get", "task_search"]);
  assert.deepEqual(reads({ ...graduated, image: "agent-base" }), ["task_get", "task_search"]);
  assert.deepEqual(reads({ connections: { slack: "read" } }), [], "a trial agent");
  assert.deepEqual(reads({ ...graduated, profile: "check" }), [], "a check agent");
  assert.deepEqual(reads({ ...graduated, profile: "engineer" }), ["task_get", "task_search"], "an Engineer");
});

test("a setting is the shape of its default: a string where a list is meant fails the compile", () => {
  const dir = withAgents({}, ["github"]);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github"], settings: { ...owner, github_orgs: "acme,evil" } }));
  assert.throws(() => compile(product, dir), /settings\.github_orgs: a list, like its default \(got a string\)/);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE, "github"], settings: { ...owner, github_orgs: ["acme"] } }));
  assert.equal(compile(product, dir).paperclip ? "ok" : "", "ok");
});
