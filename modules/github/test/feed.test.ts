// The change feed (service/src/feed.ts) against a fake GitHub and kernel: a baseline announces only a resync; changes become
// typed events with the PR's record; an unchanged repo costs only 304s; an event the kernel didn't take waits in the outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeed } from "../service/src/feed.ts";

const R = "acme/app";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), T = "f".repeat(40);
const pr = (n: number, head: string, title = `PR ${n}`) => ({ number: n, title, body: "body", draft: false, user: { login: "dev" }, author_association: "MEMBER", created_at: "2026-11-24T10:00:00Z", html_url: `https://github.com/${R}/pull/${n}`, labels: [], head: { sha: head, ref: `b${n}`, repo: { full_name: R } }, base: { sha: T, ref: "main" } });

function rig() {
  let t = Date.parse("2026-11-24T12:00:00Z");
  const world: { prs: any[]; closed: Record<number, any>; runs: Record<string, any[]>; comments: any[] } = { prs: [pr(1, A)], closed: {}, runs: {}, comments: [] };
  const calls: string[] = [];
  const body = (path: string): any => {
    const p = path.split("?")[0]!;
    if (p === `/repos/${R}/pulls` && /page=1\b/.test(path)) return world.prs;
    if (p === `/repos/${R}/pulls`) return [];
    const closed = /\/pulls\/(\d+)$/.exec(p);
    if (closed) return world.closed[Number(closed[1])];
    if (p === `/repos/${R}/issues/comments`) return world.comments.filter((c) => c.updated_at >= new URLSearchParams(path.split("?")[1]).get("since")!);
    if (p === `/repos/${R}`) return { default_branch: "main" };
    if (p === `/repos/${R}/branches/main`) return { commit: { sha: T } };
    const runs = /\/commits\/(\w+)\/check-runs$/.exec(p);
    if (runs) return { check_runs: world.runs[runs[1]!] ?? [] };
    return [];
  };
  const gh = async (_m: string, path: string, _b?: unknown, o: { etag?: string } = {}) => {
    const b = body(path);
    const etag = `"${createHash("sha1").update(JSON.stringify(b ?? null)).digest("hex")}"`;
    calls.push(`${o.etag === etag ? 304 : 200} ${path.split("?")[0]}`);
    return o.etag === etag ? { status: 304, body: "" } : { status: 200, body: b, headers: new Headers({ etag }) };
  };
  const sent: any[] = [];
  let kernelUp = true;
  const kernel = {
    call: async () => ({ resources: [] }),
    raw: async (_m: string, _p: string, b: any) => { if (!kernelUp) return { status: 503, json: {} }; sent.push(b); return { status: 200, json: { accepted: true } }; },
  };
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  const seen: any[] = [];
  const feed = createFeed({ gh: gh as any, cacheDir: dir, kernel, managed: async () => [R], kindOf: async () => "owner", hooks: [(e) => void seen.push(e)], now: () => t });
  return { feed, world, calls, sent, seen, dir, tick: (ms: number) => void (t += ms), kernel: (up: boolean) => void (kernelUp = up), at: () => new Date(t).toISOString() };
}

test("baseline, changes as typed events, 304s when quiet, and an outbox that waits for the kernel", async () => {
  const r = rig();
  await r.feed.pass(R);
  await r.feed.send();
  assert.deepEqual(r.sent.map((e) => e.kind), ["github.resync"], "a baseline announces only a resync");

  // A push to PR 1, a new PR 2 whose head already has a finished check, and a comment.
  r.tick(30_000);
  r.world.prs = [pr(1, B), pr(2, C)];
  r.world.runs[C] = [{ id: 7, name: "ci", status: "completed", conclusion: "success", check_suite: { id: 1 }, started_at: r.at(), completed_at: r.at() }];
  r.world.comments = [{ id: 99, body: "/review", user: { login: "dev" }, created_at: r.at(), updated_at: r.at(), issue_url: `https://api.github.com/repos/${R}/issues/1`, html_url: `https://github.com/${R}/pull/1#c` }];
  r.sent.length = 0;
  await r.feed.pass(R);
  await r.feed.send();
  const kinds = r.sent.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["check_run.completed", "issue_comment.created", "pull_request.opened", "pull_request.synchronize"]);
  const sync = r.sent.find((e) => e.kind === "pull_request.synchronize");
  assert.deepEqual([sync.data.head, sync.data.before, sync.data.fork, sync.data.author_kind, sync.text], [B, A, false, "owner", "PR 1"]);
  assert.deepEqual(r.sent.find((e) => e.kind === "check_run.completed").data, { head: C, name: "ci", conclusion: "success", prs: [2] });
  assert.equal(r.sent.find((e) => e.kind === "issue_comment.created").data.pr, true);
  assert.equal(r.seen.length, 5, "the in-process hooks saw the resync and the four events");

  // Nothing changed: no events, and every list read answered 304 (the comment cursor's URL moved once, so it reads afresh).
  r.tick(30_000);
  r.sent.length = 0;
  r.calls.length = 0;
  await r.feed.pass(R);
  assert.equal(r.sent.length, 0);
  r.calls.length = 0;
  r.tick(30_000);
  await r.feed.pass(R);
  assert.ok(r.calls.length >= 6 && r.calls.every((c) => c.startsWith("304")), r.calls.join("\n"));

  // PR 2 merges while the kernel is down: the event waits in the saved outbox and goes once the kernel answers.
  r.kernel(false);
  r.world.prs = [pr(1, B)];
  r.world.closed[2] = { ...pr(2, C), merged_at: r.at(), closed_at: r.at(), merge_commit_sha: T };
  r.tick(30_000);
  await r.feed.pass(R);
  await r.feed.send();
  assert.equal(r.sent.length, 0);
  assert.equal(JSON.parse(readFileSync(join(r.dir, "feed.json"), "utf8")).outbox[0].kind, "pull_request.closed");
  r.kernel(true);
  await r.feed.send();
  assert.deepEqual(r.sent.map((e) => [e.kind, e.data.merged, e.data.merge_sha]), [["pull_request.closed", true, T]]);
  assert.equal(r.feed.tip(R)?.tip, T);
});
