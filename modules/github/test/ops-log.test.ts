// The code host's reads for a graded head.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { answerOp, type OpsContext } from "../service/src/ops.ts";

/** A minimal ZIP of stored/deflated entries. */
function zip(entries: { name: string; text: string }[], deflate: boolean): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), raw = Buffer.from(e.text);
    const body = deflate ? deflateRawSync(raw) : raw, method = deflate ? 8 : 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([head, name, body]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local); centrals.push(Buffer.concat([central, name]));
    offset += local.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

/** The ops' context with a fake GitHub. */
const ctx = (body: BodyInit | (() => Response)): OpsContext => {
  const api = (async (input: URL | string) => {
    const url = String(input);
    if (url.startsWith("https://pipelines.actions.githubusercontent.com/")) return typeof body === "function" ? body() : new Response(body, { status: 200 });
    if (url.endsWith("/actions/jobs/42/logs")) return new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/log?x=1" } });
    return new Response(JSON.stringify({ message: "no route" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    access: {
      connected: () => true, token: async () => "tok", scopes: () => ["repo"], status: () => ({ scopes: ["repo"], problems: [] }), lines: [],
      identity: async () => ({ login: "o", name: "O", email: "o@example.com" }),
      rest: async () => ({ status: 404, body: {}, headers: new Headers() }),
      graphql: async () => ({}),
    } as unknown as OpsContext["access"],
    cacheDir: "/tmp", cache: async () => "/tmp", git: async () => "", fetchRemote: async () => ({ dir: "/tmp", ref: "", sha: "" }), initBare: async () => {}, ours: async () => false,
    fetch: api,
  };
};

const read = (c: OpsContext, body: Record<string, unknown>) => answerOp("read", { module: "grading", repo: "acme/app", ...body }, c);

test("a job's log download is unpacked from its ZIP archive, which is the endpoint's format", async () => {
  const a = await read(ctx(zip([{ name: "0_packages (1).txt", text: "start\nShard 1: kernel#1\n" }], true)), { kind: "log", id: 42, bytes: 64_000 });
  assert.match(String(a.text), /Shard 1: kernel#1/);
});

test("a large log keeps its start, where the shard list is printed, and its tail", async () => {
  const a = await read(ctx(`Shard 1: kernel#1\n${"x".repeat(600_000)}\n##[group]kernel#1 (exit 0, 33s)`), { kind: "log", id: 42, bytes: 64_000 });
  assert.match(String(a.text), /^Shard 1: kernel#1/);
  assert.match(String(a.text), /##\[group\]kernel#1 \(exit 0, 33s\)$/);
});

test("a plain-text log body is read as it is", async () => {
  const a = await read(ctx("Shard 1: modules/grading\n"), { kind: "log", id: 42, bytes: 64_000 });
  assert.equal(a.text, "Shard 1: modules/grading\n");
});

test("a job GitHub no longer keeps is a 404, so a caller reads it as no evidence rather than an error", async () => {
  const c = ctx("x");
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "log", id: 42 }, { ...c, fetch: (async () => new Response(null, { status: 404 })) as typeof fetch });
  assert.equal(a.status, 404);
});

test("a file at an exact commit comes back as its text, or 404", async () => {
  const c = ctx("x");
  const present = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) }, {
    ...c, access: { ...c.access, rest: async () => ({ status: 200, body: "{\"suites\":[]}", headers: new Headers() }) } as unknown as OpsContext["access"],
  });
  assert.equal(present.text, "{\"suites\":[]}");
  const absent = await answerOp("read", { module: "grading", repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) }, c);
  assert.equal(absent.status, 404);
});

test("a job's record carries its steps, its run's base and the workflow that ran it", async () => {
  const c = ctx("x");
  const rest = async (_m: string, path: string) => path.includes("/actions/runs/") ?
    { status: 200, body: { head_sha: "h", event: "pull_request", workflow_id: 9, pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }] }, headers: new Headers() } :
    path.includes("/actions/workflows/") ?
    { status: 200, body: { path: ".github/workflows/ci.yml", state: "active" }, headers: new Headers() } :
    { status: 200, body: { id: 42, run_id: 7, name: "packages (1)", status: "completed", conclusion: "success", steps: [{ name: "Test", status: "completed", conclusion: "success" }] }, headers: new Headers() };
  const a = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest } as unknown as OpsContext["access"] });
  assert.deepEqual(a.json.steps, [{ name: "Test", state: "completed", conclusion: "success" }]);
  assert.equal(a.json.run_base, "base");
  assert.equal(a.json.workflow_path, ".github/workflows/ci.yml");
  assert.equal(a.json.workflow_state, "active");
  assert.equal(a.json.event, "pull_request");
  assert.equal(a.json.head_sha, "h");
  const unreadable = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest: async (_m: string, path: string) => path.includes("/actions/workflows/") ? { status: 500, body: {}, headers: new Headers() } : rest(_m, path) } as unknown as OpsContext["access"] });
  assert.equal(unreadable.json.workflow_path, null);
  // Two PRs on one head, two bases: ambiguous, no fact.
  const again = await answerOp("read", { module: "grading", repo: "acme/app", kind: "job", id: 42 }, { ...c, access: { ...c.access, rest: async (_m: string, path: string) => path.includes("/actions/runs/") ? { status: 200, body: { head_sha: "h", pull_requests: [{ head: { sha: "h" }, base: { sha: "base" } }, { head: { sha: "h" }, base: { sha: "x" } }] }, headers: new Headers() } : rest(_m, path) } as unknown as OpsContext["access"] });
  assert.equal(again.json.run_base, null);
});

test("a log bigger than the cap is refused while it is read", async () => {
  const c = ctx("x");
  const big = new ReadableStream({ start(controller) { for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(10_000_000)); controller.close(); } });
  await assert.rejects(
    () => answerOp("read", { module: "grading", repo: "acme/app", kind: "log", id: 42 }, { ...c, fetch: (async () => new Response(big, { status: 200 })) as typeof fetch }),
    (e: { status?: number }) => e.status === 502,
  );
});

test("the PR query asks for each check's job id and the base oid", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../service/src/ops.ts", import.meta.url), "utf8");
  const query = /const PR_QUERY = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
  assert.match(query, /CheckRun \{ databaseId name status conclusion \}/, "each CheckRun's databaseId is the Actions job a fact reads");
  assert.match(query, /baseRef \{ target \{ oid /, "the base oid is the CI map CI executes");
  assert.match(src, /steps: \(Array\.isArray\(j\.steps\)/, "a job's own steps come back, so the Test step can be required");
});
