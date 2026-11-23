// Connect on first use, end to end through the tool proxy (proxy.ts → connection-state.ts → notify, waits, wakes): the
// owner's own request gets one message and its task resumes once connected; background work gets one digest line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsOwner, signedIn } from "../sdk/src/vendor/needs.ts";
import { openFacts } from "../src/facts.ts";
import { kernel, moduleServer } from "./helpers.ts";

const AGENT = "ag-cos";
const conn = (url, returns = "untrusted") => ({ url: `${url}/mcp`, auth_secret: "google_service_key", module: "google", returns, tools: { read: ["gmail_search"], write: [], destructive: [] }, health_probes: { gmail: { tool: "gmail_search", args: { query: "in:inbox" } } } });
const modules = { modules: { "owner-channel": { roles: ["kernel.notify"], token: "router_token" }, dispatch: { roles: ["kernel.jobs"], token: "dispatch_token" } } };
const secrets = { google_service_key: "google-key", router_token: "router-key", dispatch_token: "dispatch-key" };
const grants = { [AGENT]: { key: "cos", tools: { google_workspace: ["gmail_search"] } } };
// WOR-1: the owner's chat (their comment); WOR-2: the job's task, its child. WOR-9: a routine's run (no owner words).
const issues = {
  w1: { id: "w1", identifier: "WOR-1", title: "What's in my inbox?", status: "in_progress", assigneeAgentId: AGENT },
  w2: { id: "w2", identifier: "WOR-2", title: "Read the owner's inbox", status: "in_progress", parentId: "w1", assigneeAgentId: AGENT },
  w9: { id: "w9", identifier: "WOR-9", title: "Morning brief", status: "in_progress", assigneeAgentId: AGENT },
};
const comments = { w1: [{ body: "what's in my inbox?", authorUserId: "u1", createdAt: "2026-11-20T09:00:00Z" }] };
const onControl = async (req) => {
  const m = /^\/api\/issues\/([^/?]+)\/comments/.exec(req.url ?? "");
  return m ? { body: comments[m[1]] ?? [] } : undefined;
};

async function setup(t, { answer, returns, task = "w2" }) {
  const google = await moduleServer(t, { key: "google-key", tools: ["gmail_search"], answer });
  const k = await kernel(t, { connect: true, agents: { run: { id: AGENT, task } }, grants, connections: { google_workspace: conn(google.url, returns) }, modules, secrets, issues, onControl });
  const call = async () => (await (await k.call("google_workspace", "run", { method: "tools/call", params: { name: "gmail_search", arguments: { query: "in:inbox" } } })).json());
  const take = async () => (await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages;
  // The task's own history, as the kernel's scan records it: an agent-held task in progress.
  const facts = openFacts(k.records.db);
  const at = new Date().toISOString();
  for (const [type, data] of [["task.created", { parent: null, identifier: issues[task].identifier }], ["task.status_changed", { from: null, to: "in_progress" }], ["task.assignee_changed", { from: null, to: AGENT }]])
    facts.record({ type, subject: `task:${task}`, version: `${type}@0`, at, actor: "unknown", task, data });
  const wakeRows = () => k.records.db.prepare("SELECT key, cause, state FROM wakes ORDER BY key").all();
  return { k, google, call, take, wakeRows };
}

test("owner-asked: Gmail missing → one message → connect → the task resumes", async (t) => {
  const w = await setup(t, { answer: () => needsOwner({ cause: "not_connected", detail: "no account" }) });
  const r = await w.call();
  const text = r.result.content[0].text;
  assert.equal(r.result.isError, true);
  assert.match(text, /the owner has the link/);
  assert.ok(!text.includes("<untrusted") && !text.includes("no account"), text);
  const taken = await w.take();
  assert.equal(taken.length, 1);
  assert.equal(taken[0].kind, "decision");
  assert.equal(taken[0].task, "WOR-1");
  assert.match(taken[0].text, /http:\/\/board\.example\/connect\/google/);
  await w.call();
  assert.equal((await w.take()).length, 0, "no second message");
  const state = w.k.taskStates.read({ ids: ["w2"] }).tasks[0];
  assert.equal(state.kind, "waiting");
  assert.equal(state.reason, "agent_wait");
  assert.deepEqual((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down.map((d) => [d.connection, d.module, d.cause]), [["google_workspace", "google", "not_connected"]]);
  assert.deepEqual((await w.k.v1("GET", "/v1/connections/needs", undefined, "router-key")).json.lines, ["Google isn't connected (not connected): http://board.example/connect/google"]);
  assert.equal((await w.k.v1("GET", "/v1/connections/needs", undefined, "dispatch-key")).status, 403, "the owner's router only");
  assert.equal((await w.k.v1("POST", "/v1/connections/google/ok", {}, "dispatch-key")).status, 401, "the board's key only");
  assert.equal((await w.k.v1("POST", "/v1/connections/nope/ok", {})).status, 404);
  assert.deepEqual((await w.k.v1("POST", "/v1/connections/google/ok", {})).json, { woken: 1 });
  const rows = w.wakeRows().filter((x) => x.state === "open");
  assert.ok(rows.some((x) => x.key.startsWith("connect:google_workspace:w2:") && x.cause === "connected"), JSON.stringify(rows));
  assert.ok(!rows.some((x) => x.key.startsWith("wait:")), JSON.stringify(rows));
  assert.deepEqual((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down, []);
});

test("a health probe feeds the connection state like a live call: a need is recorded, a signed-in success clears it (0e4e0ed2)", async (t) => {
  let answer = () => needsOwner({ cause: "not_connected", detail: "no account" });
  const w = await setup(t, { answer: () => answer() });
  const probe = async () => (await fetch(`${w.k.url}/v1/health/probe`, { method: "POST", headers: { "x-health-key": "the-health-key", "content-type": "application/json" }, body: JSON.stringify({ probe: "gmail" }) })).json();
  const rows = () => w.k.records.db.prepare("SELECT key FROM connection_state").all().map((r) => r.key);
  assert.equal((await probe()).ok, false);
  assert.deepEqual(rows(), ["google_workspace:not_connected"]);
  answer = () => signedIn({ content: [{ type: "text", text: "ok" }] });
  assert.equal((await probe()).ok, true);
  assert.deepEqual(rows(), []);
});

// #1558: a grant the owner made on GitHub's own page (not the board's Connect) clears the org's restriction. The signed-in
// answer says which orgs its calls proved; that clears those orgs' sso/restricted rows through the proxy, and nothing else.
test("a signed-in success that proved org A clears A's restricted/sso rows only, per org, through the live proxy", async (t) => {
  const module = { kind: "module" as const, module: "github", roles: [], tools: {}, credential: "" };
  let answer = () =>
    needsOwner({ cause: "restricted", org: "acme", url: "https://github.com/settings/connections/applications/x", detail: "acme restricts outside apps" });
  const w = await setup(t, { answer: () => answer() });
  const rows = () => w.k.records.db.prepare("SELECT key FROM connection_state ORDER BY key").all().map((r) => r.key);
  // Two orgs' restrictions and a missing permission record as background needs (no owner chain here).
  await w.call();
  const state = w.k.connectionState;
  await state.hit(module, "google_workspace", { cause: "restricted", org: "globex", url: "https://github.com/settings/connections/applications/x", detail: "" });
  await state.hit(module, "google_workspace", { cause: "sso", org: "acme", url: "https://github.com/orgs/acme/sso", detail: "" });
  await state.hit(module, "google_workspace", { cause: "scope", scope: "read:org", detail: "" });
  assert.deepEqual(rows(), ["google_workspace:restricted:acme", "google_workspace:restricted:globex", "google_workspace:scope:read:org", "google_workspace:sso:acme"]);
  // The next call works: its answer proved acme alone.
  answer = () => signedIn({ content: [{ type: "text", text: "ok" }] }, { orgs: ["acme"] });
  await w.call();
  assert.deepEqual(rows(), ["google_workspace:restricted:globex", "google_workspace:scope:read:org"], "acme cleared; globex and the scope row stay");
});

test("an unreachable connection service (a restart) is a retryable error: no needs_owner and no connection state", async (t) => {
  const k = await kernel(t, { connect: true, agents: { run: { id: AGENT, task: "w9" } }, grants, connections: { google_workspace: conn("http://127.0.0.1:1") }, modules, secrets, issues, onControl });
  const r = await k.call("google_workspace", "run", { method: "tools/call", params: { name: "gmail_search", arguments: { query: "in:inbox" } } });
  assert.ok(r.status >= 500, `status ${r.status}`);
  assert.ok(!(await r.text()).includes("needs_owner"));
  assert.deepEqual(k.records.db.prepare("SELECT key FROM connection_state").all(), []);
  assert.deepEqual((await k.v1("GET", "/v1/notify/take", undefined, "router-key")).json.messages, []);
});
