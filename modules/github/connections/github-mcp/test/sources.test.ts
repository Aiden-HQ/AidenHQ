import { expect, it } from "vitest";
import { itemRow, syncOrg } from "../src/sources.js";
import type { SourceStore } from "../src/source-store.js";

// The writer side against a fake store: what lands, and with which baseline flag (the SQL itself was smoke-run on postgres:17).
function fakeStore() {
  const scopes = new Map<string, { baselined: boolean; cursor: string | null }>();
  const writes: { table: string; row: Record<string, any>; baseline: boolean }[] = [];
  const onBoard = new Map<string, string | null>(); // item_id -> its stored content_type (null: stored without content)
  const store = {
    migrate: async () => undefined,
    scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
    saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor: cursor ?? scopes.get(s)?.cursor ?? null }),
    upsert: async (t: { name: string }, row: Record<string, any>, o: { baseline: boolean }) => {
      if (t.name === "project_item") void (row.removed ? onBoard.delete(row.item_id) : onBoard.set(row.item_id, "content_type" in row ? row.content_type : (onBoard.get(row.item_id) ?? null)));
      return (writes.push({ table: t.name, row, baseline: o.baseline }), "new");
    },
    pool: { query: async () => ({ rows: [...onBoard].map(([item_id, content_type]) => ({ item_id, content_type })) }) },
  };
  return { store: store as unknown as SourceStore, writes, scopes };
}

it("src_github: an org's first sync is a baseline (issues, PRs, boards); later passes read from the cursor; items gone from a board are removed", async () => {
  const { store, writes, scopes } = fakeStore();
  const issue = (n: number, updated: string, pr = false) => ({
    number: n, title: `t${n}`, body: "b", state: "open", user: { id: 1, login: "ann" }, assignees: [], labels: [{ name: "p1" }], html_url: `https://github.com/o/r/issues/${n}`,
    repository_url: "https://api.github.com/repos/o/r", created_at: updated, updated_at: updated, ...(pr ? { pull_request: { merged_at: null } } : {}),
  });
  let items = [{ id: "I1", updatedAt: "2026-11-10T00:00:00Z", content: { __typename: "Issue", title: "Ship", url: "u", number: 1, state: "OPEN", repository: { nameWithOwner: "o/r" } }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", field: { name: "Status" } }] } }];
  let issues = [issue(1, "2026-11-10T00:00:00Z")];
  const queries: string[] = [];
  const gh = {
    account: async () => ({ user: false, projects: true }),
    request: async (_org: string, _m: string, path: string, body?: any) => {
      if (path.startsWith("/search/issues")) {
        queries.push(decodeURIComponent(path));
        return { items: path.includes("pull-request") ? [] : issues };
      }
      if (body.query.includes("projectsV2(")) return { data: { organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [{ number: 5, title: "Roadmap", url: "b", closed: false, updatedAt: "x" }] } } } };
      return { data: { organization: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: items } } } } };
    },
  };

  await syncOrg(store, gh as any, "o", Date.parse("2026-11-11T00:00:00Z"));
  expect(queries[0]).toContain("org:o is:issue updated:>=2026-10-12T00:00:00Z"); // the baseline window
  expect(writes.find((w) => w.table === "issue")).toMatchObject({ row: { repo: "o/r", number: 1, kind: "issue", labels: ["p1"] }, baseline: true });
  expect(writes.find((w) => w.table === "project_item")).toMatchObject({ row: { project: "o/5", item_id: "I1", fields: { Status: "Todo" } }, baseline: true });
  expect(writes.find((w) => w.table === "users")?.row).toEqual({ user_id: "1", handle: "ann", is_bot: false });
  expect(scopes.get("issues:o")).toEqual({ baselined: true, cursor: "2026-11-10T00:00:00Z" });

  writes.length = 0;
  queries.length = 0;
  issues = [issue(2, "2026-11-11T01:00:00Z")];
  items = [];
  await syncOrg(store, gh as any, "o", Date.parse("2026-11-11T02:00:00Z")); // boards are read at most hourly
  expect(queries[0]).toContain("updated:>=2026-11-10T00:00:00Z");
  expect(writes.find((w) => w.table === "issue")).toMatchObject({ row: { number: 2 }, baseline: false });
  expect(writes.filter((w) => w.table === "project_item")).toEqual([{ table: "project_item", row: { project: "o/5", item_id: "I1", removed: true }, baseline: false }]);
});

it("an item whose content GitHub refused writes only the board's own columns", () => {
  const row = itemRow("acme/1", { id: "i1", content: null, updatedAt: "t", fieldValues: { nodes: [] } }, true);
  expect(Object.keys(row).sort()).toEqual(["archived", "fields", "item_id", "project", "removed", "source_updated_at"]);
});

it("an item that simply has no content is written as returned", () => {
  expect(itemRow("acme/1", { id: "i1", content: null, updatedAt: "t", fieldValues: { nodes: [] } })).toMatchObject({ title: null, url: null, state: null, labels: [] });
});

it("src_github: only the item whose own error is the content refusal keeps its stored details", async () => {
  const { store, writes } = fakeStore();
  const nodes = [{ id: "A", updatedAt: "t", content: null, fieldValues: { nodes: [] } }, { id: "B", updatedAt: "t", content: null, fieldValues: { nodes: [] } }];
  const gh = {
    account: async () => ({ user: false, projects: true }),
    request: async (_o: string, _m: string, path: string, body?: any) => {
      if (path.startsWith("/search/issues")) return { items: [] };
      if (body.query.includes("projectsV2(")) return { data: { organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [{ number: 5, title: "R", url: "b", closed: false, updatedAt: "x" }] } } } };
      return { data: { organization: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes } } } }, errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 1, "content"], message: "m" }] };
    },
  };
  await syncOrg(store, gh as any, "o", Date.parse("2026-11-11T00:00:00Z"));
  const rows = writes.filter((w) => w.table === "project_item").map((w) => w.row);
  expect("title" in rows.find((r) => r.item_id === "A")!).toBe(true);
  expect("title" in rows.find((r) => r.item_id === "B")!).toBe(false);
});

it("src_github: a closed board with a refused item is read again weekly, and an item's first content read is a backfill", async () => {
  const { store, scopes, writes } = fakeStore();
  let granted = false;
  const node = () => ({ id: "A", updatedAt: "t", content: granted ? { __typename: "Issue", title: "T", url: "u", number: 1, state: "OPEN", repository: { nameWithOwner: "x/y" } } : null, fieldValues: { nodes: [] } });
  let reads = 0;
  const gh = {
    account: async () => ({ user: false, projects: true }),
    request: async (_o: string, _m: string, path: string, body?: any) => {
      if (path.startsWith("/search/issues")) return { items: [] };
      if (body.query.includes("projectsV2(")) return { data: { organization: { projectsV2: { pageInfo: { hasNextPage: false }, nodes: [{ number: 5, title: "R", url: "b", closed: true, updatedAt: "x" }] } } } };
      reads++;
      return { data: { organization: { projectV2: { items: { pageInfo: { hasNextPage: false }, nodes: [node()] } } } }, ...(granted ? {} : { errors: [{ type: "FORBIDDEN", path: ["organization", "projectV2", "items", "nodes", 0, "content"], message: "m" }] }) };
    },
  };
  await syncOrg(store, gh as any, "o", Date.parse("2026-11-11T00:00:00Z"));
  expect(scopes.get("board:o/5")?.baselined).toBe(true);
  await syncOrg(store, gh as any, "o", Date.parse("2026-11-12T00:00:00Z"));
  expect(reads).toBe(1);
  granted = true;
  await syncOrg(store, gh as any, "o", Date.parse("2026-11-19T00:00:01Z"));
  expect(reads).toBe(2);
  const last = writes.filter((w) => w.table === "project_item").slice(-2);
  expect(last[0]).toMatchObject({ row: { title: "T" }, baseline: true }); // the content first: backfill
  expect(last[1]).toMatchObject({ baseline: false, row: { url: "u" } }); // then the board's own columns: normal change logging, the change record's link
  expect("title" in last[1]!.row).toBe(false);
});
