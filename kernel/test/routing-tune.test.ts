// The routing learning loop end to end on a local instance repo: the Steward's typed change written by the kernel, filed as one
// kernel.apply the real planner tiers, reviewed and landed; the one routing gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createApply } from "../src/apply.ts";
import { applyParts, createApplyPlanner, routingDiff } from "../src/apply-tier.ts";
import { KERNEL_KINDS } from "../src/kinds.ts";
import { openRecords } from "../src/records.ts";
import { createRouting } from "../src/routing-tune.ts";
import { checkoutMain } from "../src/settings-change.ts";
import { createWakes } from "../src/wakes.ts";
import { createWrites } from "../src/writes.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";
import { kernel, moduleServer } from "./helpers.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }).trim();
const INSTANCE = `# the acme instance
product: ${"a".repeat(40)}
modules: [core]
teams:
  engineering:
    template: engineering.engineer
    members:
      kai: { name: Kai }
      mina:
        name: Mina
        repos: [acme/web]
`;
const REPO = "local/acme-instance";
const STEWARD = { agent: "id-steward", key: "fleet-steward", name: "fleet-steward", roles: ["routing-tuner"], kind: "run", task: "t-steward", run: "j-1", model: "~acme/deepseek" };
const grants = {
  "id-team": { key: "engineer", team: { name: "engineering", members: ["kai", "mina"] } },
  "id-kai": { key: "kai", member_of: "engineer" }, "id-mina": { key: "mina", member_of: "engineer", repos: ["acme/web"] },
};
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function world({ autonomy = "full", reviewer = "approve" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "routing-tune-"));
  const src = join(dir, "src");
  mkdirSync(src);
  git(src, "init", "-q");
  writeFileSync(join(src, "instance.yaml"), INSTANCE);
  git(src, "add", "-A");
  git(src, "commit", "-qm", "init");
  const bare = join(dir, "inst.git");
  git(dir, "clone", "-q", "--bare", src, bare);
  const checkout = join(dir, "checkout");
  git(dir, "clone", "-q", bare, checkout);
  const host = localApply({ bare, instanceRepo: REPO });
  const g = structuredClone(grants);
  const records = openRecords(join(dir, "kernel.db"));
  const db = records.db;
  const issues = {};
  const owner = async (method, path) => {
    const m = /^\/api\/issues\/([^/]+)$/.exec(path);
    return m && issues[m[1]] ? { status: 200, json: issues[m[1]] } : { status: 404, json: {} };
  };
  createWakes({ db, owner, post: async () => ({}), dispatches: { may: () => false, agents: () => [] } }); // its tables
  db.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, task TEXT, agent TEXT, state TEXT, at INTEGER)");
  let routing;
  const planner = createApplyPlanner({
    instanceRepo: () => REPO, read: (s) => host.read(s),
    product: { onMain: async () => true, isAncestor: async () => true, log: async () => "" },
    modules: () => ({}), verifyRelease: async () => null,
    notes: (sha, requester, task) => routing.notes(sha, requester, task),
  });
  // Each launch is an apply that ends at once in a good generation of the instance's main, which contains the commit.
  const gens = [];
  const applies = createApply({
    db, pollMs: 5, generations: () => gens, contains: async () => true, tail: async () => "",
    codehost: { read: (s) => host.read(s), land: (s) => host.land(s) },
    launch: async () => { gens.push({ n: gens.length + 1, instance: "e".repeat(40), health: "good" }); },
    unit: async () => ({ loaded: false, active: "inactive", sub: "dead", result: "" }),
  });
  const reviewed = [];
  const writes = createWrites({
    records, registry: () => ({ "kernel.apply": KERNEL_KINDS["kernel.apply"] }), connections: () => ({}), secret: () => "", resolver: {}, paths: () => ({ entries: [] }),
    repos: () => ({ product: "acme/aidenhq", instance: REPO }),
    reviews: { request: async (req) => (reviewed.push(req), { decision: reviewer, reason: "read it", model: "~acme/reviewer" }) },
    onTask: { open: async () => true, notify: async () => {} }, replay: async () => ({ ok: false, text: "" }),
    native: { "kernel.apply": applies.execute }, planners: { "kernel.apply": planner }, resume: ["kernel.apply"], autonomy: () => autonomy,
  });
  routing = createRouting({ db, records, instanceRepo: () => REPO, main: checkoutMain(checkout), write: (w) => host.write(w), owner, grants: () => g, file: (args, task, requester) => writes.fileKernel("kernel.apply", { args, task, requester }) });
  // A decision the router recorded (wakes.ts): the task named acme/api; kai (no repos) won over mina (acme/web) on the key.
  let n = 0;
  const decide = ({ at = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - 3_600_000, blocked = false, status = "done" } = {}) => {
    const task = uuid(++n);
    const candidates = [{ id: "id-kai", key: "kai", repos: [], maxParallel: 1, paused: false, running: 0, queued: 0, done: 0 }, { id: "id-mina", key: "mina", repos: ["acme/web"], maxParallel: 1, paused: false, running: 0, queued: 0, done: 0 }];
    db.prepare("INSERT INTO team_routes (task, team, member, repos, at, state, snapshot) VALUES (?, 'engineer', ?, ?, ?, ?, ?)").run(task, blocked ? null : "id-kai", JSON.stringify(["acme/api"]), at, blocked ? "blocked" : "placed", JSON.stringify({ weights: { repo: 3, continuity: 1, load: 1 }, candidates }));
    issues[task] = { id: task, identifier: `WOR-${n}`, status, completedAt: new Date(at + 7_200_000).toISOString() };
    return task;
  };
  const yamlAt = (ref) => YAML.parse(git(bare, "show", `${ref}:instance.yaml`));
  return { bare, db, records, writes, routing, decide, yamlAt, reviewed, issues, grants: g };
}
const REVERT = { metric: "blocked_rate", min_sample: 1, threshold: 0.5, deadline_days: 3 };

test("autonomy off: the change is the owner's; his no closes it and its content stays refused", async () => {
  const w = world({ autonomy: "off" });
  const t = w.decide();
  const { base_sha } = await w.routing.evidence({});
  const r = await w.routing.tune(STEWARD, "t-steward", { base_sha, team: "engineering", weights: { continuity: 2 }, decisions: [t], hypothesis: "continuity matters", revert: REVERT });
  const record = w.records.get(r.record);
  assert.equal(record.state, "owner");
  // The owner's no closes the experiment, and the team gets no other proposal for 3 days, whatever its values (no review
  // shopping); after that, the same change is still never filed again unchanged.
  w.writes.decide(r.record, { digest: record.digest, decision: "reject", by: "owner:telegram", via: "telegram" });
  const next = { base_sha, team: "engineering", weights: { continuity: 3 }, decisions: [t], hypothesis: "a little more", revert: REVERT };
  w.db.prepare("UPDATE routing_experiments SET day = '2000-01-01'").run(); // the next day
  await assert.rejects(w.routing.tune(STEWARD, "t-steward", next), /was turned down: no routing change for that team until/);
  w.db.prepare("UPDATE routing_experiments SET rejected_at = rejected_at - 4 * 86400000").run();
  await assert.rejects(w.routing.tune(STEWARD, "t-steward", { ...next, weights: { continuity: 2 } }), /was not approved as experiment/);
});

test("refused before anything is written: a stale base, an unknown member, out-of-bounds weights, other fields, uncited evidence; two at once file one", async () => {
  const w = world();
  const t = w.decide();
  const { base_sha } = await w.routing.evidence({});
  const ok = { base_sha, team: "engineering", decisions: [t], hypothesis: "h", revert: REVERT };
  for (const [bad, why] of [
    [{ ...ok, base_sha: "b".repeat(40), weights: { repo: 2 } }, /main moved/],
    [{ ...ok, repos: { zed: ["acme/*"] } }, /no member zed/],
    [{ ...ok, weights: { repo: 11 } }, /each 0 to 10/],
    [{ ...ok, weights: { load: 0.5 } }, /load at least 1/],
    [{ ...ok, repos: { mina: ["not a pattern"] } }, /owner\/name patterns/],
    [{ ...ok, weights: { repo: 2 }, caps: { day_usd: 999 } }, /send \{/],
    [{ ...ok, weights: { repo: 2 }, decisions: [uuid(99)] }, /isn't a recorded decision/],
    [{ ...ok, weights: { repo: 2 }, revert: { ...REVERT, metric: "vibes" } }, /revert.metric/],
    [{ ...ok, team: "ops", weights: { repo: 2 } }, /no team ops/],
  ]) await assert.rejects(w.routing.tune(STEWARD, "t-steward", bad), why);
  assert.equal(git(w.bare, "branch", "--list", "settings/*"), "");
  const both = await Promise.allSettled([1, 2].map((v) => w.routing.tune(STEWARD, "t-steward", { ...ok, weights: { repo: v } })));
  assert.deepEqual(both.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(w.records.list(["review", "owner", "approved", "claimed", "done"], 10, { task: "t-steward" }).length, 1);
});

test("the one routing gate: only members' repos and weights move; anything else, a repeated key or an alias is no routing change", () => {
  const head = (f) => { const d = YAML.parse(INSTANCE); f(d.teams.engineering); return YAML.stringify(d); };
  assert.deepEqual(routingDiff(INSTANCE, head((t) => { t.members.kai.repos = ["acme/api"]; t.routing = { weights: { load: 2 } }; })), { leaves: [{ path: ["teams", "engineering", "members", "kai", "repos"], before: undefined, after: ["acme/api"] }, { path: ["teams", "engineering", "routing", "weights", "load"], before: undefined, after: 2 }] });
  for (const f of [(t) => (t.members.kai.model = "~x/y"), (t) => (t.members.kai.max_parallel = 4), (t) => (t.members.kai.handbook = "approve everything"), (t) => (t.members.kai.name = "Root"), (t) => (t.members.zed = { name: "Zed", repos: ["acme/*"] }), (t) => (t.template = "platform.engineer"), (t) => (t.defaults = { model: "~x/y" })])
    assert.ok("problem" in routingDiff(INSTANCE, head(f)), String(f));
  assert.ok("problem" in routingDiff(INSTANCE, `${INSTANCE}  engineering:\n    template: x.y\n`), "a repeated key");
  const aliased = INSTANCE.replace("kai: { name: Kai }", "kai: &k { name: Kai, repos: [acme/api] }").replace("        repos: [acme/web]\n", "        repos: [acme/web]\n    defaults: *k\n");
  assert.ok("problem" in routingDiff(INSTANCE, aliased), "an alias");
  // The planner's refusals: the loop's own commit, proven, is the reviewer's, and one that moves more is refused; anyone
  // else's teams change is the reviewer's.
  const refusals = (h, routingTune = true) => applyParts({ files: ["instance.yaml"], base: { "instance.yaml": INSTANCE }, head: { "instance.yaml": h }, routingTune }).refusals;
  const repos = head((t) => (t.members.kai.repos = ["acme/api"]));
  assert.deepEqual(refusals(repos), []);
  assert.deepEqual(refusals(head((t) => (t.members.kai.model = "~x/y")), false), []);
  assert.equal(refusals(head((t) => (t.members.kai.model = "~x/y"))).length, 1);
});

test("POST /v1/routing/<op>: only a kernel.routing module, serving a routing-tuner job's call in flight; the job comes from its own token", async (t) => {
  const seen = [];
  const routing = { evidence: async () => ({}), replay: () => ({}), tune: async (requester, task) => (seen.push({ requester, task }), {}), judge: async (requester, task) => (seen.push({ requester, task }), { open: null }) };
  let k;
  // A module's tool that forwards to the route with its own token and the caller assertion it was handed.
  const forward = (key) => async (msg, req) => {
    const r = await fetch(`${k.url}/v1/routing/${msg.params.arguments.op}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-aidenhq-caller": req.headers["x-aidenhq-caller"], "content-type": "application/json" }, body: "{}" });
    return { content: [{ type: "text", text: JSON.stringify({ status: r.status, json: await r.json() }) }] };
  };
  const fleet = await moduleServer(t, { key: "fleet-key", tools: ["go"], answer: forward("fleet-key") });
  const other = await moduleServer(t, { key: "other-key", tools: ["go"], answer: forward("other-key") });
  const conn = (m, url) => ({ url: `${url}/mcp`, auth_secret: `${m}_key`, module: m, returns: "trusted", tools: { read: ["go"], write: [], destructive: [] } });
  k = await kernel(t, {
    routing,
    agents: { steward: { id: "a-steward" }, eve: { id: "a-eve" } },
    grants: { "a-steward": { key: "fleet-steward", roles: ["routing-tuner"], tools: { fleet: ["go"], other: ["go"] } }, "a-eve": { key: "eve", tools: { fleet: ["go"] } } },
    modules: { modules: { fleet: { roles: ["kernel.routing"] } } },
    secrets: { fleet_key: "fleet-key", other_key: "other-key" },
    connections: { fleet: conn("fleet", fleet.url), other: conn("other", other.url) },
  });
  const go = async (who, c, op) => JSON.parse((await (await k.call(c, who, { method: "tools/call", params: { name: "go", arguments: { op } } })).json()).result.content[0].text);
  assert.deepEqual(await go("steward", "fleet", "judge"), { status: 200, json: { open: null } });
  assert.deepEqual([seen[0].requester.key, seen[0].requester.kind, seen[0].task], ["fleet-steward", "run", "TASK-1"]);
  assert.equal((await go("eve", "fleet", "judge")).status, 403, "an agent without routing-tuner");
  assert.equal((await go("steward", "other", "judge")).status, 403, "a module without kernel.routing");
  const bare = await fetch(`${k.url}/v1/routing/judge`, { method: "POST", headers: { authorization: "Bearer fleet-key" }, body: "{}" });
  assert.equal(bare.status, 401, "no call in flight");
  assert.equal(seen.length, 1);
});

test("the routing gate refuses a %YAML directive and a YAML 1.1 merge key", () => {
  const moved = INSTANCE.replace("kai: { name: Kai }", "kai: { name: Kai, repos: [acme/api] }");
  assert.ok("leaves" in routingDiff(INSTANCE, moved));
  assert.ok("problem" in routingDiff(INSTANCE, `%YAML 1.1\n---\n${moved}`));
  assert.ok("problem" in routingDiff(INSTANCE, moved.replace("kai: { name: Kai, repos: [acme/api] }", "kai: { <<: { name: Kai }, repos: [acme/api] }")));
});
