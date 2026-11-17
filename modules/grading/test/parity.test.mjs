// Grading parity (lean-core 3h): golden.json was recorded from the board's grade routes before grading left the board
// (services/board/test/grading-golden.test.ts at commit "test(grading): record the grading golden from today's board routes").
// This replays the same script through the kernel's real finish gate (kernel/src/checks.ts) and this module's real service,
// with a frozen clock, and must produce every answer, grade row and control-plane patch unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createChecks } from "../../../kernel/src/checks.ts";
import { createResolver } from "../../../kernel/src/net.ts";
import { createGrading } from "../service/src/server.ts";

const script = JSON.parse(readFileSync(new URL("./script.json", import.meta.url), "utf8"));
const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
const KEYS = { check: "c".repeat(32), runner: "r".repeat(32), board: "b".repeat(32) };

test("grading parity: the golden script through the kernel's finish gate and the grading module", async (t) => {
  const realNow = Date.now;
  Date.now = () => Date.parse(script.now);
  t.after(() => { Date.now = realNow; });

  // The control plane, as the owner sees it: the script's tasks, the one label, and every patch.
  const issues = structuredClone(script.issues);
  for (const i of Object.values(issues)) i.companyId = "co";
  const byRef = (ref) => Object.values(issues).find((i) => i.id === ref || i.identifier === ref);
  let patches = [];
  const owner = async (method, path, body) => {
    const m = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (method === "GET" && m) { const i = byRef(decodeURIComponent(m[1])); return i ? { status: 200, json: structuredClone(i) } : { status: 404, json: {} }; }
    if (method === "GET" && path === "/api/companies/co/labels") return { status: 200, json: [{ id: "lbl-grading", name: "grading" }] };
    if (method === "PATCH" && m) { const i = byRef(decodeURIComponent(m[1])); patches.push({ task: i.identifier, patch: body }); Object.assign(i, body); return { status: 200, json: i }; }
    return { status: 404, json: {} };
  };
  let settings = { agents_org: script.grants.agents_org, product_repo: script.grants.product_repo };

  // The module's service, its kernel being the gate below (its reads as the owner, its label released through resolve()).
  let checks;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kernel = {
    issue: async (ref) => { const r = await owner("GET", `/api/issues/${encodeURIComponent(ref)}`); if (r.status !== 200) throw new Error(`no task ${ref}`); return r.json; },
    settings: async () => settings,
    release: async (task) => void (await checks.resolve("grading", task, { verdict: "release" })),
  };
  const { server, grades } = createGrading({ db: new DatabaseSync(":memory:"), kernel, keys: KEYS, jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const secrets = { grading_check_key: KEYS.check };
  checks = createChecks({ db: new DatabaseSync(":memory:"), owner, secret: (n) => secrets[n] ?? "", resolver: createResolver(), agentKey: (id) => script.grants.agents[id]?.key,
    registry: () => ({ "grading.finish": { module: "grading", at: "task.finish", url: `${url}/check/finish`, auth_secret: "grading_check_key", label: "grading" } }) });

  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const assertion = (agent, tool) => { const body = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({ agent, key: agent, name: agent, roles: [], tool: `paperclip_tasks.${tool}`, kind: "run", aud: "tasks", jti: "j", exp: Math.floor(Date.now() / 1000) + 60 })}`; return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`; };
  const call = async (method, path, headers, body) => { const r = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() }; };
  const runner = { authorization: `Bearer ${KEYS.runner}` };
  const out = [];
  for (const s of script.steps) {
    patches = [];
    if (s.set) Object.assign(byRef(s.task), s.set);
    let r;
    if (s.op === "file") r = await call("POST", "/grades", { "x-aidenhq-caller": assertion(s.as, s.tool ?? "task_delegate") }, { issue: s.task, rubric: s.rubric, deliverable: s.deliverable });
    if (s.op === "close") {
      // The two ways a close reaches the gate: an agent's own (cp.ts, the tool's name as via) or the runner's (/v1/finish).
      const f = await checks.finish(byRef(s.task).id, s.via.startsWith("finish_") ? { via: s.via } : { agent: s.as, tool: s.via, via: s.via }).catch((e) => e);
      r = f instanceof Error ? { status: f.status, json: { error: f.message } } : { status: 200, json: f };
    }
    if (s.op === "verdict") r = await call("POST", `/internal/grades/${s.task}/verdict`, runner, s.verdict);
    if (s.op === "resubmit") r = await call("POST", `/internal/grades/${s.task}/resubmit`, runner, { version: s.version });
    if (s.op === "list") r = await call("GET", "/internal/grades", runner);
    if (s.op === "state") r = await call("GET", `/internal/grades/${byRef(s.task).id}`, runner);
    out.push({ step: s.name, ...normalize(s, r), row: row(grades.get(byRef(s.task ?? "WOR-1").id)), patches });
  }
  for (let n = 0; n < golden.length; n++) assert.deepEqual(out[n], golden[n], `step ${n + 1}: ${golden[n].step}`);
  assert.equal(out.length, golden.length);
});

/** The same normalizer the recorder used, over the kernel's finish verdicts ({pass} or {held, state}) for closes. */
function normalize(s, r) {
  if (r.status >= 300) return { status: r.status, error: r.json?.error ?? null };
  if (s.op === "close") return { close: r.json.pass ? "pass" : `held:${r.json.state}` };
  if (s.op === "list") return { due: r.json.grades.map((g) => g.issueId), resubmitted: r.json.resubmitted.map((g) => g.issueId) };
  if (s.op === "verdict" || s.op === "resubmit") return { state: r.json.state };
  return { body: r.json };
}
function row(g) {
  if (!g) return null;
  const { createdAt, updatedAt, ...rest } = g;
  return { ...rest, verdicts: g.verdicts.map(({ at, ...v }) => v) };
}
