// Instance-defined agents and the Architect: the role template compiles in trial (tap 1) and graduated
// (tap 2); trial is enforced by compile; the Architect can't change the fleet itself.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
const template = join(product, "modules/core/templates/pr-review-chaser");
const owner = { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x" };

/** An instance with agents/<key>/ folders: { key: { yaml (merged over the template; undefined drops a field), md } }. */
function withAgents(folders, modules = []) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings: owner }));
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
  assert.equal(a.budget, 10);
  assert.match(a.title, /^Chases pull requests/);
  assert.match(a.instructions, /agents\/review-chaser\/AGENTS\.md$/);
  assert.deepEqual(a.roles, []);
  assert.deepEqual(writesOf(r, a, "paperclip_tasks"), ["task_comment", "task_handoff", "task_finish", "task_set_status"]);
  assert.deepEqual(writesOf(r, a, "slack"), []);
  assert.equal(r.paperclip.routines["review-chaser-sweep"].agent, "review-chaser");
  assert.equal(r.paperclip.routines["review-chaser-sweep"].schedules[0].timezone, "Europe/London");
});
test("graduated (tap 2): write grants and a real manager", () => {
  const r = compile(product, withAgents({ "review-chaser": { yaml: { trial: undefined, reports_to: "chief-of-staff", connections: { github: "read", slack: "write", paperclip_tasks: "write" } } } }, ["github", "slack"]));
  assert.ok(r.paperclip.agents["review-chaser"].enabled_tools.slack.includes("slack_send_message_draft"));
});
test("an agent in trial gets no write tools and reports to the Architect", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { slack: "write" } } } }, ["slack"])), /x: an agent in trial may not have slack write tools/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { paperclip_tasks: ["task_create"] } } } })), /x: an agent in trial may not have paperclip_tasks write tools \(task_create\)/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { reports_to: "chief-of-staff", connections: {} } } })), /x: an agent in trial reports to architect/);
});
test("instance agents are validated like module agents, and can't take roles or a module agent's key", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { connections: { nope: "read" } } } })), /x: grant to nope, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { roles: ["fleet-admin"] } } })), /x: an instance agent may not have roles/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { roles: ["architect"] } } })), /x: an instance agent may not have roles/);
  assert.throws(() => compile(product, withAgents({ architect: {} })), /duplicate agent: architect/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { budget: undefined } } })), /x: budget is required/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { reports_to: "nobody", trial: undefined } } })), /x: reports_to nobody, which is not enabled/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { routines: { s: { title: "Prepare daily brief", schedules: [] } } } } })), /routine s needs a title no other routine has/);
  // Webhooks and their secrets come from modules only (an instance routine could otherwise take another's secret).
  for (const f of ["webhook", "webhook_base", "secrets_prefix"]) assert.throws(() => compile(product, withAgents({ x: { yaml: { routines: { s: { title: "S", [f]: "apps_incident_webhook" } } } } })), new RegExp(`routine s: ${f} isn't allowed`));
});
test("the Architect: the stronger model, only its own role, no fleet tools, reads every source; it changes the fleet only by delegating", () => {
  const a = compile(product, withAgents({}, ["slack", "github"])).paperclip.agents.architect;
  assert.equal(a.model, "moonshotai/kimi-k3.1-pro");
  assert.deepEqual(a.roles, ["architect"]);
  assert.deepEqual(a.enabled_tools.slack_live, ["notify_owner"]);
  assert.deepEqual(a.enabled_tools.apps, ["app_list", "app_status", "app_logs", "app_view", "web_view", "warehouse_query", "source_new", "app_requests", "app_roles"]); // no deploys (the request and role reads refuse it: not an owner, no app-requests role)
  assert.ok(a.enabled_tools.slack.includes("slack_read_thread") && !a.enabled_tools.slack.some((t) => /send|draft/.test(t)));
  assert.ok(a.enabled_tools.github.includes("github_issue_read") && !a.enabled_tools.github.some((t) => /comment|create|update|review|rerun/.test(t)));
  for (const t of ["fleet_control", "fleet_status", "task_relay_owner_words", "task_create_engineer_task", "task_update", "task_create"]) assert.ok(!a.enabled_tools.paperclip_tasks.includes(t), t);
});

test("an instance agent may name a computer image; an unknown one fails compile (step 5 validates image:)", () => {
  // A graduated agent (not in trial) may; one in trial may not yet (its limits would run inside the box).
  assert.equal(compile(product, withAgents({ "review-chaser": { yaml: { image: "agent-base", trial: undefined, reports_to: "chief-of-staff" } } }, ["github", "slack"])).paperclip.agents["review-chaser"].image, "agent-base");
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { image: "agent-base" } } }, ["github", "slack"])), /in trial/);
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { image: "kali" } } }, ["github", "slack"])), /review-chaser: image must be one of agent-base, engineer/);
});

test("model: on a routine runs it on that model: the agent gets the codex-model launcher; a computer agent keeps plain codex (its box launcher applies it)", () => {
  const sweep = (extra) => ({ sweep: { ...YAML.parse(readFileSync(join(template, "agent.yaml"), "utf8")).routines.sweep, ...extra } });
  const r = compile(product, withAgents({ "review-chaser": { yaml: { routines: sweep({ model: "~z-ai/glm-flash-latest" }) } } }, ["github", "slack"]));
  assert.equal(r.paperclip.routines["review-chaser-sweep"].model, "~z-ai/glm-flash-latest");
  assert.equal(r.paperclip.agents["review-chaser"].command, "/opt/aidenhq/codex-model");
  // Without a routine model the agent keeps plain codex.
  assert.equal(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"].command, undefined);
  const boxed = { image: "agent-base", trial: undefined, reports_to: "chief-of-staff" };
  const b = compile(product, withAgents({ "review-chaser": { yaml: { ...boxed, routines: sweep({ model: "m" }) } } }, ["github", "slack"]));
  assert.equal(b.paperclip.routines["review-chaser-sweep"].model, "m");
  assert.equal(b.paperclip.agents["review-chaser"].command, undefined);
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { routines: sweep({ model: 3 }) } } }, ["github", "slack"])), /model must be a string/);
});

test("the codex-model launcher swaps the routine's model in for the agent's, and runs Codex as is otherwise", () => {
  const bin = mkdtempSync(join(tmpdir(), "codex-"));
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
  const run = (args, model) => execFileSync(join(product, "services/paperclip-tasks-mcp/codex-model"), args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, ...(model ? { AIDENHQ_MODEL: model } : {}) } });
  assert.equal(run(["exec", "--json", "--model", "agent-m", "-c", 'x="a b"', "resume", "s1", "-"], "routine-m"), 'exec|--model|routine-m|--json|-c|x="a b"|resume|s1|-|');
  assert.equal(run(["exec", "--json", "-"], "routine-m"), "exec|--model|routine-m|--json|-|");
  assert.equal(run(["exec", "--json", "--model", "agent-m", "-"]), "exec|--json|--model|agent-m|-|");
  assert.equal(run(["--version"], "routine-m"), "--version|");
  // The routine's reasoning effort replaces the agent's -c model_reasoning_effort, other -c settings stay.
  const eff = ["exec", "--json", "-c", 'model_reasoning_effort="high"', "-c", "x=1", "-"];
  assert.equal(execFileSync(join(product, "services/paperclip-tasks-mcp/codex-model"), eff, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, AIDENHQ_REASONING_EFFORT: "low" } }), 'exec|-c|model_reasoning_effort="low"|--json|-c|x=1|-|');
});

test("the web for every codex agent: live search by default (an agent may opt down), web_view and app_view granted; never runner agents", () => {
  const dir = withAgents({ "review-chaser": { yaml: { web_search: "disabled" } } }, ["slack", "github", "open-loops", "meetings", "engineering", "primer"]);
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["slack", "github", "open-loops", "meetings", "engineering", "primer"], settings: { ...owner, owner_slack_user_id: "U1", owner_email: "e@x", product_repo: "acme/aidenhq" } }));
  const r = compile(product, dir);
  const args = r.paperclip.codex_args.join(" ");
  assert.match(args, /web_search="live"/);
  assert.doesNotMatch(args, /web_search="(disabled|cached)"/);
  const codex = Object.entries(r.paperclip.agents).filter(([, a]) => a.adapter === "codex_local");
  assert.ok(codex.length >= 8);
  // Every codex agent can view apps; web_view goes to all but those with web search off (the email/Slack scouts).
  for (const [key, a] of codex) {
    assert.ok(a.enabled_tools.apps?.includes("app_view"), `${key} lacks app_view`);
    if (a.web_search !== "disabled") assert.ok(a.enabled_tools.apps?.includes("web_view"), `${key} lacks web_view`);
  }
  for (const k of ["slack-scout", "inbox-agent", "slack-triage"]) {
    assert.equal(r.paperclip.agents[k].web_search, "disabled", k);
    assert.ok(!r.paperclip.agents[k].enabled_tools.apps?.includes("web_view"), k);
  }
  for (const [key, a] of Object.entries(r.paperclip.agents)) if (a.dispatch === "runner") assert.ok(!a.mcp_servers.includes("apps"), key);
  assert.equal(r.paperclip.agents["review-chaser"].web_search, "disabled");
  assert.equal(r.paperclip.agents.assistant.web_search, undefined);
});
