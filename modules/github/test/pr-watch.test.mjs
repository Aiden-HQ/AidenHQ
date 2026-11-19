// The product-PR watcher end to end against a fake GitHub and a fake kernel (ported from the runner's flow-product cases):
// a Dependabot PR becomes one task for the platform-engineer role once its checks finish, and that task closes when the PR is
// gone; an agent's PR (one this service opened) that conflicts with main wakes its task once, with fixed text only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notePrTask, startPrWatch } from "../service/src/pr-watch.ts";

const listen = (handler) => new Promise((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const checks = (status) => ({ state: status === "PENDING" ? "PENDING" : "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "test", status: status === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: status === "PENDING" ? null : "SUCCESS" }] } });
const pr = (n, o = {}) => ({ number: n, url: `https://github.com/acme/app/pull/${n}`, isDraft: false, mergeable: "MERGEABLE", isCrossRepository: false, headRefName: `b${n}`, headRefOid: `h${n}`, author: { __typename: "Bot", login: "dependabot" }, commits: { nodes: [{ commit: { statusCheckRollup: checks(o.checks ?? "SUCCESS") } }] }, ...o });

test("a Dependabot PR becomes one task once its checks finish and closes with it; a conflicting agent PR wakes its task once", async (t) => {
  let open = [];
  let mainOid = "m1";
  const calls = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    if (req.url === "/v1/tasks") return res.writeHead(200).end(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", identifier: "ACME-1", agent: "pe", deduplicated: false }));
    if (req.url === "/v1/wakes") return res.writeHead(200).end(JSON.stringify({ posted: true }));
    res.writeHead(200).end(JSON.stringify({ status: "done" }));
  });
  t.after(() => kernel.s.close());
  const gh = async (method, path, token, body) => {
    if (path === "/graphql") return { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: mainOid, statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } };
    if (path.startsWith("/repos/acme/app/compare/")) return { status: 200, body: { behind_by: 3 } };
    return { status: 404, body: {} };
  };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir, app: { token: async () => "tok" }, gh });
  t.after(() => watch.stop());
  const made = () => calls.filter((c) => c.url === "/v1/tasks");
  const wakes = () => calls.filter((c) => c.url === "/v1/wakes");

  open = [pr(10, { checks: "PENDING" })];
  await watch.tick();
  assert.equal(made().length, 0, "not while its checks run");
  open = [pr(10)];
  await watch.tick();
  await watch.tick();
  assert.equal(made().length, 1, "filed once");
  assert.equal(made()[0].auth, "Bearer k");
  assert.deepEqual([made()[0].body.role, made()[0].body.source, made()[0].body.title], ["platform-engineer", "dependabot:acme/app/10", "Dependabot PR acme/app#10"]);
  assert.match(made()[0].body.description, /pull\/10/);

  open = [];
  await watch.tick();
  const close = calls.find((c) => c.url === "/v1/tasks/11111111-1111-4111-8111-111111111111/close");
  assert.equal(close?.body.status, "done");

  // An agent's PR the service opened for task ACME-7 now conflicts with main.
  notePrTask(cacheDir, "https://github.com/acme/app/pull/9", { task: "ACME-7", branch: "b9" });
  open = [pr(9, { author: { __typename: "Bot", login: "aidenhq" }, mergeable: "CONFLICTING" })];
  await watch.tick();
  assert.equal(wakes().length, 1);
  assert.equal(wakes()[0].body.task, "ACME-7");
  assert.match(wakes()[0].body.text, /pull\/9 now conflicts with `main`/);
  await watch.tick();
  mainOid = "m2"; // main moved: still under half an hour since the last ask
  await watch.tick();
  assert.equal(wakes().length, 1, "once per head of main and half hour");
});

test("an agent's green mergeable PR wakes its task to merge once per head", async (t) => {
  let open = [];
  const wakes = [];
  const kernel = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/v1/wakes") wakes.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
  t.after(() => kernel.s.close());
  const gh = async (m, path) => path === "/graphql"
    ? { status: 200, body: { data: { repository: { defaultBranchRef: { name: "main", target: { oid: "m1", statusCheckRollup: checks("SUCCESS") } }, pullRequests: { nodes: open } } } } }
    : { status: 404, body: {} };
  const cacheDir = mkdtempSync(join(tmpdir(), "pr-watch-"));
  const watch = startPrWatch({ repo: "acme/app", kernelUrl: kernel.url, key: "k", cacheDir, app: { token: async () => "tok" }, gh });
  t.after(() => watch.stop());
  notePrTask(cacheDir, "https://github.com/acme/app/pull/5", { task: "ACME-5", branch: "b5" });
  const agent = { author: { __typename: "Bot", login: "aidenhq" } };

  open = [pr(5, { ...agent, checks: "PENDING" })];
  await watch.tick();
  assert.equal(wakes.length, 0, "not while checks run");
  open = [pr(5, agent)];
  await watch.tick();
  await watch.tick();
  assert.equal(wakes.length, 1, "once per head");
  assert.equal(wakes[0].task, "ACME-5");
  assert.match(wakes[0].text, /aidenhq merge https:\/\/github.com\/acme\/app\/pull\/5 h5/);
});
