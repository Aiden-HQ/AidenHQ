// The board reaches the control plane only through the kernel (cp.ts createBoardCp): its key on the kernel, its own lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kernel } from "./helpers.mjs";

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
