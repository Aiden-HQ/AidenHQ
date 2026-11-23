import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { scopeIssues, sourceHealth, type WarehouseDeps } from "../src/sources.js";

// /internal/sources' two scope lists (sources.ts scopeIssues) against real Postgres SQL (PGlite): a scope whose newest pass is
// `status = 'retired'` is in neither, and a re-added scope whose newest pass is a normal failure returns to both.
const H = 3_600_000;

async function setup() {
  const pg = new PGlite();
  await pg.exec(`CREATE SCHEMA src_meta;
    CREATE TABLE src_meta.ingest_run (
      id bigserial PRIMARY KEY, source text NOT NULL, scope text NOT NULL, started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL DEFAULT now(), rows integer NOT NULL DEFAULT 0, error text, commit text, status text,
      total integer, fetched integer);`);
  let t = Date.now();
  // One pass: `ago` hours before now. `error` null is a good pass; `retired` writes the non-error marker.
  const run = async (scope: string, ago: number, o: { error?: string; status?: string; total?: number; fetched?: number } = {}) =>
    pg.query(
      `INSERT INTO src_meta.ingest_run (source, scope, started_at, finished_at, rows, error, status, total, fetched) VALUES ('github', $1, $2, $2, 0, $3, $4, $5, $6)`,
      [scope, new Date(t - ago * H), o.error ?? null, o.status ?? null, o.total ?? null, o.fetched ?? null],
    );
  const deps = { pool: { query: (text: string, values?: unknown[]) => pg.query(text, values as never[]) as never } } as unknown as Pick<WarehouseDeps, "pool">;
  return { pg, run, deps };
}

it("a retired scope is in neither list; the same scope failing again returns to both", async () => {
  const { run, deps } = await setup();
  // Kept: failing every pass for over a day.
  await run("org:kept", 30, { error: "boom" });
  await run("org:kept", 2, { error: "boom" });
  // Removed: its last passes failed, then its writer retired it. No newer pass ever comes.
  await run("org:removed", 50, { error: "org restricts OAuth apps" });
  await run("org:removed", 45, { error: "org restricts OAuth apps" });
  await run("org:removed", 40, { status: "retired" });
  // Short: the last two completed passes both fetched fewer records than the source held.
  await run("org:short", 30, { total: 10, fetched: 8 });
  await run("org:short", 2, { total: 10, fetched: 8 });
  // A short scope then retired: out too.
  await run("org:short-removed", 30, { total: 10, fetched: 8 });
  await run("org:short-removed", 2, { total: 10, fetched: 8 });
  await run("org:short-removed", 1, { status: "retired" });

  const first = await scopeIssues(deps);
  expect(first.failing.map((r) => r.scope)).toEqual(["org:kept"]);
  expect(first.short.map((r) => r.scope)).toEqual(["org:short"]);

  // Later it is configured again: its re-sync baselines (a good pass), then every pass fails, so its key returns by itself.
  await run("org:removed", 28, { total: 3, fetched: 3 });
  await run("org:removed", 26, { error: "org restricts OAuth apps" });
  await run("org:removed", 1, { error: "org restricts OAuth apps" });
  const again = await scopeIssues(deps);
  expect(again.failing.map((r) => r.scope).sort()).toEqual(["org:kept", "org:removed"]);
  expect(again.short.map((r) => r.scope)).toEqual(["org:short"]);
});

it("a re-added scope starts fresh: failures and short passes from before its retirement never reopen its key", async () => {
  const { run, deps } = await setup();
  // Failed for days, retired, then re-added minutes ago and its first pass failed: not yet 24 hours of failures.
  await run("org:acme", 50, { error: "boom" });
  await run("org:acme", 45, { error: "boom" });
  await run("org:acme", 40, { status: "retired" });
  await run("org:acme", 0.1, { error: "boom" });
  // A scope short in its last two passes before the retirement, re-added and now passing normally: not short.
  await run("org:short", 50, { total: 10, fetched: 8 });
  await run("org:short", 45, { total: 10, fetched: 8 });
  await run("org:short", 40, { status: "retired" });
  await run("org:short", 0.1, { total: 10, fetched: 10 });

  const out = await scopeIssues(deps);
  expect(out.failing.map((r) => r.scope)).toEqual([]);
  expect(out.short.map((r) => r.scope)).toEqual([]);
});

it("a retirement marker never counts as a source's or a scope's last good pass, and a fully retired source drops out", async () => {
  const { run, deps } = await setup();
  await run("org:acme", 40, { error: "boom" });
  await run("org:acme", 1, { status: "retired" });
  // This scope's only non-error row is a marker: it is not a good pass. With nothing else synced, the source drops out.
  expect(await sourceHealth(deps)).toEqual([]);

  // A still-synced scope keeps the source reported, and the retirement marker is not its last good pass.
  await run("org:live", 3, { total: 5, fetched: 5 });
  await run("org:live", 0.1, { error: "boom" });
  expect(await sourceHealth(deps)).toEqual([{ source: "github", last_ok: expect.any(Date), failing: true }]);

  // Every scope retired: the source is not reported at all (its sync is off).
  await run("org:live", 0.05, { status: "retired" });
  expect(await sourceHealth(deps)).toEqual([]);
});

it("a retired row is only the newest one that counts: an older retirement does not hide a later failure", async () => {
  const { run, deps } = await setup();
  await run("org:acme", 40, { status: "retired" });
  await run("org:acme", 30, { error: "boom" });
  await run("org:acme", 1, { error: "boom" });
  const out = await scopeIssues(deps);
  expect(out.failing.map((r) => r.scope)).toEqual(["org:acme"]);
});
