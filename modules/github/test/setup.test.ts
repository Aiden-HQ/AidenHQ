// github.setup: the reviewed setup PR (service/src/setup.ts) against a fake GitHub, and the kernel's `setup` op (service.ts) against a fake
// kernel that decides the code host's own record: nothing is written to GitHub unless that record was approved and ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";
import { withActors } from "./actors.ts";
import { serveOps } from "../service/src/ops.ts";
import * as setup from "../service/src/setup.ts";

const HEAD = "a".repeat(40), COMMIT = "d".repeat(40);
const ALLOW = [".deepsec/data/*/INFO.md", ".deepsec/deepsec.config.ts", ".deepsec/package.json"];
const args = (over = {}) => ({ repo: "acme/widgets", files: { ".deepsec/data/w/INFO.md": "# widgets\n", ".deepsec/deepsec.config.ts": "export default {};\n" }, allow: ALLOW, title: "Add deepsec", body: "Setup.", ...over });

/** The record's args as the plan binds them (it adds the reviewed default branch and its head). */
const runOf = (api: any, a: any) => setup.run(api, async () => api, { base: "main", base_head: HEAD, ...a });
const BRANCH = `aidenhq/setup-${COMMIT.slice(0, 12)}`;
const earlierPr = { number: 4, html_url: "https://github.com/acme/widgets/pull/4", title: "Earlier setup", head: { ref: "aidenhq/setup-111111111111", sha: "1".repeat(40), repo: { full_name: "acme/widgets" } }, base: { ref: "main" } };

/** A fake GitHub: the default branch and its head, the files its head has, the open PRs. */
function github(o: { has?: string[]; open?: any[]; def?: string; head?: string } = {}) {
  const writes: { method: string; path: string; body: any }[] = [];
  const api = async (method: string, path: string, body?: any) => {
    if (method !== "GET") writes.push({ method, path, body });
    const miss = () => Promise.reject(new Error(`GitHub ${method} ${path}: 404 Not Found`));
    const def = o.def ?? "main";
    if (path === "/repos/acme/widgets") return { default_branch: def };
    if (path === `/repos/acme/widgets/branches/${def}`) return { commit: { sha: o.head ?? HEAD } };
    if (path.startsWith("/repos/acme/widgets/contents/")) return (o.has ?? []).includes(decodeURIComponent(path.slice("/repos/acme/widgets/contents/".length).split("?")[0]!)) ? { sha: "x" } : miss();
    if (path.startsWith("/repos/acme/widgets/commits/")) return { commit: { tree: { sha: "t".repeat(40) } } };
    if (path.endsWith("/git/trees")) return { sha: "e".repeat(40) };
    if (path.endsWith("/git/commits")) return { sha: COMMIT };
    if (path.includes("/git/refs")) return {};
    if (method === "GET" && path.startsWith("/repos/acme/widgets/pulls")) return o.open ?? [];
    if (path === "/repos/acme/widgets/pulls") return { html_url: "https://github.com/acme/widgets/pull/9", number: 9 };
    if (method === "PATCH" && path.startsWith("/repos/acme/widgets/pulls/")) return {};
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, writes };
}
const calls = (g: { writes: any[] }) => g.writes.map((w) => `${w.method} ${w.path.replace("/repos/acme/widgets", "")}`);

test("one commit of the missing files off the default branch's head, on a branch named from it, then its PR into the default branch", async () => {
  const g = github();
  const out = await runOf(g.api, args());
  assert.deepEqual(JSON.parse(out.text), { pr_url: "https://github.com/acme/widgets/pull/9", branch: BRANCH, tip: COMMIT });
  assert.deepEqual(calls(g), ["POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
  assert.deepEqual(g.writes[1]!.body.parents, [HEAD]);
  assert.match(g.writes[1]!.body.message, /Co-authored-by: AidenHQ/);
  assert.deepEqual(g.writes[2]!.body, { ref: `refs/heads/${BRANCH}`, sha: COMMIT }, "created at the commit, in one call");
  assert.deepEqual([g.writes[3]!.body.head, g.writes[3]!.body.base], [BRANCH, "main"]);
});

test("files the default branch already has are never overwritten; with nothing missing there is no commit, branch or PR", async () => {
  const g = github({ has: [".deepsec/deepsec.config.ts"] });
  await runOf(g.api, args());
  assert.deepEqual(g.writes[0]!.body.tree.map((e: any) => e.path), [".deepsec/data/w/INFO.md"]);
  const none = github({ has: Object.keys(args().files) });
  assert.deepEqual(JSON.parse((await runOf(none.api, args())).text), { pr_url: null, nothing_to_add: true });
  assert.deepEqual(none.writes, []);
  assert.match((await setup.plan(none.api, args())).facts.sentence, /Nothing to do/);
});

test("one PR per repo: an earlier setup PR and its branch are closed once the new one is open", async () => {
  const g = github({ open: [earlierPr, { ...earlierPr, number: 5, head: { ref: "feature/x", repo: { full_name: "acme/widgets" } } }, { ...earlierPr, number: 6, base: { ref: "release" } }] });
  const p = await setup.plan(g.api, args());
  assert.deepEqual(p.args.supersede, [{ number: 4, head: "1".repeat(40) }], "the plan names the PRs and heads the reviewer sees");
  await setup.run(g.api, async () => g.api, p.args);
  assert.deepEqual(calls(g).slice(3), ["POST /pulls", "PATCH /pulls/4", "DELETE /git/refs/heads/aidenhq/setup-111111111111"]);
  assert.deepEqual(g.writes.find((w) => w.method === "PATCH")!.body, { state: "closed" });
  assert.match((await setup.plan(g.api, args())).facts.sentence, /earlier setup PR \("Earlier setup" https:\/\/github.com\/acme\/widgets\/pull\/4\) will be closed/);
});

test("only the setup PRs the reviewer saw, at the heads they saw, are closed: one changed or opened since stays", async () => {
  const g = github({ open: [earlierPr] });
  const p = await setup.plan(g.api, args());
  const later = github({ open: [{ ...earlierPr, head: { ...earlierPr.head, sha: "2".repeat(40) } }, { ...earlierPr, number: 7, head: { ref: "aidenhq/setup-777777777777", sha: "7".repeat(40), repo: { full_name: "acme/widgets" } } }] });
  await setup.run(later.api, async () => later.api, p.args);
  assert.deepEqual(calls(later), ["POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
});

test("a path whose parent directory is a file on the default branch is refused", async () => {
  const g = github({ has: [".deepsec/data"] });
  await assert.rejects(setup.plan(g.api, args()), /\.deepsec\/data is a file on main/);
  await assert.rejects(runOf(g.api, args()), /is a file on main/);
  assert.deepEqual(g.writes, []);
});

test("a failed PR leaves no stray branch", async () => {
  const g = github();
  const api = async (m: string, p: string, b?: any) => (p === "/repos/acme/widgets/pulls" && m === "POST" ? (g.writes.push({ method: m, path: p, body: b }), Promise.reject(new Error("GitHub POST /pulls: 422"))) : g.api(m, p, b));
  await assert.rejects(runOf(api, args()), /422/);
  assert.equal(calls(g).at(-1), `DELETE /git/refs/heads/${BRANCH}`);
});

test("the args are checked again: paths outside the allowlist, dot segments and too many files refuse", async () => {
  await assert.rejects(setup.plan(github().api, args({ files: { "src/a.ts": "x" } })), /isn't an allowed setup path/);
  await assert.rejects(setup.plan(github().api, args({ files: { ".deepsec/data/../x/INFO.md": "x" } })), /isn't an allowed setup path/);
  await assert.rejects(setup.plan(github().api, args({ files: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`.deepsec/data/w${i}/INFO.md`, "x"])) })), /1 to 8 paths/);
  await assert.rejects(setup.plan(github().api, args({ files: { ".deepsec/package.json": "x".repeat(900_000) } })), /at most 800000 bytes/);
});

test("the plan binds the default branch's name and head; the run refuses when either moved", async () => {
  const g = github();
  const p = await setup.plan(g.api, args());
  assert.deepEqual([p.args.base, p.args.base_head], ["main", HEAD]);
  assert.deepEqual(p.targets, { "acme/widgets main": { repo: "acme/widgets", ref: "main", commit: HEAD } });
  assert.deepEqual(p.paths, [{ repo: "acme/widgets", files: [{ path: ".deepsec/data/w/INFO.md" }, { path: ".deepsec/deepsec.config.ts" }] }]);
  assert.match(p.facts.diff, /--- new file \.deepsec\/data\/w\/INFO\.md ---\n# widgets/);
  assert.match(p.facts.diff, /the pull request as it will be published ---\nAdd deepsec\n\nSetup\./);
  const moved = github({ head: "b".repeat(40) });
  await assert.rejects(setup.run(moved.api, async () => moved.api, p.args), /ask again/);
  const renamed = github({ def: "trunk" });
  await assert.rejects(setup.run(renamed.api, async () => renamed.api, p.args), /default branch is now trunk/);
  assert.deepEqual([...moved.writes, ...renamed.writes], []);
  await assert.rejects(setup.run(g.api, async () => g.api, args()), /unrecorded head/);
});

test("a default branch with no head is a clear error, and a PR text naming something private is refused", async () => {
  const api = async (_m: string, p: string) => (p === "/repos/acme/widgets" ? { default_branch: "main" } : p.includes("/branches/") ? {} : []);
  await assert.rejects(setup.plan(api, args()), /no head to branch from/);
  await assert.rejects(setup.plan(github().api, args({ body: "the secret" }), (t) => (/secret/.test(t) ? "secret" : undefined)), /mentions "secret"/);
});

// The kernel's `setup` op: the code host files its own record and writes only what that record's approval runs.
const listen = (handler: any) => new Promise<any>((ok) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => ok({ s, url: `http://127.0.0.1:${(s.address() as any).port}` })); });
async function host(t: any, decide: { state: string; outcome?: any }) {
  const filed: any[] = [];
  const kernel = await listen(async (req: any, res: any) => {
    let body = ""; for await (const c of req) body += c;
    if (req.method === "POST" && req.url === "/v1/writes") { filed.push(JSON.parse(body)); return res.writeHead(200).end(JSON.stringify({ id: "w1", ...decide })); }
    res.writeHead(404).end("{}");
  });
  const ghCalls: any[] = [];
  const access: any = {
    connected: () => true, scopes: () => [], status: () => ({}), token: async () => "tok", identity: async () => ({ login: "o", name: "O", email: "o@example.com" }), graphql: async () => ({}),
    rest: async (m: string, p: string, b: any) => { ghCalls.push({ m, p, b }); return { status: 200, body: {}, headers: new Headers() }; },
  };
  const handle = createService({ key: "ch-key", kernelUrl: kernel.url, cacheDir: mkdtempSync(join(tmpdir(), "setup-op-")), access: withActors(access), fleetOrg: "acme-agents", ops: serveOps, allowedOrgs: ["acme"], reviewGate: async () => undefined } as any);
  const svc = await listen((req: any, res: any) => void handle(req, res));
  t.after(() => { kernel.s.close(); svc.s.close(); });
  const call = async (body: object, key = "ch-key") => { const r = await fetch(`${svc.url}/ops/setup`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
  return { call, filed, ghCalls };
}
const op = (over = {}) => ({ module: "code-review", task: "T-1", ...args(), ...over });

test("the op answers only the kernel, and writes nothing to GitHub unless its own record was approved and ran", async (t) => {
  const rejected = await host(t, { state: "rejected", outcome: { ok: false, text: "the reviewer said no" } });
  assert.equal((await rejected.call(op(), "wrong")).status, 401);
  const r = await rejected.call(op());
  assert.equal(r.status, 409);
  assert.match(r.json.error, /write w1 rejected/);
  assert.equal(rejected.filed.length, 1);
  assert.deepEqual(rejected.filed[0], { kind: "github.setup", task: "T-1", args: { repo: "acme/widgets", files: args().files, allow: ALLOW, title: "Add deepsec", body: "Setup." } });
  assert.deepEqual(rejected.ghCalls, []);
  const done = await host(t, { state: "done", outcome: { ok: true, text: JSON.stringify({ pr_url: "https://github.com/acme/widgets/pull/9", branch: BRANCH, tip: COMMIT }) } });
  assert.deepEqual((await done.call(op())).json, { pr_url: "https://github.com/acme/widgets/pull/9", branch: BRANCH, tip: COMMIT });
  assert.deepEqual(done.ghCalls, []);
  assert.equal((await done.call(op({ task: undefined }))).status, 400);
});

