// Routines' events from GitHub (service/src/flow.ts eventsPass): each subscribed repo's events feed, read on the churn pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFlow } from "../service/src/flow.ts";

const issue = (id: number, title = `issue ${id}`) => ({ id: String(id), type: "IssuesEvent", actor: { login: "octo" }, payload: { action: "opened", issue: { title, body: "b", html_url: `https://github.com/acme/app/issues/${id}`, labels: [{ name: "bug" }] } } });

test("a poll sends the ETag on page one, pages to the cursor, resets a lost cursor with a gap, and advances past a skipped event", async (t) => {
  const posted: { id: string; kind: string }[] = [];
  let refuse = "";
  const kernel = createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const send = (s: number, j: unknown) => res.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(j));
    if (req.url === "/v1/events/sources?connection=github") return send(200, { resources: ["acme/app"] });
    const e = JSON.parse(b);
    if (e.id === refuse) return send(503, {});
    posted.push({ id: e.id, kind: e.kind });
    return send(200, e.id === "7" ? { skipped: "invalid", why: "x" } : { queued: 1 });
  });
  await new Promise<void>((ok) => kernel.listen(0, "127.0.0.1", ok));
  const calls: { path: string; etag?: string }[] = [];
  let feed: object[] = [];
  const gh = async (_m: string, path: string, o?: { etag?: string }) => {
    calls.push({ path, ...(o?.etag ? { etag: o.etag } : {}) });
    const page = Number(/&page=(\d+)/.exec(path)![1]);
    if (o?.etag === `"e${feed.length}"`) return { status: 304, body: {}, headers: new Headers() };
    return { status: 200, body: feed.slice((page - 1) * 100, page * 100), headers: new Headers({ etag: `"e${feed.length}"` }) };
  };
  const logs: string[] = [];
  const flow = createFlow({ kernelUrl: `http://127.0.0.1:${(kernel.address() as { port: number }).port}`, key: "k", cacheDir: mkdtempSync(join(tmpdir(), "ev-")), log: (m) => void logs.push(m), gh, repos: async () => [] });
  t.after(() => { flow.stop(); kernel.closeAllConnections(); kernel.close(); });

  // No cursor: page one only, a logged gap, sent oldest first; a push and an opened issue go, a starred repo doesn't.
  feed = [{ id: "3", type: "WatchEvent", payload: {} }, { id: "2", type: "PushEvent", actor: { login: "octo" }, payload: { head: "abc", commits: [{ message: "fix" }] } }, issue(1)];
  await flow.eventsPass();
  assert.deepEqual(posted, [{ id: "1", kind: "issues.opened" }, { id: "2", kind: "push" }]);
  assert.ok(logs.includes("events: a gap in the feed; read its newest page only"));
  // Nothing new: page one answers 304 to its ETag.
  calls.length = 0;
  await flow.eventsPass();
  assert.deepEqual(calls, [{ path: "/repos/acme/app/events?per_page=100&page=1", etag: '"e3"' }]);

  // 150 new events: page two is read back to the cursor; the kernel's skip of 7 still moves the cursor.
  posted.length = 0; logs.length = 0;
  feed = [...Array.from({ length: 150 }, (_, i) => issue(153 - i)), ...feed];
  await flow.eventsPass();
  assert.equal(posted.length, 150);
  assert.deepEqual([posted[0]!.id, posted.at(-1)!.id], ["4", "153"]);
  assert.ok(!logs.includes("events: a gap in the feed; read its newest page only"));

  // A 503 stops there (the cursor stays before it, the ETag isn't kept); the next pass sends it and what follows.
  posted.length = 0;
  feed = [issue(155), issue(154), ...feed];
  refuse = "154";
  await flow.eventsPass();
  assert.deepEqual(posted, []);
  refuse = "";
  await flow.eventsPass();
  assert.deepEqual(posted.map((p) => p.id), ["154", "155"]);

  // A cursor the feed no longer reaches: page one only, with a gap.
  posted.length = 0; logs.length = 0;
  feed = Array.from({ length: 300 }, (_, i) => issue(1000 - i));
  await flow.eventsPass();
  assert.equal(posted.length, 100);
  assert.equal(posted[0]!.id, "901");
  assert.ok(logs.includes("events: a gap in the feed; read its newest page only"));
});
