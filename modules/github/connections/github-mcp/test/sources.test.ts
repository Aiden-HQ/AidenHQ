import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { itemRow, startSync, syncOrg } from "../src/sources.js";
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

// startSync's first tick runs 30 s in; the tests drive the clock, so they don't wait for it.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The scope store plus the two statements a retirement writes: the retired ingest_run row and the scope rows' delete. The
// writer holds an org's rows as the sync scopes it writes: `issues:<org>`, `prs:<org>` and `board:<org>/<number>` (the
// `org:<org>` pass name has no row of its own).
function retireStore(orgs: string[]) {
  const held = new Map(orgs.flatMap((o) => [`issues:${o}`, `prs:${o}`, `board:${o}/1`].map((s) => [s, { baselined: true, cursor: "2026-11-10T00:00:00Z", syncedAt: 0 }] as [string, { baselined: boolean; cursor: string | null; syncedAt: number }])));
  const retired: { source: string; scope: string; error: string | null; status: string }[] = [];
  const deleted: string[] = [];
  const queries: string[] = [];
  const store = {
    scopesByPrefix: async (prefix: string) => new Map([...held].filter(([s]) => s.startsWith(prefix))),
    run: async (_source: string, _scope: string, fn: () => Promise<number>) => fn(),
    migrate: async () => undefined,
    scope: async () => ({ baselined: true, cursor: null }),
    saveScope: async () => undefined,
    upsert: async () => "same",
    pool: {
      query: async (sql: string, p: any[] = []) => {
        queries.push(sql);
        if (sql.startsWith("INSERT INTO src_meta.ingest_run")) retired.push({ source: p[0], scope: p[1], error: null, status: "retired" });
        if (sql.startsWith("DELETE FROM src_github.scope")) {
          deleted.push(p[0]);
          held.delete(p[0]);
        }
        return { rows: [] };
      },
    },
  };
  return { store: store as unknown as SourceStore, held, retired, deleted, queries };
}

it("src_github: an org dropped from the configured list gets one retired ingest_run row and loses its scope rows; a re-start writes nothing", async () => {
  const { store, held, retired, deleted } = retireStore(["acme", "kept"]);
  startSync(store, { account: async () => ({ user: false, projects: false }), request: async () => ({ items: [] }) } as any, ["kept"], { info: () => {}, warn: () => {} } as any);
  await vi.advanceTimersByTimeAsync(30_000);

  expect(retired).toEqual([{ source: "github", scope: "org:acme", error: null, status: "retired" }]);
  expect(deleted.sort()).toEqual(["board:acme/1", "issues:acme", "prs:acme"]);
  expect([...held.keys()].filter((s) => s.includes("acme"))).toEqual([]);
  expect([...held.keys()].filter((s) => s.includes("kept"))).toHaveLength(3);

  // A second start (the process restarts, or a later tick) finds the rows gone and writes nothing new.
  retired.length = 0;
  deleted.length = 0;
  startSync(store, { account: async () => ({ user: false, projects: false }), request: async () => ({ items: [] }) } as any, ["kept"], { info: () => {}, warn: () => {} } as any);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(retired).toEqual([]);
  expect(deleted).toEqual([]);
});

it("src_github: an org name compares case-insensitively, and no configured org is retired", async () => {
  const { store, retired, deleted } = retireStore(["Acme", "Kept"]);
  startSync(store, { account: async () => ({ user: false, projects: false }), request: async () => ({ items: [] }) } as any, ["acme", "kept"], { info: () => {}, warn: () => {} } as any);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(retired).toEqual([]);
  expect(deleted).toEqual([]);
});
