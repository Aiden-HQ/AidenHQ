// Records for every write (spec §5.2-§5.4), end to end through the proxy: a fixture module with a write kind and an executor
// served by the SDK (the twin), a conn.tool write and a destructive tool, and the board-only decide and review routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serveExecutor } from "../sdk/src/executor.ts";
import { verifyCaller } from "../sdk/src/caller.ts";
import { kernel, moduleServer, readBody, serve } from "./helpers.mjs";

// A run's JWT (its run id names the task, TASK-1, through the fake control plane).
const jwt = (run, who) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ run_id: run, who })).toString("base64url")}.sig`;
const ADA = jwt("run-1", "ada"), BO = jwt("run-2", "bo");
const agents = { [ADA]: { id: "ag-ada", name: "Ada" }, [BO]: { id: "ag-bo", name: "Bo" } };
const TOOLS = ["note_read", "post_note", "ping", "note_write", "note_drop"];
const grants = { "ag-ada": { key: "ada", roles: [], tools: { twin: TOOLS } }, "ag-bo": { key: "bo", roles: [], tools: { twin: ["note_read"] } } };
const secrets = { twin_service_key: "twin-key", other_service_key: "other-key" };
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
const text = async (r) => (await r.json()).result.content[0].text;

async function twin(t, { satisfied } = {}) {
  const fx = { plans: [], executes: [], target: "c1", satisfied: false, ...(satisfied ? { satisfied } : {}) };
  let handler = () => false;
  const ex = await serve(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
  t.after(() => ex.s.close());
  const mod = await moduleServer(t, { key: "twin-key", tools: TOOLS, answer: (msg) => ({ content: [{ type: "text", text: `${msg.params.name} done` }] }) });
  const executor = { url: `${ex.url}/aidenhq/v1/executor`, auth_secret: "twin_service_key" };
  const k = await kernel(t, {
    agents, grants, secrets,
    connections: {
      twin: { url: `${mod.url}/mcp`, auth_secret: "twin_service_key", module: "twin", returns: "untrusted", tools: { read: ["note_read"], write: ["post_note", "ping", "note_write"], destructive: ["note_drop"] } },
      other: { url: `${mod.url}/mcp`, auth_secret: "other_service_key", module: "other", returns: "untrusted", tools: { read: [], write: [], destructive: [] } },
    },
    writes: {
      "twin.post": { module: "twin", floor: 1, tools: ["twin.post_note"], card: { sentence: "Post {{note}}.", details: "note: {{note}}\ntarget: {{target}}" }, executor,
        args: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", maxLength: 100 } } } },
      "twin.ping": { module: "twin", floor: 0, tools: ["twin.ping"], executor },
    },
  });
  handler = serveExecutor({
    plan: async (req) => {
      fx.plans.push(req);
      if (fx.satisfied) return { args: { note: String(req.args.note) }, satisfied: { evidence: fx.satisfied } };
      if (req.kind === "twin.ping") return { args: {} };
      return { args: { note: String(req.args.note ?? "") }, targets: { commit: fx.target }, card: { target: fx.target } };
    },
    execute: async (rec) => (fx.executes.push(rec), { ok: true, text: `posted ${rec.args.note ?? "ping"}` }),
  }, { key: "twin-key", kernelUrl: k.url });
  const tool = (name, args = {}, token = ADA) => k.call("twin", token, { method: "tools/call", params: { name, arguments: args } });
  const pending = async (r) => JSON.parse((await text(r)).split("\n")[0]);
  return { k, fx, mod, tool, pending, moduleCalls: () => mod.seen.filter((s) => s.method === "tools/call").map((s) => s.name) };
}

test("the executor sees nothing before approval; approved, it runs once and the task hears the outcome", async (t) => {
  const { k, fx, tool, pending, moduleCalls } = await twin(t);
  const p = await pending(await tool("post_note", { note: "hi" }));
  assert.deepEqual({ tier: p.tier, state: p.state }, { tier: 1, state: "review" });
  assert.match(p.approval, /^k-[0-9a-f]{16}$/);
  // Plan only: nothing executed, and the tool never reached the module.
  assert.equal(fx.plans.length, 1);
  assert.equal(fx.plans[0].requester.agent, "ag-ada");
  assert.equal(fx.plans[0].task, "TASK-1");
  assert.equal(fx.executes.length, 0);
  assert.deepEqual(moduleCalls(), []);
  const rec = k.records.get(p.approval);
  assert.equal(rec.card.sentence, "Post hi.");
  // Only the board's key lists and decides; the reviewer's verdict is bound to the digest.
  assert.equal((await k.v1("GET", "/v1/writes?state=review", undefined, ADA)).status, 401);
  assert.deepEqual((await k.v1("GET", "/v1/writes?state=review")).json.records.map((r) => r.id), [p.approval]);
  const verdict = { digest: rec.digest, decision: "approve", reason: "fine", model: "~acme/model-a" };
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/review`, verdict, ADA)).status, 401);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/review`, { ...verdict, digest: "0".repeat(64) })).status, 409);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/review`, verdict)).json.state, "approved");
  await until(() => k.records.get(p.approval).state === "done");
  // Revalidated (plan again) before the one execute, keyed by the record id.
  assert.equal(fx.plans.at(-1).revalidate, true);
  assert.deepEqual(fx.executes.map((e) => [e.id, e.idempotency_key, e.args.note]), [[p.approval, p.approval, "hi"]]);
  await until(() => k.notices.length === 1);
  assert.equal(k.notices[0].task, "TASK-1");
  assert.match(k.notices[0].text, /^\*\*Done\*\* \(approval k-[0-9a-f]{16}, twin\.post\)[\s\S]*```\nposted hi\n```/);
  // Decided once: a replayed verdict or outcome changes nothing.
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/review`, verdict)).status, 409);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/outcome`, { ok: false, text: "again" }, "twin-key")).status, 409);
  assert.equal(fx.executes.length, 1);
  // Its requester reads its own record; another agent can't, nor can another module report its outcome.
  assert.equal((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, ADA)).json.state, "done");
  assert.equal((await k.v1("GET", `/v1/writes/${p.approval}`, undefined, BO)).status, 404);
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/outcome`, { ok: true, text: "x" }, "other-key")).status, 403);
  // POST /v1/writes: an agent's record is on its own run's task, whatever task it names; no grant on the kind, no record.
  const filed = await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "x" }, task: "OTHER-9" }, ADA);
  assert.equal(k.records.get(filed.json.id).task, "TASK-1");
  assert.equal((await k.v1("POST", "/v1/writes", { kind: "twin.post", args: { note: "x" } }, BO)).status, 403);
});

test("a changed target on revalidate gives stale and a refile; the owner's decision comes only from the board, stamped as one", async (t) => {
  const { k, fx, tool, pending } = await twin(t);
  const p = await pending(await tool("post_note", { note: "a" }));
  // The same request again while it is open is that record, never a second card.
  assert.equal((await pending(await tool("post_note", { note: "a" }))).approval, p.approval);
  const rec = k.records.get(p.approval);
  // The reviewer escalates: the owner decides (Tier 2), never with a reviewer's or the code's stamp.
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/review`, { digest: rec.digest, decision: "escalate", reason: "owner's", model: "~acme/model-a" })).json.state, "owner");
  const decide = { digest: rec.digest, decision: "approve", by: "owner:chat", via: "chat" };
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/decide`, decide, "twin-key")).status, 401);
  for (const by of ["reviewer:~acme/model-a", "kernel", "auto:x", ""]) assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/decide`, { ...decide, by })).status, 409);
  fx.target = "c2"; // what it acts on moves after the card was filed
  assert.equal((await k.v1("POST", `/v1/writes/${p.approval}/decide`, decide)).json.decided_by, "owner:chat");
  await until(() => k.records.get(p.approval).state === "stale");
  assert.equal(fx.executes.length, 0);
  const refiled = k.records.list(["review"]);
  assert.equal(refiled.length, 1);
  assert.notEqual(refiled[0].id, p.approval);
  assert.equal(refiled[0].targets.commit, "c2");
  await until(() => k.notices.some((n) => n.text.startsWith("**Stale**") && n.text.includes(refiled[0].id)));
  // An open request re-filed after the owner's no on its kind is never reused at its old tier: it is cancelled and refiled at Tier 2.
  const open1 = await pending(await tool("post_note", { note: "v" }));
  const veto = await pending(await tool("post_note", { note: "w" }));
  const vr = k.records.get(veto.approval);
  await k.v1("POST", `/v1/writes/${veto.approval}/review`, { digest: vr.digest, decision: "escalate", reason: "r", model: "~acme/model-a" });
  await k.v1("POST", `/v1/writes/${veto.approval}/decide`, { ...decide, digest: vr.digest, decision: "reject" });
  const again = await pending(await tool("post_note", { note: "v" }));
  assert.notEqual(again.approval, open1.approval);
  assert.equal(again.tier, 2);
  assert.equal(k.records.get(open1.approval).state, "cancelled");
  assert.equal((await pending(await tool("post_note", { note: "v" }))).approval, again.approval);
  // The owner's no on a kind makes the next request on the task theirs (Tier 2), the reviewer still first.
  const next = k.records.get(refiled[0].id);
  await k.v1("POST", `/v1/writes/${next.id}/review`, { digest: next.digest, decision: "escalate", reason: "r", model: "~acme/model-a" });
  await k.v1("POST", `/v1/writes/${next.id}/decide`, { ...decide, digest: next.digest, decision: "reject" });
  assert.equal((await pending(await tool("post_note", { note: "b" }))).tier, 2);
});

test("a Tier 0 conn.tool call leaves a completed record whose outcome is the MCP result; a Tier 0 kind answers with its outcome", async (t) => {
  const { k, fx, tool, moduleCalls } = await twin(t);
  const r = await tool("note_write", { text: "x" });
  assert.match(await text(r), /UNTRUSTED CONTENT from twin\.note_write[\s\S]*note_write done/);
  const [rec] = k.records.list(["done"]);
  assert.equal(rec.kind, "conn.tool");
  assert.equal(rec.tier, 0);
  assert.deepEqual(rec.args, { connection: "twin", tool: "note_write", arguments: { text: "x" } });
  assert.match(rec.outcome.text, /note_write done/);
  assert.equal(rec.outcome.ok, true);
  // A read is no record.
  await tool("note_read");
  assert.equal(k.records.list(["done"]).length, 1);
  // A Tier 0 kind runs at once through its executor; the caller gets the outcome, fenced.
  assert.match(await text(await tool("ping")), /UNTRUSTED CONTENT from twin\.ping[\s\S]*posted ping/);
  assert.equal(fx.executes.length, 1);
  assert.deepEqual(moduleCalls(), ["note_write", "note_read"]);
  // A tool the caller isn't granted is refused before any record.
  assert.equal((await (await tool("note_write", {}, BO)).json()).error.message, "no-grant");
  assert.equal(k.records.list(["done", "review", "claimed"]).length, 2);
});

test("satisfied posts its evidence and files no card", async (t) => {
  const { k, fx, tool } = await twin(t, { satisfied: "the note is already there" });
  assert.match(await text(await tool("post_note", { note: "hi" })), /Nothing to do: the note is already there/);
  assert.deepEqual(k.records.list(["review", "owner"]), []);
  assert.equal(k.records.list(["done"])[0].kind, "twin.post");
  assert.equal(fx.executes.length, 0);
});

test("a destructive tool with no kind is conn.tool at Tier 1: replayed once, as its requester, only after approval", async (t) => {
  const { k, mod, tool, pending, moduleCalls } = await twin(t);
  const p = await pending(await tool("note_drop", { id: 7 }));
  assert.equal(p.tier, 1);
  assert.deepEqual(moduleCalls(), []);
  const rec = k.records.get(p.approval);
  await k.v1("POST", `/v1/writes/${p.approval}/review`, { digest: rec.digest, decision: "approve", reason: "ok", model: "~acme/model-a" });
  await until(() => k.records.get(p.approval).state === "done");
  assert.deepEqual(moduleCalls(), ["note_drop"]);
  const s = mod.seen.at(-1);
  assert.equal(s.auth, "Bearer twin-key");
  assert.equal(JSON.parse(s.raw).params.arguments.id, 7);
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": s.caller } }, k.jwks, "twin");
  assert.deepEqual([caller.agent, caller.key, caller.task, caller.tool], ["ag-ada", "ada", "TASK-1", "twin.note_drop"]);
  // The owner's no on that tool makes it theirs on the task; the task's other writes stay Tier 0.
  const q = await pending(await tool("note_drop", { id: 8 }));
  const qr = k.records.get(q.approval);
  await k.v1("POST", `/v1/writes/${q.approval}/review`, { digest: qr.digest, decision: "escalate", reason: "r", model: "~acme/model-a" });
  await k.v1("POST", `/v1/writes/${q.approval}/decide`, { digest: qr.digest, decision: "reject", by: "owner:chat", via: "chat" });
  assert.equal((await pending(await tool("note_drop", { id: 9 }))).tier, 2);
  assert.match(await text(await tool("note_write", { text: "y" })), /note_write done/);
});

test("a replace with a claimed record reconciles it before A stops: its executor's status settles it, open ones are cancelled", async (t) => {
  const status = [];
  const ex = await serve(async (req, res) => {
    const b = JSON.parse(await readBody(req));
    status.push(b.id);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b.id === done ? { state: "done", text: "it went through" } : { state: "unknown" }));
  });
  t.after(() => ex.s.close());
  const k = await kernel(t, { secrets, connections: {}, writes: { "a.post": { module: "a", floor: 1, tools: [], executor: { url: `${ex.url}/x`, auth_secret: "twin_service_key" } } } });
  const base = { kind: "a.post", module: "a", args: {}, targets: {}, executor: { module: "a", url: `${ex.url}/x` }, policy: "", card: { sentence: "", changes: "", reads: "", cost: "", details: "" }, requester: { agent: "", key: "", name: "", roles: [], kind: "run" }, task: "TASK-1", tier: 1, panel: false };
  const done = k.records.file({ ...base, state: "claimed" }).id;
  const lost = k.records.file({ ...base, state: "claimed" }).id;
  const open = k.records.file({ ...base, state: "review" }).id;
  const other = k.records.file({ ...base, kind: "b.post", module: "b", state: "review" }).id;
  assert.deepEqual(await k.writes.reconcile(["a"]), [`${lost} a.post unknown`]);
  assert.deepEqual(status.sort(), [done, lost].sort());
  assert.deepEqual([done, lost, open, other].map((id) => k.records.get(id).state), ["done", "unknown", "cancelled", "review"]);
  assert.equal(k.records.get(done).outcome.text, "it went through");
});

test("another requester's identical request is its own record, and a stricter refile never cancels an approved one", async (t) => {
  const { k, tool, pending } = await twin(t);
  const a = await pending(await tool("post_note", { note: "same" }));
  // Cy files the same request on the same task: its own record; Ada's is untouched.
  const cy = { kind: "run", agent: "ag-cy", key: "cy", name: "Cy", roles: [], tools: { twin: ["post_note"] }, task: "TASK-1", credential: "" };
  const c = await k.writes.request(cy, { kind: "twin.post", args: { note: "same" } });
  assert.notEqual(c.id, a.approval);
  assert.equal(k.records.get(a.approval).state, "review");
  assert.equal((await k.writes.request(cy, { kind: "twin.post", args: { note: "same" } })).id, c.id);
  // An approved record (here one a restart left unclaimed) stays approved when a stricter refile comes after the owner's no.
  const ar = k.records.get(a.approval);
  const approved = k.records.file({ ...ar, state: "approved" });
  const veto = k.records.file({ ...ar, args: { note: "other" }, state: "owner", tier: 2 });
  k.records.decide(veto.id, veto.digest, "reject", "owner:chat", "chat");
  const again = await pending(await tool("post_note", { note: "same" }));
  assert.equal(again.tier, 2);
  assert.equal(k.records.get(approved.id).state, "approved");
  assert.equal(k.records.get(c.id).state, "review");
});
