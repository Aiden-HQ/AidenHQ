// Routine runs left blocked once a later run of the same routine succeeded are cancelled by their own agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeStaleRoutineRuns } from "../src/stale-routines.ts";

const AGENT = "a-1";
const run = (identifier, status, originId, createdAt) => ({ id: identifier, identifier, status, originKind: "routine_execution", originId, createdAt, assigneeAgentId: AGENT });

test("cancels a blocked run only once a later run of the same routine finished done, never a per-event routine's", async () => {
  const issues = [
    run("WOR-60", "blocked", "scan", "2026-11-09T06:45:00Z"), run("WOR-70", "blocked", "brief", "2026-11-09T07:00:00Z"), run("WOR-90", "blocked", "scan", "2026-11-11T10:00:00Z"),
    run("WOR-7426", "blocked", "issue", "2026-11-18T03:11:00Z"),
    run("WOR-1279", "done", "scan", "2026-11-11T09:15:00Z"), run("WOR-1260", "done", "scan", "2026-11-11T09:00:00Z"), run("WOR-50", "done", "brief", "2026-11-08T07:00:00Z"),
    run("WOR-7434", "done", "issue", "2026-11-18T03:16:00Z"),
  ];
  const owner = async (method, path) => {
    const u = new URL(path, "http://cp");
    let m;
    if (u.pathname === "/api/companies/c-1/issues") {
      const p = u.searchParams;
      return { status: 200, json: issues.filter((i) => i.originKind === p.get("originKind") && i.status === p.get("status") && (!p.get("originId") || i.originId === p.get("originId")) && (!p.get("assigneeAgentId") || i.assigneeAgentId === p.get("assigneeAgentId"))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    }
    if ((m = /^\/api\/routines\/([^/]+)$/.exec(u.pathname))) return { status: 200, json: { id: m[1], concurrencyPolicy: m[1] === "issue" ? "always_enqueue" : "coalesce_if_active" } };
    return { status: 404, json: {} };
  };
  const posts = [];
  const post = async (job, req) => (posts.push({ ...job, ...req }), { comment: "c", status: req.status ?? null });
  await closeStaleRoutineRuns({ owner, post }, AGENT, "c-1");
  assert.deepEqual(posts.map((p) => [p.agent, p.task, p.kind, p.status, p.body]), [[AGENT, "WOR-60", "stale", "cancelled", "Closed: a later run of this routine (WOR-1279) succeeded."]]);
});
