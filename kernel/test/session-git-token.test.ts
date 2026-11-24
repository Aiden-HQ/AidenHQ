// A session box's git credential: only a session job gets a token, only for a repo the merge rules reach, and it is the App's
// installation token narrowed to that repo (never the owner's), asked of the code host through the kernel's own `app_token` op.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createJobTools } from "../src/jobtools.ts";
import { createCodehost, covers } from "../src/codehost.ts";
import { mintToken } from "../src/gateway/token.ts";
import { serveOps, type OpsContext } from "../../modules/github/service/src/ops.ts";

const repos = { agentsOrgs: ["acme-agents"], product: "acme/widgets-product", maintained: ["acme/maintained"] };
const setup = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, agent TEXT, task TEXT, state TEXT, authority TEXT)");
  const ins = db.prepare("INSERT INTO jobs VALUES (?, 'ag1', ?, 'running', ?)");
  ins.run("j-session", "t1", JSON.stringify({ profile: "session", roles: ["session"] }));
  ins.run("j-crew", "t2", JSON.stringify({ profile: "crew", roles: ["session"] }));
  const tools = createJobTools({ db, secret: () => "s", engines: () => [], reach: (r) => covers(r, ["@agents/*", "@product", "@maintained"], repos) });
  const tok = (job: string, task: string) => mintToken("s", { kind: "job", job, agentId: "ag1", issueId: task });
  return { tools, session: tok("j-session", "t1"), crew: tok("j-crew", "t2") };
};

test("a session gets a narrowed token", async () => {
  const { tools, session } = setup();
  const minted: unknown[] = [];
  const ctx = { app: { installation: async () => 7, mint: async (i: number, n: unknown) => (minted.push([i, n]), { token: "ghs_x", expires_at: "2026-11-25T01:00:00Z" }) } } as unknown as OpsContext;
  // The code host's executor, here: serveOps over a real http server, asked by the kernel's own appToken.
  const server = http.createServer((req, res) => void serveOps(req, res, ctx));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ch = createCodehost({
      repos: () => repos, grants: () => [], secret: () => "k",
      kind: () => ({ module: "github", floor: 0, tools: [], executor: { url: `${url}/aidenhq/v1/executor`, auth_secret: "k" } }) as never,
      resolver: { resolve: async (u: string) => ({ host: "127.0.0.1", port: Number(new URL(u).port), path: new URL(u).pathname }), forget: () => {} } as never,
    });
    const { repo } = tools.gitToken(session, { repo: "acme-agents/widgets" });
    assert.deepEqual(await ch.appToken(repo), { token: "ghs_x", expires_at: "2026-11-25T01:00:00Z" });
    assert.deepEqual(minted, [[7, { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } }]]);
  } finally { server.close(); }
});

test("a crew job is refused", () => {
  const { tools, crew } = setup();
  assert.throws(() => tools.gitToken(crew, { repo: "acme-agents/widgets" }), { status: 403 });
});

test("an outside repo is refused", () => {
  const { tools, session } = setup();
  assert.throws(() => tools.gitToken(session, { repo: "someone-else/widgets" }), { status: 403 });
});
