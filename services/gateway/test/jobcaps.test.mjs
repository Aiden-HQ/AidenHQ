// A job's reads through POST /c/<connection>/mcp, against a fake connection: only its jobcap's tools are listed or called,
// only a job's own token opens it, and the job token never reaches the connection (the read secret does).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../lib.ts";
import { mintToken } from "../token.ts";

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });

test("jobcap route: listed tools only, job tokens only, the read secret upstream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gw-jc-"));
  const secrets = { gateway_job_secret: "job-secret", gateway_lane_secret: "lane-secret", primer_mcp_read_token: "read-secret" };
  const seen = [];
  const upstream = await serve((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const msg = JSON.parse(b);
      seen.push({ auth: req.headers.authorization, method: msg.method, name: msg.params?.name, raw: b });
      const tools = [{ name: "read_a" }, { name: "write_b" }];
      if (msg.method === "tools/list" && req.headers.accept?.includes("event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } })}\n\n`);
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "doc" }] } }));
    });
  });
  const jobcapsFile = join(dir, "jobcaps.json");
  writeFileSync(jobcapsFile, JSON.stringify({
    "primer-read": { connection: "primer", url: `${upstream.url}/mcp/read`, bearer_secret: "primer_mcp_read_token", tools: ["read_a"] },
    "slack-read": { connection: "slack", url: `${upstream.url}/mcp/read`, bearer_secret: "primer_mcp_read_token", tools: ["read_a"], private: true },
  }));
  const gw = createGateway({ dbFile: join(dir, "usage.db"), grantsFile: join(dir, "grants.json"), settingsFile: join(dir, "gateway.json"), jobcapsFile, secret: (n) => secrets[n] ?? "" });
  const server = await serve((req, res) => gw.handle(req, res));
  t.after(() => { server.s.close(); upstream.s.close(); gw.close(); });

  const job = mintToken("job-secret", { kind: "agent", agentId: "ag1", issueId: "iss1", jobcaps: ["primer-read"] });
  const call = (token, body, { accept = "application/json, text/event-stream", path = "/c/primer/mcp" } = {}) => fetch(`${server.url}${path}`, {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });

  // A job token with the jobcap lists only its tools, as JSON and as a one-event SSE answer.
  let r = await call(job, { method: "tools/list" }, { accept: "application/json" });
  assert.deepEqual((await r.json()).result.tools.map((x) => x.name), ["read_a"]);
  r = await call(job, { method: "tools/list" });
  assert.match(r.headers.get("content-type"), /event-stream/);
  const event = JSON.parse(/data: (.*)/.exec(await r.text())[1]);
  assert.deepEqual(event.result.tools.map((x) => x.name), ["read_a"]);
  r = await call(job, { method: "tools/call", params: { name: "read_a", arguments: {} } }, { accept: "application/json" });
  assert.equal((await r.json()).result.content[0].text, "doc");

  // An unlisted tool is refused here: the connection never sees the call.
  const before = seen.length;
  r = await call(job, { method: "tools/call", params: { name: "write_b", arguments: {} } });
  assert.deepEqual((await r.json()).error, { code: -32602, message: "tool-unlisted" });
  assert.equal(seen.length, before);
  // A batch can't carry one past the check.
  r = await fetch(`${server.url}/c/primer/mcp`, { method: "POST", headers: { authorization: `Bearer ${job}`, "content-type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_b" } }]) });
  assert.equal(r.status, 400);
  assert.equal(seen.length, before);

  // Deny by default: resources, prompts and unknown methods never reach the connection.
  for (const method of ["resources/read", "prompts/get", "sampling/createMessage", "x/unknown"]) {
    r = await call(job, { method, params: { uri: "file:///etc/passwd" } });
    assert.equal((await r.json()).error.message, "method-refused", method);
  }
  assert.equal(seen.length, before);
  // A duplicate `name` key: upstream runs the name that was checked, from a re-serialized message.
  r = await fetch(`${server.url}/c/primer/mcp`, { method: "POST", headers: { authorization: `Bearer ${job}`, "content-type": "application/json", accept: "application/json" }, body: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_b","name":"read_a","arguments":{}}}' });
  assert.equal((await r.json()).result.content[0].text, "doc");
  assert.equal(seen.at(-1).name, "read_a");
  assert.equal(seen.at(-1).raw.includes("write_b"), false);
  const forwarded = seen.length;

  // No token, the read secret itself, a lane token, a system token or a job token without the jobcap: 401.
  const lane = mintToken("lane-secret", { kind: "agent", agentId: "ag1", jobcaps: ["primer-read"] });
  const reviewer = mintToken("job-secret", { kind: "reviewer", jobcaps: ["primer-read"] });
  const bare = mintToken("job-secret", { kind: "agent", agentId: "ag1", issueId: "iss1" });
  for (const tok of [undefined, "read-secret", lane, reviewer, bare]) assert.equal((await call(tok, { method: "tools/list" })).status, 401);
  // The jobcap is for primer only.
  assert.equal((await call(job, { method: "tools/list" }, { path: "/c/slack/mcp" })).status, 401);
  assert.equal(seen.length, forwarded);

  // A notification outside the list gets no JSON-RPC answer.
  r = await fetch(`${server.url}/c/primer/mcp`, { method: "POST", headers: { authorization: `Bearer ${job}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }) });
  assert.equal(r.status, 403);
  // A private jobcap: refused to a token not minted as observing (a job with web search), served to one that is.
  const light = mintToken("job-secret", { kind: "agent", agentId: "ag1", issueId: "iss1", jobcaps: ["slack-read"] });
  assert.equal((await call(light, { method: "tools/list" }, { path: "/c/slack/mcp" })).status, 401);
  assert.equal(seen.length, forwarded);
  const observing = mintToken("job-secret", { kind: "agent", agentId: "ag1", issueId: "iss1", jobcaps: ["slack-read"], observing: true });
  assert.equal((await call(observing, { method: "tools/list" }, { path: "/c/slack/mcp" })).status, 200);

  // The job token never reaches the connection: every forwarded call carried the read secret.
  assert.ok(seen.length >= 3);
  for (const s of seen) assert.equal(s.auth, "Bearer read-secret");
});
