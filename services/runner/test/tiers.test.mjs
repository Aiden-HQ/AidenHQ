// The tier table, row by row, from verified state; plus the four real rejects of 2026-11-10/11.
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { classify } from "../src/tiers.mjs";

const base = { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", requester: { platform: false }, taskStatus: "in_progress" };
const branch = (over = {}) => ({ repo: "acme-agents/roadmap", branch: "feat/x", defaultBranch: "main", empty: false, files: ["src/a.ts"], ...over });
const pub = (action, b, over = {}) => classify(action, { ...base, branches: [branch(b)], ...over });
const merge = (p = {}, over = {}) => classify("merge", { ...base, prs: [{ repo: "acme-agents/roadmap", number: 3, files: ["src/a.ts"], checks: [{ name: "test", ok: true }], headMatches: true, ownHead: true, sensitive: false, ...p }], ...over });
const PIN_A = "a".repeat(40);
const PIN_B = "b".repeat(40);
const inst = (settings = {}, extra = "") => `product: ${PIN_A}\nmodules: [core]\nsettings:\n  owner_name: Sam\n  slack_post_channels: [C1]\n${Object.entries(settings).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}\n`).join("")}${extra}`;
const apply = (files, b, h, over = {}) => classify("apply", { ...base, files, base: b, head: h, pin: null, roles: { "chief-of-staff": ["fleet-admin"] }, ownerStarted: true, trialNoTap: true, ...over });
const def = (o) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
const tierOf = (t) => (t.reject ? "reject" : t.tier);

test("push and draft pr", () => {
  assert.equal(tierOf(pub("push", {})), 0, "ordinary agents-org branch");
  assert.equal(tierOf(pub("pr", {})), 0, "draft pr, agents org");
  assert.equal(tierOf(pub("push", { branch: "main" })), 2, "default branch");
  assert.equal(tierOf(pub("push", { branch: "deploy", deployBranch: "deploy" })), 2, "deploy branch");
  assert.equal(tierOf(pub("push", { empty: true })), 2, "empty repo: the first push lands on main");
  assert.equal(tierOf(pub("push", { files: [".github/workflows/ci.yml"] })), 2, ".github change");
  assert.equal(tierOf(pub("push", { repo: base.instanceRepo })), 2, "instance repo");
  assert.equal(tierOf(pub("push", { repo: base.productRepo })), 2, "product repo push from outside the Platform Engineer's line");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" })), 1, "pr outside the agents org");
  assert.equal(tierOf(pub("push", { repo: "acme/bor" })), 2, "push outside the agents org");
  assert.equal(tierOf(pub("pr", {}, { sticky: true })), 2, "sticky after a reject");
  assert.equal(tierOf(pub("push", {}, { productRepo: undefined })), 2, "product repo unknown: fail closed");
  assert.equal(tierOf(pub("push", { repo: "acme-agents/aidenhq-instance" }, { instanceRepo: undefined })), 2, "instance repo unknown: fail closed");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" }, { branches: [branch(), branch({ repo: "acme/bor" }), branch({ branch: "main" })] })), 2, "mixed: the highest part");
});

test("raise_cap is always the owner's", () => assert.equal(tierOf(classify("raise_cap", { ...base, sticky: false })), 2));

test("product repo PRs: platform only, gate files are the owner's", () => {
  assert.equal(tierOf(pub("pr", { repo: base.productRepo }, { requester: { platform: true } })), 1);
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["services/runner/src/merges.mjs"] }, { requester: { platform: true } })), 2);
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["services/apps-mcp/src/agent-auth.ts"] }, { requester: { platform: true } })), 2);
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["ops/apply-config.sh"] }, { requester: { platform: true } })), 2);
  assert.equal(tierOf(pub("pr", { repo: base.productRepo })), "reject", "any other requester");
});

// Owner, 2026-11-13: product writes are the reviewer's for the Platform Engineer's line unless they touch the actual gates.
const P = { requester: { platform: true }, roles: { "fleet-ops": ["fleet-read"] } };
const prod = (action, b = {}, over = {}) => pub(action, { repo: base.productRepo, ...b }, { ...P, ...over });
const yml = (o) => YAML.stringify(o);
const mod = (agents, extra = {}) => yml({ name: "m", agents, ...extra });
test("product repo: branch push, PR and merge are Tier 1 for the Platform Engineer's line", () => {
  assert.equal(tierOf(prod("push")), 1, "a branch push");
  assert.equal(tierOf(prod("push", { branch: "main" })), 2, "the default branch");
  assert.equal(tierOf(prod("push", {}, { requester: { platform: false } })), 2, "another agent's push stays the owner's");
  assert.equal(tierOf(prod("pr", { files: ["services/board/src/tasks.ts", "package-lock.json", "scripts/computers.mjs", "services/runner/src/prompt.mjs"] })), 1, "general code and computers.mjs are not gate code");
  for (const g of ["services/runner/src/tiers.mjs", "modules/core/security/policy.md", "scripts/no-shell.mjs", "services/computer/launcher.mjs", "services/computer/plugin/worker.js", "services/computer/images/engineer/Dockerfile", "services/runner/src/main.mjs", "services/runner/src/engines.mjs", "services/runner/src/state.mjs", "services/runner/src/config.mjs", "services/runner/src/github-app.mjs", "scripts/paperclip-setup.mjs", "scripts/modules.mjs", "services/gateway/lib.mjs", "scripts/verify-security.sh", "scripts/supply-chain/npm-age.mjs", ".github/workflows/ci.yml", "services/board/src/approvals.ts", "modules/glean/connections/glean-mcp/src/agent-auth.ts"])
    assert.equal(tierOf(prod("pr", { files: ["package.json", g] })), 2, g);
  assert.equal(tierOf(prod("pr", { files: ["modules/fleet-ops/agents/fleet-ops/AGENTS.md"] })), 2, "a role holder's handbook");
  assert.equal(tierOf(prod("pr", { files: ["modules/slack/agents/slack-scout/AGENTS.md"] })), 1, "a handbook of an agent without a role");
  const pm = (p = {}, over = {}) => merge({ repo: base.productRepo, ...p }, { ...P, ...over });
  assert.equal(tierOf(pm()), 1, "CI green on the exact head");
  assert.equal(tierOf(pm({ checks: [{ name: "test", ok: false, pending: true }] })), 1, "still running: the strict queue merges only once green");
  assert.equal(tierOf(pm({ checks: [{ name: "test", ok: false }] })), 2, "red");
  assert.equal(tierOf(pm({ checks: [] })), 2, "no checks");
  assert.equal(tierOf(pm({ headMatches: false })), 2, "head moved");
  assert.equal(tierOf(pm({ ownHead: false })), 2, "a fork's or someone else's head");
  assert.equal(tierOf(pm({ files: ["package.json", "services/runner/src/review.mjs"] })), 2, "gate code");
  assert.equal(tierOf(pm({}, { requester: { platform: false } })), 2, "another agent's merge");
});

test("product repo: a bump that quietly edits a gate file is the owner's", () => {
  const files = ["services/whisper/requirements.txt", "services/runner/package-lock.json", "services/runner/src/review.mjs"];
  const t = prod("pr", { files });
  assert.equal(tierOf(t), 2);
  assert.equal(t.rule, "product-gate");
  assert.match(t.reason, /review\.mjs/);
});

test("product repo: module.yaml and compose.yaml by content", () => {
  const f = "modules/m/module.yaml";
  const agent = { model: "a", reasoning_effort: "low", connections: { github: "read", paperclip_tasks: ["task_get"] }, roles: [] };
  const withText = (b, h) => prod("pr", { files: [f], texts: { [f]: { base: b, head: h } } });
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, reasoning_effort: "high" } }, { description: "new words" }))), 1, "effort and text");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { ...agent.connections, github: "write" } } }))), 2, "a wider grant");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { ...agent.connections, paperclip_tasks: ["task_get", "task_create"] } } }))), 2, "a new tool");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { github: "read" } } }))), 1, "a narrower grant");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, model: "b" } }))), 2, "a model");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, roles: ["fleet-admin"] } }))), 2, "a role");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent, y: agent }))), 2, "a new agent");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent }, { codex_args: ["--sandbox", "workspace-write"] }))), 2, "the tool-only sandbox");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent }, { generated_secrets: ["k"] }))), 2, "a credential");
  const conn = (tools, extra = {}) => mod({ x: agent }, { connections: { gh: { guide: "g", url: "http://gh:1/mcp", tools, ...extra } } });
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: ["a"], write: ["b"] }, { guide: "better guide" }))), 1, "a connection's guide");
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: ["a", "c"], write: ["b"] }))), 2, "a new tool on a connection");
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: [], write: ["a", "b"] }))), 2, "a tool tagged write");
  const rt = (model) => mod({ x: agent }, { routines: { r: { agent: "x", schedules: [{ cron: "0 9 * * *" }], ...(model ? { model } : {}) } } });
  assert.equal(tierOf(withText(rt(), yml({ ...YAML.parse(rt()), routines: { r: { agent: "x", schedules: [{ cron: "0 10 * * *" }] } } }))), 1, "a schedule");
  assert.equal(tierOf(withText(rt(), rt("m2"))), 2, "a routine model");
  assert.equal(tierOf(prod("pr", { files: [f] })), 2, "content not read: the owner's");
  const compose = (image, extra = {}) => yml({ services: { tailscale: { image, network_mode: "host", ...extra } } });
  const c = (b, h) => prod("pr", { files: ["compose.yaml"], texts: { "compose.yaml": { base: b, head: h } } });
  assert.equal(tierOf(c(compose("tailscale/tailscale:v1.90.1@sha256:aa"), compose("tailscale/tailscale:v1.90.4@sha256:bb"))), 1, "an image bump");
  assert.equal(tierOf(c(compose("t:1"), compose("t:1", { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }))), 2, "a new mount");
  assert.equal(tierOf(c(compose("tailscale/tailscale:v1.90.1"), compose("evil/tailscale:v1.90.1"))), 2, "another image repository");
  assert.equal(tierOf(c(compose("t:1"), yml({ services: { tailscale: { image: "t:1", network_mode: "host" }, extra: { image: "x:1" } } }))), 2, "a new service");
  // A module's compose fragment gets the same rules; unread, it is the owner's.
  const frag = "modules/glean/compose.yaml";
  const cf = (b, h) => prod("pr", { files: [frag], texts: { [frag]: { base: b, head: h } } });
  assert.equal(tierOf(cf(compose("g:1@sha256:aa"), compose("g:1@sha256:bb"))), 1, "a fragment's digest bump");
  assert.equal(tierOf(cf(compose("g:1"), compose("g:1", { privileged: true }))), 2, "a fragment turns privileged");
  assert.equal(tierOf(cf(compose("g:1"), compose("g:1", { environment: { TOKEN: "x" } }))), 2, "a fragment's env");
  assert.equal(tierOf(prod("pr", { files: [frag] })), 2, "a fragment not read");
  assert.equal(tierOf(withText(mod({ x: agent }, { compose: "compose.yaml" }), mod({ x: agent }, { compose: "other.yaml" }))), 2, "a module's compose path");
  assert.equal(tierOf(withText(mod({ x: agent }, { settings: { autonomy: { default: "off" } } }), mod({ x: agent }, { settings: { autonomy: { default: "full" } } }))), 2, "a setting's default");
});

test("merge in the agents org", () => {
  assert.equal(tierOf(merge()), 0, "named checks, all green on the exact head: merged at once (owner, 2026-11-12)");
  assert.equal(tierOf(merge({ checks: [] })), 2, "no checks");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: true }, { name: "lint", ok: false }] })), 2, "a check not green");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: false, pending: true }] })), 0, "checks still running: the queue merges only once green on the exact head");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: false, pending: false }] })), 2, "a failed check");
  assert.equal(tierOf(merge({ headMatches: false })), 2, "head moved");
  assert.equal(tierOf(merge({ ownHead: false })), 1, "a fork's or someone else's head: the reviewer reads the diff");
  assert.equal(tierOf(merge({ ownHead: false, checks: [{ name: "test", ok: false }] })), 2, "a foreign head with red checks: still the owner's");
  assert.equal(tierOf(merge({ files: [".github/workflows/x.yml"] })), 2, ".github change");
  assert.equal(tierOf(merge({ sensitive: true })), 2, "sensitive app");
  assert.equal(tierOf(merge({ repo: "acme/bor" })), 2, "outside the agents org");
});

test("apply: agents", () => {
  const trial = def({ name: "Chaser", trial: true, connections: { github: "read" } });
  const grad = def({ name: "Chaser", connections: { github: "read" } });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": trial })), 0, "add a trial agent, owner's task");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": trial }, { ownerStarted: false })), 1, "add a trial agent, agent-origin task");
  assert.equal(tierOf(apply(["agents/chaser/AGENTS.md"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": trial })), 0, "trial handbook only");
  const add = (d) => tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": def(d) }));
  assert.equal(add({ name: "Chaser", trial: true, roles: ["architect"] }), 2, "a new trial agent with a role");
  assert.equal(add({ name: "Chaser", trial: true, image: "x" }), 2, "a new trial agent with a field outside the safe set");
  assert.equal(add({ name: "Chaser", trial: true, connections: { github: "write" } }), 1, "a new trial agent with a write grant goes to the reviewer");
  assert.equal(tierOf(apply(["agents/chaser/AGENTS.md"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": grad })), 1, "handbook of a graduated agent without a role");
  assert.equal(tierOf(apply(["agents/chief-of-staff.md"], {}, {})), 2, "role-holding agent's handbook");
  assert.equal(tierOf(apply(["agents/architect/AGENTS.md"], {}, {})), 2, "a role agent's handbook by the agents/<key>/ path");
  assert.equal(tierOf(apply(["agents/ghost/AGENTS.md"], {}, {})), 2, "a new handbook without its trial agent.yaml in the change");
  assert.equal(tierOf(apply(["agents/assistant.md"], {}, {})), 1, "module agent without a role");
  assert.equal(tierOf(apply(["agents/assistant/memory.md"], {}, {})), 1, "memory of an agent without a role goes to the reviewer");
  assert.equal(tierOf(apply(["agents/architect/memory.md"], {}, {})), 2, "memory of a role agent is the owner's");
  assert.equal(tierOf(apply(["agents/assistant/memory.md", "agents/assistant/MEMORY.md"], {}, {})), 2, "an unrecognised file next to it");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": grad })), 1, "graduation keeping its tools");
  const wider = def({ name: "Chaser", connections: { github: "write", slack_live: ["slack_post"] } });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": wider })), 2, "graduation with new grants");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": def({ name: "Chaser", model: "x", connections: { github: "read" } }) })), 1, "model change");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": def({ name: "Chaser", image: "x", connections: { github: "read" } }) })), 2, "an unrecognised field");
});

test("apply: instance settings, pin and apps", () => {
  const f = ["instance.yaml"];
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst().replace("[C1]", "[C1, C2]") })), 1, "slack_post_channels addition");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst({ github_orgs: [] }) }, { "instance.yaml": inst({ github_orgs: ["evil"] }) })), 2, "github_orgs");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({ autonomy: "full" }) })), 2, "any other setting");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({ spend_caps: "off" }) })), 2, "the spend caps' kill switch is the owner's");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst().replace(PIN_A, PIN_B) }, { pin: { forward: true } })), 1, "pin forward");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  routines:\n    daily-brief:\n      schedules: []\n") })), 1, "routine schedule");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  agents:\n    assistant:\n      model: x\n") })), 1, "model change");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  agents:\n    assistant:\n      caps: { task_usd: 50 }\n") })), 2, "an agent's spend caps are the owner's");
  const graded = (g) => def({ name: "Chaser", connections: { github: "read" }, ...g });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": graded({}) }, { "agents/chaser/agent.yaml": graded({ graded: false }) })), 2, "turning grading off is the owner's");
  const apps = (a) => `apps:\n${a.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}\n`;
  const app = { name: "roadmap", repo: "acme-agents/roadmap", owner: "a", description: "d" };
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([app]) })), 1, "non-sensitive app");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, database: "warehouse" }]) })), 1, "warehouse database");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, connects: ["paperclip"] }]) })), 2, "connects to paperclip");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, access: { roles: ["x"] } }]) })), 2, "access");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, caps: ["NET_ADMIN"] }]) })), 2, "caps");
  const shared = { name: "dash", share: { host: "dash.example.com", aud: "x", viewers: ["a@x.com"] } };
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, share: shared.share }]) })), 2, "share: a wider human audience is the owner's");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([{ ...app, name: "dash", share: shared.share }]) }, { "apps.yaml": apps([{ ...app, name: "dash", share: shared.share }, { ...app, connects: ["dash"] }]) })), 2, "connects to a shared app");
  // apps-mcp's isSensitive decides; only `database: warehouse` alone is carved out to Tier 1.
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, stateful: true }]) })), 2, "stateful is sensitive");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, database: "warehouse", stateful: true }]) })), 2, "warehouse plus another trait");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, connects: ["vault"] }]) }, { moduleApps: [{ name: "vault", access: { roles: ["x"] } }] })), 2, "connects to a restricted module app");
  assert.equal(tierOf(apply(["apps.yaml", "instance.yaml"], { "apps.yaml": apps([]), "instance.yaml": inst() }, { "apps.yaml": apps([app]), "instance.yaml": inst({ github_orgs: ["x"] }) })), 2, "mixed: the highest part");
  assert.equal(tierOf(apply(["README.md"], {}, {})), 2, "unrecognised");
});

test("the four real rejects of 2026-11-10/11 never reach the reviewer as approvable", () => {
  // An app PR into the product repo, from an app-building agent.
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["modules/core/apps/x/index.ts"] })), "reject");
  // A product pin moving backwards.
  assert.equal(tierOf(apply(["instance.yaml"], { "instance.yaml": inst() }, { "instance.yaml": inst().replace(PIN_A, PIN_B) }, { pin: { back: true } })), 2);
  // Two leftover cards on cancelled tasks.
  assert.equal(tierOf(pub("push", {}, { taskStatus: "cancelled" })), "reject");
  assert.equal(tierOf(merge({}, { taskStatus: "cancelled" })), "reject");
});
