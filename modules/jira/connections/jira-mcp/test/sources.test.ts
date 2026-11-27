import { expect, it } from "bun:test";
import { syncBoards, syncHistory, syncJira } from "../src/sources.js";
import type { SourceStore } from "../src/source-store.js";

// The writer side against a fake store: what lands, and with which baseline flag (the SQL itself was smoke-run on postgres:17).
function fakeStore() {
  const scopes = new Map<string, { baselined: boolean; cursor: string | null }>();
  const writes: { table: string; row: Record<string, any>; baseline: boolean }[] = [];
  const store = {
    migrate: async () => undefined,
    run: async (_source: string, _scope: string, fn: () => Promise<number>) => fn(),
    scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
    saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor: cursor ?? scopes.get(s)?.cursor ?? null }),
    upsert: async (t: { name: string }, row: Record<string, any>, o: { baseline: boolean }) => (writes.push({ table: t.name, row, baseline: o.baseline }), "new"),
    pool: { query: async () => ({ rows: [{ key: "PRJ-1" }, { key: "PRJ-9" }] }) },
  };
  return { store: store as unknown as SourceStore, writes, scopes };
}

it("src_jira: the first pass is a baseline over the last 30 days, later passes from the cursor; sprints from the sprint field; weekly deletes", async () => {
  const { store, writes, scopes } = fakeStore();
  const issue = (key: string, updated: string) => ({
    key, fields: {
      summary: "Ship it", status: { name: "In Progress", statusCategory: { name: "In Progress" } }, project: { key: "PRJ" }, updated,
      assignee: { accountId: "a1", displayName: "Ann", emailAddress: "ann@x" }, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }] },
      customfield_10020: [{ id: 7, boardId: 3, name: "Sprint 7", state: "active", startDate: "2026-11-03T00:00:00Z", endDate: "2026-11-17T00:00:00Z" }],
    },
  });
  let issues = [issue("PRJ-1", "2026-11-10T10:00:00.000+0000")];
  const jql: string[] = [];
  const call = async (_tool: string, args: Record<string, any>) => {
    jql.push(args.jql);
    return { content: [{ type: "text", text: JSON.stringify({ issues: args.fields[0] === "updated" ? [{ key: "PRJ-1" }] : issues, isLast: true }) }] };
  };
  const now = Date.parse("2026-11-11T00:00:00Z");
  await syncJira(store, call, "https://acme.atlassian.net", now);
  expect(jql[0]).toBe(`updated >= -${30 * 24 * 60 + 5}m ORDER BY updated ASC`);
  expect(writes.find((w) => w.table === "issue")).toMatchObject({ row: { key: "PRJ-1", project: "PRJ", sprint: "Sprint 7", sprint_ids: [7], description: "Details", url: "https://acme.atlassian.net/browse/PRJ-1" }, baseline: true });
  expect(writes.find((w) => w.table === "sprint")).toMatchObject({ row: { sprint_id: 7, board_id: 3, state: "active" }, baseline: true });
  expect(writes.find((w) => w.table === "users")?.row).toMatchObject({ user_id: "a1", email: "ann@x" });
  expect(scopes.get("issues")).toEqual({ baselined: true, cursor: "2026-11-10T10:00:00.000Z" });

  writes.length = 0;
  jql.length = 0;
  issues = [issue("PRJ-2", "2026-11-11T07:00:00.000+0000")];
  await syncJira(store, call, "https://acme.atlassian.net", now + 8 * 86_400_000); // a week later: the delete check runs too
  expect(jql[0]).toMatch(/^updated >= -\d+m ORDER BY updated ASC$/);
  expect(writes.find((w) => w.table === "issue")).toMatchObject({ row: { key: "PRJ-2" }, baseline: false });
  expect(writes.filter((w) => w.row.deleted === true)).toEqual([{ table: "issue", row: { key: "PRJ-9", deleted: true }, baseline: false }]);
});

it("src_jira boards: boards, their filter and project keys, and board sprints land as baseline; a tool error is thrown for the ingest run", async () => {
  const { store, writes, scopes } = fakeStore();
  const json = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const call = async (tool: string, args: Record<string, any>) => {
    if (tool === "listJiraBoards") return json({ values: [{ id: 3, name: "PRJ board", type: "scrum", location: { projectKey: "PRJ" } }], isLast: true });
    if (tool === "getJiraBoardConfig") return json({ id: args.boardId, filter: { id: "10001", query: "project = PRJ ORDER BY Rank" } });
    return json({ values: [{ id: 7, state: "active", startDate: "2026-11-03T00:00:00Z", endDate: "2026-11-17T00:00:00Z" }] });
  };
  await syncBoards(store, call, Date.parse("2026-11-11T00:00:00Z"));
  expect(writes.find((w) => w.table === "board")).toMatchObject({ row: { board_id: 3, name: "PRJ board", type: "scrum", project_keys: ["PRJ"], filter_jql: "project = PRJ ORDER BY Rank" }, baseline: true });
  expect(writes.find((w) => w.table === "board_sprint")).toMatchObject({ row: { board_id: 3, sprint_id: 7, state: "active" }, baseline: true });
  await syncBoards(store, call);
  expect(writes.filter((w) => w.table === "board").at(-1)?.baseline).toBe(false);
  expect(scopes.get("boards")?.baselined).toBe(true);
  await expect(syncBoards(store, async () => ({ isError: true, content: [{ type: "text", text: 'Unknown operation "listJiraBoards"' }] }))).rejects.toThrow(/Unknown operation/);
});

it("src_jira boards: a kanban board is stored without asking for its sprints, and one board's sprint error doesn't fail the pass", async () => {
  const { store, writes } = fakeStore();
  const json = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const asked: number[] = [];
  const call = async (tool: string, args: Record<string, any>) => {
    if (tool === "listJiraBoards") return json({ values: [{ id: 3, name: "K", type: "kanban" }, { id: 4, name: "S", type: "scrum" }, { id: 5, name: "S2", type: "scrum" }], isLast: true });
    if (tool === "getJiraBoardConfig") return json({ id: args.boardId });
    asked.push(args.boardId);
    if (args.boardId === 4) return { isError: true, content: [{ type: "text", text: "400 The board does not support sprints" }] };
    return json({ values: [{ id: 9, state: "active" }] });
  };
  await syncBoards(store, call);
  expect(asked).toEqual([4, 5]);
  expect(writes.filter((w) => w.table === "board").length).toBe(3);
  expect(writes.find((w) => w.table === "board_sprint")).toMatchObject({ row: { board_id: 5, sprint_id: 9 } });
});

it("src_jira history: each listed project is read once as baseline rows, resumes after a budget stop, one failing project doesn't stop the others, a new project is picked up", async () => {
  const { store, writes, scopes } = fakeStore();
  const issue = (key: string, updated: string) => ({ key, fields: { summary: "Old", project: { key: key.split("-")[0] }, updated } });
  const jql: string[] = [];
  let boom = true;
  const call = async (_tool: string, args: Record<string, any>) => {
    jql.push(args.jql);
    if (args.jql.includes('"BAD"') && boom) return { isError: true, content: [{ type: "text", text: "nope" }] };
    const key = /project = "(\w+)"/.exec(args.jql)![1];
    return { content: [{ type: "text", text: JSON.stringify({ issues: [issue(`${key}-1`, "2026-03-01T10:00:00.000+0000")], isLast: true }) }] };
  };
  const now = Date.parse("2026-11-11T00:00:00Z");
  await syncHistory(store, call, "https://acme.atlassian.net", ["AGR", "BAD", "TRM"], 365, now);
  expect(jql[0]).toBe(`project = "AGR" AND updated >= -${365 * 24 * 60 + 5}m ORDER BY updated ASC`);
  expect(writes.filter((w) => w.table === "issue").map((w) => [w.row.key, w.baseline])).toEqual([["AGR-1", true], ["TRM-1", true]]); // BAD failed, TRM still ran
  expect(scopes.get("history:AGR")?.baselined).toBe(true);
  expect(scopes.get("history:BAD")?.baselined).toBe(false);

  writes.length = 0;
  jql.length = 0;
  boom = false;
  await syncHistory(store, call, "https://acme.atlassian.net", ["AGR", "BAD", "TRM", "POS"], 365, now + 1000);
  expect(jql.map((q) => /"(\w+)"/.exec(q)![1])).toEqual(["BAD", "POS"]); // finished projects are never re-read
  expect(scopes.get("history:BAD")?.baselined).toBe(true);

  jql.length = 0;
  await syncHistory(store, call, "https://acme.atlassian.net", ["QQQ"], 365, now, 0); // zero budget: stops before starting
  expect(jql).toEqual([]);
});
