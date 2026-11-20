// Connect on first use, end to end through the tool proxy (proxy.ts → connection-state.ts → notify, waits, wakes): the
// owner's own request gets one message and its task resumes once connected; background work gets one digest line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsOwner, signedIn } from "../sdk/src/vendor/needs.ts";
import { openFacts } from "../src/facts.ts";
import { kernel, moduleServer } from "./helpers.ts";

const AGENT = "ag-cos";
const conn = (url, returns = "untrusted") => ({ url: `${url}/mcp`, auth_secret: "google_service_key", module: "google", returns, tools: { read: ["gmail_search"], write: [], destructive: [] } });
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
  assert.equal((await w.k.v1("POST", "/v1/connections/google/ok", {}, "dispatch-key")).status, 401, "the board's key only");
  assert.equal((await w.k.v1("POST", "/v1/connections/nope/ok", {})).status, 404);
  assert.deepEqual((await w.k.v1("POST", "/v1/connections/google/ok", {})).json, { woken: 1 });
  const rows = w.wakeRows().filter((x) => x.state === "open");
  assert.ok(rows.some((x) => x.key.startsWith("connect:google:w2:") && x.cause === "connected"), JSON.stringify(rows));
  assert.ok(!rows.some((x) => x.key.startsWith("wait:")), JSON.stringify(rows));
  assert.deepEqual((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down, []);
});

test("background: a routine run hits a missing connection → one batched digest line, no wait", async (t) => {
  const w = await setup(t, { task: "w9", answer: () => needsOwner({ cause: "not_connected", detail: "no account" }) });
  assert.match((await w.call()).result.content[0].text, /Skip this source/);
  await w.call();
  const taken = await w.take();
  assert.equal(taken.length, 1);
  assert.equal(taken[0].kind, "digest");
  assert.equal(taken[0].batch, true);
  assert.notEqual(w.k.taskStates.read({ ids: ["w9"] }).tasks[0]?.reason, "agent_wait");
  assert.equal(w.wakeRows().length, 0);
});

test("a trusted connection's answer passes unchanged, and its needs_owner is still routed", async (t) => {
  let need = false;
  const w = await setup(t, { returns: "trusted", answer: () => (need ? needsOwner({ cause: "expired", detail: "refused" }) : { content: [{ type: "text", text: "3 unread" }], structuredContent: { unread: 3 } }) });
  const res = await w.k.call("google_workspace", "run", { method: "tools/call", params: { name: "gmail_search", arguments: {} } });
  assert.deepEqual(JSON.parse(await res.text()), { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "3 unread" }], structuredContent: { unread: 3 } } }, "byte for byte, structuredContent kept");
  need = true;
  assert.match((await w.call()).result.content[0].text, /^Google isn't connected \(sign-in expired\): the owner has the link/);
  assert.equal((await w.take())[0].kind, "decision");
});

test("an account's served answer clears only that account's expired need, not another account's", async (t) => {
  let mode: "need" | string = "need";
  const w = await setup(t, {
    answer: () => (mode === "need" ? needsOwner({ cause: "expired", detail: "refused", account: "a@example.com" }) : signedIn({ content: [{ type: "text", text: `ok on ${mode}` }] }, mode)),
  });
  await w.call();
  const down = async () => (await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down as { account?: string }[];
  assert.deepEqual((await down()).map((d) => d.account), ["a@example.com"]);
  // b@ serves the next call: a@'s need stays, and the task waiting on it isn't woken.
  mode = "b@example.com";
  assert.match((await w.call()).result.content[0].text, /ok on b@example\.com/);
  assert.deepEqual((await down()).map((d) => d.account), ["a@example.com"]);
  assert.ok(!w.wakeRows().some((x) => x.cause === "connected" && x.state === "open"));
  // a@ serves one: its need clears and the waiting task wakes.
  mode = "a@example.com";
  assert.match((await w.call()).result.content[0].text, /ok on a@example\.com/);
  assert.deepEqual(await down(), []);
  assert.ok(w.wakeRows().some((x) => x.cause === "connected" && x.state === "open"), "the waiting task wakes");
});

test("a successful call clears a full-cause state only when the sign-in served it", async (t) => {
  let answer = "need";
  const w = await setup(t, { answer: () => (answer === "need" ? needsOwner({ cause: "not_connected", detail: "" }) : answer === "link" ? { content: [{ type: "text", text: "a prefilled link" }] } : signedIn({ content: [{ type: "text", text: "ok" }] })) });
  await w.call();
  assert.equal((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down.length, 1);
  // A tool that works signed out (github_issue_link) succeeds without the marker: still down, nobody woken.
  answer = "link";
  assert.match((await w.call()).result.content[0].text, /prefilled link/);
  assert.equal((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down.length, 1);
  assert.ok(!w.wakeRows().some((x) => x.cause === "connected"));
  answer = "ok";
  assert.match((await w.call()).result.content[0].text, /ok/);
  assert.deepEqual((await w.k.v1("GET", `/v1/connections/down?agent=${AGENT}`, undefined, "dispatch-key")).json.down, []);
  assert.ok(w.wakeRows().some((x) => x.cause === "connected" && x.state === "open"), "the waiting task wakes");
});
