// github.setup: the reviewed setup PR (service/src/setup.ts) against a fake GitHub, and the kernel's `setup` op (service.ts) against a fake
// kernel that decides the code host's own record: nothing is written to GitHub unless that record was approved and ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../service/src/service.ts";
import { serveOps } from "../service/src/ops.ts";
import * as setup from "../service/src/setup.ts";

const TIP = "c".repeat(40), HEAD = "a".repeat(40);
const ALLOW = [".deepsec/data/*/INFO.md", ".deepsec/deepsec.config.ts", ".deepsec/package.json"];
const args = (over = {}) => ({ repo: "acme/widgets", branch: "aidenhq/deepsec-setup", expected_tip: null, files: { ".deepsec/data/w/INFO.md": "# widgets\n", ".deepsec/deepsec.config.ts": "export default {};\n" }, allow: ALLOW, title: "Add deepsec", body: "Setup.", ...over });

/** A fake GitHub: the default branch, the setup branch's tip, the files each commit has, what the branch's diff carries, the open PRs. */
function github(o: { tip?: string | null; has?: string[]; diff?: string[]; open?: { html_url: string; base?: { ref: string } }[] } = {}) {
  const writes: { method: string; path: string; body: any }[] = [];
  const api = async (method: string, path: string, body?: any) => {
    if (method !== "GET") writes.push({ method, path, body });
    const miss = () => Promise.reject(new Error(`GitHub ${method} ${path}: 404 Not Found`));
    if (path === "/repos/acme/widgets") return { default_branch: "main" };
    if (path === "/repos/acme/widgets/branches/main") return { commit: { sha: HEAD } };
    if (path === "/repos/acme/widgets/branches/aidenhq/deepsec-setup") return o.tip ? { commit: { sha: o.tip } } : miss();
    if (path.startsWith("/repos/acme/widgets/contents/")) return (o.has ?? []).includes(decodeURIComponent(path.slice("/repos/acme/widgets/contents/".length).split("?")[0]!)) ? { sha: "x" } : miss();
    if (path.startsWith("/repos/acme/widgets/compare/")) return { files: (o.diff ?? []).map((filename) => ({ filename, status: "modified", patch: `@@ -1 +1 @@\n-old ${filename}\n+new ${filename}` })) };
    if (path.startsWith("/repos/acme/widgets/commits/")) return { commit: { tree: { sha: "t".repeat(40) } } };
    if (path.endsWith("/git/trees")) return { sha: "e".repeat(40) };
    if (path.endsWith("/git/commits")) return { sha: "d".repeat(40) };
    if (path.includes("/git/refs")) return {};
    if (method === "GET" && path.startsWith("/repos/acme/widgets/pulls")) return o.open ?? [];
    if (path === "/repos/acme/widgets/pulls") return { html_url: "https://github.com/acme/widgets/pull/9", number: 9 };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, writes };
}

test("a new branch is one commit of the missing files off the default branch's head, then its PR into the default branch", async () => {
  const g = github();
  const out = await setup.run(g.api, args());
  assert.deepEqual(JSON.parse(out.text), { pr_url: "https://github.com/acme/widgets/pull/9", tip: "d".repeat(40) });
  assert.deepEqual(g.writes.map((w) => `${w.method} ${w.path.replace("/repos/acme/widgets", "")}`), ["POST /git/trees", "POST /git/commits", "POST /git/refs", "POST /pulls"]);
  assert.deepEqual(g.writes[1]!.body.parents, [HEAD]);
  assert.match(g.writes[1]!.body.message, /Co-authored-by: AidenHQ/);
  assert.equal(g.writes[3]!.body.base, "main");
});

test("files the repo already has are never overwritten; with nothing missing there is no commit", async () => {
  const g = github({ has: [".deepsec/deepsec.config.ts"] });
  await setup.run(g.api, args());
  assert.deepEqual(g.writes[0]!.body.tree.map((e: any) => e.path), [".deepsec/data/w/INFO.md"]);
  const none = github({ has: Object.keys(args().files) });
  assert.deepEqual(JSON.parse((await setup.run(none.api, args())).text), { pr_url: null, tip: null, nothing_to_add: true });
  assert.deepEqual(none.writes, []);
});

test("paths outside the allowlist are refused, in the plan and in the run", async () => {
  const g = github();
  for (const files of [{ "src/index.ts": "x" }, { ".deepsec/deepsec.config.ts": "ok", ".github/workflows/ci.yml": "x" }, { ".deepsec/data/../../x/INFO.md": "x" }, {}]) {
    await assert.rejects(setup.plan(g.api, args({ files })), /allowed setup path|files is/);
    await assert.rejects(setup.run(g.api, args({ files })), /allowed setup path|files is/);
  }
  await assert.rejects(setup.plan(g.api, args({ branch: "main" })), /aidenhq\//);
  assert.deepEqual(g.writes, []);
});

test("it refuses when the branch tip isn't the approved one", async () => {
  await assert.rejects(setup.plan(github({ tip: "f".repeat(40) }).api, args({ expected_tip: TIP })), /not cccccccccccc/);
  await assert.rejects(setup.run(github({ tip: TIP }).api, args()), /not a new branch/);
  await assert.rejects(setup.run(github({ tip: null }).api, args({ expected_tip: TIP })), /nothing, not/);
});

test("the PR's whole diff against the default branch must hold allowed paths only", async () => {
  const g = github({ tip: TIP, diff: [".deepsec/package.json", "src/evil.ts"] });
  const out = await setup.run(g.api, args({ expected_tip: TIP }));
  assert.equal(out.ok, false);
  assert.match(out.text, /src\/evil\.ts/);
  assert.deepEqual(g.writes, []);
});

test("an existing branch moves forward from its tip; an open PR is reused, never a second one", async () => {
  const g = github({ tip: TIP, diff: [".deepsec/package.json"], open: [{ html_url: "https://github.com/acme/widgets/pull/4", base: { ref: "main" } }] });
  const out = await setup.run(g.api, args({ expected_tip: TIP }));
  assert.deepEqual(JSON.parse(out.text), { pr_url: "https://github.com/acme/widgets/pull/4", tip: "d".repeat(40) });
  assert.deepEqual(g.writes[1]!.body.parents, [TIP]);
  assert.equal(g.writes.find((w) => w.method === "PATCH")!.body.force, undefined);
  assert.equal(g.writes.some((w) => w.path.endsWith("/pulls")), false);
  // The reviewer reads what the branch already carries; a PR into another base refuses before anything is pushed.
  const p = await setup.plan(github({ tip: TIP, diff: [".deepsec/package.json"] }).api, args({ expected_tip: TIP }));
  assert.match(p.facts.diff, /already on aidenhq\/deepsec-setup: \.deepsec\/package\.json \(modified\) ---\n@@ -1 \+1 @@\n-old/);
  const other = github({ tip: TIP, open: [{ html_url: "https://github.com/acme/widgets/pull/5", base: { ref: "release" } }] });
  const refused = await setup.run(other.api, args({ expected_tip: TIP }));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /pull request into release, not main/);
  assert.deepEqual(other.writes, []);
});

test("the plan shows the files to add whole and binds the branch's tip and the base's head", async () => {
  const p = await setup.plan(github({ has: [".deepsec/deepsec.config.ts"] }).api, args());
  assert.deepEqual(p.targets, { "acme/widgets aidenhq/deepsec-setup": { repo: "acme/widgets", ref: "aidenhq/deepsec-setup", commit: null, base_sha: HEAD } });
  assert.match(p.facts.diff, /new file \.deepsec\/data\/w\/INFO\.md ---\n# widgets/);
  assert.doesNotMatch(p.facts.diff, /deepsec\.config/);
  await assert.rejects(setup.plan(github().api, args(), () => "aidenhq"), /mentions "aidenhq"/);
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
  const handle = createService({ key: "ch-key", kernelUrl: kernel.url, cacheDir: mkdtempSync(join(tmpdir(), "setup-op-")), access, fleetOrg: "acme-agents", ops: serveOps, allowedOrgs: ["acme"], reviewGate: async () => undefined } as any);
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
  assert.deepEqual(rejected.filed[0], { kind: "github.setup", task: "T-1", args: { repo: "acme/widgets", branch: "aidenhq/deepsec-setup", expected_tip: null, files: args().files, allow: ALLOW, title: "Add deepsec", body: "Setup." } });
  assert.deepEqual(rejected.ghCalls, []);
  const done = await host(t, { state: "done", outcome: { ok: true, text: JSON.stringify({ pr_url: "https://github.com/acme/widgets/pull/9", tip: "d".repeat(40) }) } });
  assert.deepEqual((await done.call(op())).json, { pr_url: "https://github.com/acme/widgets/pull/9", tip: "d".repeat(40) });
  assert.deepEqual(done.ghCalls, []);
  assert.equal((await done.call(op({ task: undefined }))).status, 400);
});
