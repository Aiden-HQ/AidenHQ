// The board reaches the control plane only through the kernel (cp.ts createBoardCp): its key on the kernel, its own lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel } from "./helpers.ts";

test("the board reads and writes as the owner through the kernel, only on its lists, with the admin logged", async (t) => {
  const k = await kernel(t);
  const at = (method, path, { token = "the-boards-key", body, headers = {} } = {}) =>
    fetch(`${k.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body } : {}) });

  // A comment an admin other than the owner wrote: posted with the owner key only the kernel holds, the admin logged.
  const c = await at("POST", "/v1/cp/owner/api/issues/issue-1/comments", { body: JSON.stringify({ body: "hi" }), headers: { "x-aidenhq-account": "acct_2" } });
  assert.equal(c.status, 200);
  const sent = k.control.at(-1);
  assert.deepEqual([sent.method, sent.url, sent.auth, JSON.parse(sent.body).body], ["POST", "/api/issues/issue-1/comments", "board-key", "hi"]);
  assert.ok(k.log.some((l) => l.msg === "cp owner" && l.account === "acct_2" && l.path === "/api/issues/issue-1/comments"));

  // A read passes its query; an upload passes its own content type.
  assert.equal((await at("GET", "/v1/cp/read/api/companies/co-1/issues?status=todo")).status, 200);
  assert.equal(k.control.at(-1).url, "/api/companies/co-1/issues?status=todo");
  const form = new FormData();
  form.append("file", new Blob(["x"], { type: "text/plain" }), "a.txt");
  assert.equal((await fetch(`${k.url}/v1/cp/owner/api/companies/co-1/issues/issue-1/attachments`, { method: "POST", headers: { authorization: "Bearer the-boards-key" }, body: form })).status, 200);
  assert.match(k.control.at(-1).body, /filename="a.txt"/);

  const before = k.control.length;
  // Off its lists, or the wrong method for the lane: refused before the control plane hears of it.
  assert.equal((await at("POST", "/v1/cp/owner/api/agents/a-1/keys", { body: "{}" })).status, 403);
  assert.equal((await at("PATCH", "/v1/cp/owner/api/agents/a-1", { body: "{}" })).status, 403);
  assert.equal((await at("GET", "/v1/cp/owner/api/issues/issue-1")).status, 403);
  assert.equal((await at("GET", "/v1/cp/read/api/companies/co-1/secrets")).status, 403);
  // No key, or another's: refused.
  assert.equal((await at("POST", "/v1/cp/owner/api/issues/issue-1/comments", { token: "", body: "{}" })).status, 401);
  assert.equal((await at("POST", "/v1/cp/owner/api/issues/issue-1/comments", { token: "the-runners-key", body: "{}" })).status, 401);
  assert.equal(k.control.length, before);
  // (A read with another bearer is a module's read: the module routes refuse it.)
  assert.equal((await at("GET", "/v1/cp/read/api/issues/issue-1", { token: "the-runners-key" })).status, 401);
});

test("an owner change to a task is observed with its admin as the actor; a failed observe leaves the write standing", async () => {
  const { createBoardCp } = await import("../src/cp.ts");
  const { Readable } = await import("node:stream");
  const seen = [], log = [];
  const fetch = async () => new Response(JSON.stringify({ id: "t1", assigneeUserId: "u1" }), { status: 200, headers: { "content-type": "application/json" } });
  const call = async (observe, headers) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ comment: "x" }))]), { method: "PATCH", headers });
    let out;
    const res = { writeHead: (s) => ((out = s), res), end: () => {} };
    await createBoardCp({ controlUrl: "http://cp", key: () => "k", fetch, observe, log: (m) => log.push(m) })(req, res, "owner", "/api/issues/t1", "");
    return out;
  };
  assert.equal(await call(async (i, actor) => void seen.push([i.id, actor]), { "x-aidenhq-account": "acct_2" }), 200);
  assert.deepEqual(seen, [["t1", "account:acct_2"]]);
  assert.equal(await call(async () => { throw new Error("no"); }, {}), 200);
  assert.ok(log.includes("observe failed"));
});

test("an owner's comment through the proxy is a task.commented fact at its own time, whoever holds the task", async () => {
  const { createBoardCp } = await import("../src/cp.ts");
  const { Readable } = await import("node:stream");
  const recorded = [];
  const fetch = async () => new Response(JSON.stringify({ id: "c9", createdAt: "2026-11-20T10:00:00.000Z" }), { status: 201, headers: { "content-type": "application/json" } });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ body: "keep v1" }))]), { method: "POST", headers: { "x-aidenhq-account": "acct_2" } });
  const res = { writeHead: () => res, end: () => {} };
  await createBoardCp({ controlUrl: "http://cp", key: () => "k", fetch, facts: { record: (f) => void recorded.push(f) } })(req, res, "owner", "/api/issues/t1/comments", "");
  assert.deepEqual(recorded.map((f) => [f.type, f.task, f.version, f.at, f.actor, f.data]), [["task.commented", "t1", "c9", "2026-11-20T10:00:00.000Z", "account:acct_2", { kind: "comment" }]]);
});

test("a routine the board makes for a recurring task is recorded as the owner's; other routines aren't", async () => {
  const { createBoardCp } = await import("../src/cp.ts");
  const made = [];
  const cp = createBoardCp({ controlUrl: "http://cp.test", key: () => "k", fetch: async () => new Response(JSON.stringify({ id: "r-9" }), { status: 201 }), onRoutine: (id) => made.push(id) });
  const post = (title) => cp({ method: "POST", headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ title })); } }, { writeHead() { return { end() {} }; } }, "owner", "/api/companies/11111111-1111-1111-1111-111111111111/routines", "");
  await post("Repeats: PEN-1");
  await post("Heartbeat: x");
  assert.deepEqual(made, ["r-9"]);
});
