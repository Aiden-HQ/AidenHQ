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
import { compile, grantEntry, TRIAL_WRITE_ALLOWED } from "../modules.mjs";

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
// Trial writes: an agent in trial may declare the owner-channel writes it keeps (as connection.tool), and only those.
const ariaWrites = ["paperclip_tasks.task_create", "slack_live.wake_at", "slack_live.chat_send"];
const ariaYaml = { connections: { slack: "read", paperclip_tasks: ["task_current", "task_comments", "task_comment", "task_finish", "task_create", "task_update"], slack_live: ["wake_at", "chat_send"] }, trial_writes: ariaWrites };

test("trial_writes: an agent in trial compiles with the writes it names, and keeps exactly those writes", () => {
  const r = compile(product, withAgents({ x: { yaml: ariaYaml } }, ["slack"]));
  const a = r.paperclip.agents.x;
  assert.deepEqual(a.trial_writes, ariaWrites);
  assert.deepEqual(writesOf(r, a, "paperclip_tasks"), ["task_comment", "task_finish", "task_create"]);
  assert.deepEqual(writesOf(r, a, "slack_live"), ["wake_at", "chat_send"]);
  // The tool it granted but didn't name is withheld: not offered to the agent, and named so the handbook check stays quiet.
  assert.deepEqual(a.trial_withheld, ["paperclip_tasks.task_update"]);
  // Its reads are untouched.
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_current"));
});
test("trial_writes: all four names compile, including notify_owner, which a trial agent doesn't get automatically", () => {
  const r = compile(product, withAgents({ x: { yaml: { connections: { slack: "read", paperclip_tasks: ["task_create"], slack_live: ["wake_at", "chat_send", "notify_owner"] }, trial_writes: TRIAL_WRITE_ALLOWED } } }, ["slack"]));
  assert.deepEqual(r.paperclip.agents.x.trial_writes, TRIAL_WRITE_ALLOWED);
  assert.deepEqual(writesOf(r, r.paperclip.agents.x, "slack_live"), ["wake_at", "chat_send", "notify_owner"]);
  // A trial agent that names nothing still gets no notify_owner added for it (the "Asking the owner" grant is post-trial).
  assert.equal(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"].enabled_tools.slack_live, undefined);
});

test("trial_writes: any other name is a compile error naming the agent and the tool", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: [...ariaWrites, "paperclip_tasks.task_update"] } } }, ["slack"])), /x: trial_writes names paperclip_tasks\.task_update, which it may not use in trial \(only paperclip_tasks\.task_create, slack_live\.wake_at, slack_live\.chat_send, slack_live\.notify_owner\)/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["slack_live.slack_post"] } } }, ["slack"])), /x: trial_writes names slack_live\.slack_post, which it may not use in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["slack.wake_at"] } } }, ["slack"])), /x: trial_writes names slack\.wake_at, which it may not use in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ["task_create"] } } }, ["slack"])), /x: trial_writes names "task_create", not a tool written connection\.tool/);
});
test("trial_writes: an entry the definition does not grant is a compile error", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, connections: { ...ariaYaml.connections, slack_live: ["wake_at"] } } } }, ["slack"])), /x: trial_writes names slack_live\.chat_send, which the definition does not grant/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, connections: { paperclip_tasks: ["task_comment"], slack: "read" } } } }, ["slack"])), /x: trial_writes names paperclip_tasks\.task_create, which the definition does not grant/);
});
test("trial_writes: only on an agent in trial, and only as a list", () => {
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial: undefined } } }, ["slack"])), /x: trial_writes is for an agent in trial/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial: "yes" } } }, ["slack"])), /x: trial is true or absent/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: "paperclip_tasks.task_create" } } }, ["slack"])), /x: trial_writes must be a list of tools/);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: { 0: "paperclip_tasks.task_create" } } } }, ["slack"])), /x: trial_writes must be a list of tools/);
});
test("trial_writes: an agent that names none keeps today's behaviour, and a granted write outside trial_writes is still refused", () => {
  const none = compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"];
  assert.equal(none.trial_writes, undefined);
  assert.deepEqual(writesOf(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])), none, "paperclip_tasks"), ["task_comment", "task_handoff", "task_finish", "task_set_status"]);
  // A write it grants but doesn't name is withheld from trial, not a compile error: it isn't offered, and the handbook can
  // still describe it as "after trial". Without a list, granting it is still the old error.
  const partial = compile(product, withAgents({ x: { yaml: { connections: { slack: "read", slack_live: ["chat_send", "wake_at"] }, trial_writes: ["slack_live.chat_send"] } } }, ["slack"]));
  assert.deepEqual(partial.paperclip.agents.x.trial_writes, ["slack_live.chat_send"]);
  assert.deepEqual(writesOf(partial, partial.paperclip.agents.x, "slack_live"), ["chat_send"]);
  assert.deepEqual(partial.paperclip.agents.x.trial_withheld, ["slack_live.wake_at"]);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { trial_writes: undefined, connections: { slack: "read", slack_live: ["chat_send", "wake_at"] } } } }, ["slack"])), /x: an agent in trial may not have slack_live write tools \(chat_send, wake_at\); they come with tap 2/);
});

test("trial_writes: a write it grants but doesn't name is absent from what the agent gets and the grants table, so it is refused by name", async () => {
  // Aria's real three names, with chat_send in her grants but left out of trial_writes.
  const r = compile(product, withAgents({ x: { yaml: { ...ariaYaml, trial_writes: ariaWrites.slice(0, 2) } } }, ["slack"]));
  const a = r.paperclip.agents.x;
  assert.equal(a.trial_writes.includes("slack_live.chat_send"), false);
  assert.ok(!a.enabled_tools.slack_live.includes("chat_send"), "the tool isn't offered to the agent");
  // Compile's enabled_tools go into the grants table setup writes, which every service checks: no chat_send, and the
  // declared task_create and the trial writes are there.
  assert.deepEqual(a.enabled_tools.slack_live, ["wake_at"]);
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_create"));
  assert.ok(a.enabled_tools.paperclip_tasks.includes("task_comment") && !a.enabled_tools.paperclip_tasks.includes("task_update"));
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
test("the Architect: max effort, only its own role, no fleet tools, reads every source; it changes the fleet only by delegating", () => {
  const a = compile(product, withAgents({}, ["slack", "github"])).paperclip.agents.architect;
  assert.deepEqual([a.model, a.reasoning_effort], ["~deepseek/deepseek-flash-latest", "max"]);
  assert.deepEqual(a.roles, ["architect", "repo-checkout"]);
  assert.deepEqual(a.enabled_tools.slack_live, ["notify_owner"]);
  assert.deepEqual(a.enabled_tools.apps, ["app_list", "app_status", "app_logs", "app_view", "web_view", "warehouse_query"]); // research reads only: no deploys, and the request and role reads would refuse it anyway
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
  // Without a routine model it still gets the launcher (a stable cwd, for prompt caching).
  assert.equal(compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"])).paperclip.agents["review-chaser"].command, "/opt/aidenhq/codex-model");
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
  // Paperclip puts its own -c pairs before `exec`.
  assert.equal(run(["-c", "a=1", "exec", "--json", "--model", "agent-m", "-"], "routine-m"), "-c|a=1|exec|--model|routine-m|--json|-|");
  assert.equal(run(["-c", "a=1", "exec", "-"]), "-c|a=1|exec|-|");
  // A run starts in one stable directory per agent, not the task's.
  writeFileSync(join(bin, "codex"), "#!/bin/sh\npwd\n", { mode: 0o755 });
  const here = (id) => execFileSync(join(product, "services/paperclip-tasks-mcp/codex-model"), ["-c", "x=1", "exec"], { encoding: "utf8", cwd: tmpdir(), env: { PATH: `${bin}:/usr/bin:/bin`, ...(id ? { PAPERCLIP_AGENT_ID: id } : {}) } });
  assert.equal(here("a1"), "/tmp/aidenhq-cwd/a1\n");
  assert.equal(statSync("/tmp/aidenhq-cwd/a1").mode & 0o777, 0o555); // read-only: Codex loads AGENTS.md from its cwd
  assert.doesNotMatch(here(""), /aidenhq-cwd/); // no agent id: left alone
  assert.doesNotMatch(here("../x"), /aidenhq-cwd/);
  chmodSync("/tmp/aidenhq-cwd/a1", 0o755); writeFileSync("/tmp/aidenhq-cwd/a1/AGENTS.md", "planted"); // a run made it writable again
  assert.doesNotMatch(here("a1"), /aidenhq-cwd/); // not empty: Paperclip's own cwd
  rmSync("/tmp/aidenhq-cwd/a1", { recursive: true });
  mkdirSync("/tmp/aidenhq-cwd/.git"); // a planted git root above the cwd would make Codex read AGENTS.md from the parent
  assert.doesNotMatch(here("a1"), /aidenhq-cwd/);
  rmSync("/tmp/aidenhq-cwd", { recursive: true, force: true });
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
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
  // Runner agents get no tools added; one in a computer (the App Engineer) has exactly what it grants itself.
  for (const [key, a] of Object.entries(r.paperclip.agents)) if (a.dispatch === "runner" && !a.image) assert.ok(!a.mcp_servers.includes("apps"), key);
  assert.deepEqual(r.paperclip.agents["app-engineer"].enabled_tools, { apps: ["app_list", "app_status", "app_view", "app_check", "web_view"], github: ["github_whoami", "github_project_read", "github_issue_read", "github_search_issues"] });
  assert.equal(r.paperclip.agents["review-chaser"].web_search, "disabled");
  assert.equal(r.paperclip.agents.assistant.web_search, undefined);
});

test("every template in modules/core/templates compiles as an instance agent in trial", () => {
  const root = join(product, "modules/core/templates");
  for (const key of readdirSync(root).filter((d) => existsSync(join(root, d, "agent.yaml")))) {
    const dir = withAgents({}, ["github", "slack"]);
    mkdirSync(join(dir, "agents", key));
    for (const f of ["agent.yaml", "AGENTS.md"]) copyFileSync(join(root, key, f), join(dir, "agents", key, f));
    const a = compile(product, dir).paperclip.agents[key];
    assert.equal(a.trial, true, key);
    assert.equal(a.reports_to, "architect", key);
    assert.equal(a.model, "~deepseek/deepseek-flash-latest", key);
  }
});

test("departments: shipped agents name one from core's registry; an instance adds its own; an unknown one fails compile", () => {
  const r = compile(product, withAgents({ "review-chaser": {} }, ["github", "slack"]));
  assert.deepEqual(r.paperclip.agents["chief-of-staff"].department, { id: "leadership", name: "Leadership", description: "Coordinates work and prepares research, drafts and reports for you", order: 0 });
  assert.equal(r.paperclip.agents["review-chaser"].department.id, "outreach");
  assert.equal(compile(product, withAgents({ "review-chaser": { yaml: { department: undefined } } }, ["github", "slack"])).paperclip.agents["review-chaser"].department.id, "general");
  const dir = withAgents({ "review-chaser": { yaml: { department: "growth" } } }, ["github", "slack"]);
  assert.throws(() => compile(product, dir), /review-chaser: department growth is not in the registry/);
  const file = join(dir, "instance.yaml");
  writeFileSync(file, YAML.stringify({ ...YAML.parse(readFileSync(file, "utf8")), departments: [{ id: "growth", name: "Growth" }] }));
  assert.equal(compile(product, dir).paperclip.agents["review-chaser"].department.name, "Growth");
});

test("chat: an instance agent's fast chat lane: defaults, and only its own granted tools", () => {
  const r = compile(product, withAgents({ "review-chaser": { yaml: { chat: { tools: ["github.github_issue_read"] } } } }, ["github", "slack"]));
  assert.deepEqual(r.paperclip.agents["review-chaser"].chat, { model: "~z-ai/glm-flash-latest", reasoning: "low", deadline_s: 8, telegram: false, tools: ["github.github_issue_read"] });
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { chat: { tools: ["paperclip_tasks.fleet_control"] } } } }, ["github", "slack"])), /chat tool paperclip_tasks.fleet_control isn't one of its granted tools/);
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { chat: { reasoning: "high" } } } }, ["github", "slack"])), /chat.reasoning must be off or low/);
  assert.throws(() => compile(product, withAgents({ "review-chaser": { yaml: { chat: { stream: true } } } }, ["github", "slack"])), /chat: unknown field stream/);
});

test("builder: true reaches the compiled config (setup adds How we build from it), on module and instance agents", () => {
  const r = compile(product, withAgents({ "review-chaser": { yaml: { builder: true } } }, ["github", "design"]));
  const builders = Object.entries(r.paperclip.agents).filter(([, a]) => a.builder === true).map(([k]) => k);
  assert.deepEqual(builders.sort(), ["app-maintainer", "architect", "review-chaser", "ui-designer", "ui-reviewer"]);
  assert.throws(() => compile(product, withAgents({ x: { yaml: { builder: "yes" } } })), /x: builder is true, false or absent/);
});
