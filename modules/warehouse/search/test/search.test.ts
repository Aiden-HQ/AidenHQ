// Task search (search.ts) against real Postgres SQL (PGlite with pgvector): the rebuild's generation guard and idempotency,
// deletion only on a confirmed 404, keyword and meaning hits together with summaries off, and a failed query embedding
// answering with keyword hits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PER_SIDE, createSearch, gatewayModels, type Issue, type Models } from "../src/search.ts";

async function setup({ issues, failEmbed = () => false, listFails = () => false, hang = () => false, recent = () => [], summarize, slowEmbed, reconcileTimeoutMs }: { issues: Map<string, Issue>; failEmbed?: (texts: string[]) => boolean; listFails?: (offset: number) => boolean; hang?: () => boolean; reconcileTimeoutMs?: number; recent?: () => Issue[]; summarize?: () => Models["summarize"]; slowEmbed?: () => Promise<void> }) {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec("CREATE EXTENSION vector; CREATE SCHEMA src_meta; CREATE SEQUENCE src_meta.seq; CREATE SCHEMA src_tasks;");
  const db = new DatabaseSync(":memory:");
  let t = Date.parse("2026-11-23T10:00:00Z");
  const embeds: string[][] = [];
  // Meaning, faked: one axis per topic, so "critique" is near a code-review task without sharing a word with it.
  const axis = (s: string) => [/review|critique/i.test(s) ? 1 : 0, /kernel|scheduler/i.test(s) ? 1 : 0, 0.05];
  const models: Models = {
    model: "acme/embed-1", threshold: 0.8,
    embed: async (texts) => { embeds.push(texts); await slowEmbed?.(); if (failEmbed(texts)) throw new Error("upstream down"); return texts.map(axis); },
  };
  const search = createSearch({
    db, facts: async () => ({ facts: [], tail: 0 }), sql: () => pg as never, migrate: (ddl) => pg.exec(ddl).then(() => undefined), models: () => ({ ...models, ...(summarize?.() ? { summarize: summarize() } : {}) }), now: () => t, reconcileTimeoutMs,
    cp: {
      company: async () => "co-1",
      issue: async (id) => issues.get(id) ?? null,
      comments: async () => [],
      list: async (_c, offset, limit) => { if (hang()) return new Promise<Issue[]>(() => {}); if (listFails(offset)) throw new Error("control plane 502"); return [...issues.values()].slice(offset, offset + limit); },
      recent: async () => recent(),
    },
    local: async () => ({ prs: [], paths: [], final: "" }), agentName: async () => null, projectName: async () => null,
  });
  const drain = async () => { t += 60_000; while (await search.tick()) t += 60_000; };
  return { pg, db, search, embeds, drain, advance: (ms: number) => (t += ms), now: () => t };
}

const issue = (id: string, title: string, over: Partial<Issue> = {}): Issue => ({ id, companyId: "co-1", identifier: `WOR-${id.slice(-2)}`, title, description: "", status: "todo", updatedAt: "2026-11-23T09:00:00Z", ...over });

test("a rebuild is idempotent, and an older generation never overwrites a newer row", async () => {
  const issues = new Map([["t-01", issue("t-01", "Code-review lens for module repos")]]);
  const { pg, search, embeds, drain } = await setup({ issues });
  search.mark("t-01");
  await drain();
  const row = async () => (await pg.query<{ title: string; gen: number; has: boolean }>("SELECT title, gen, embedding IS NOT NULL AS has FROM src_tasks.task_search WHERE task_id = 't-01'")).rows[0]!;
  assert.deepEqual({ ...(await row()), gen: undefined }, { title: "Code-review lens for module repos", gen: undefined, has: true });
  const first = Number((await row()).gen);
  // Unchanged input: rebuilt at a newer generation without asking for the embedding again.
  search.mark("t-01");
  await drain();
  assert.equal(embeds.length, 1);
  assert.ok(Number((await row()).gen) > first);
  // A late answer from an older generation changes nothing.
  issues.set("t-01", issue("t-01", "Stale title"));
  await search.rebuild("t-01", first);
  assert.equal((await row()).title, "Code-review lens for module repos");
});

test("a failed embed still indexes the row for keywords and comes back for its vector", async () => {
  const issues = new Map([["t-02", issue("t-02", "Kernel scheduler drains on restart")]]);
  let down = true;
  const { search, drain, advance } = await setup({ issues, failEmbed: () => down });
  search.mark("t-02");
  await drain();
  assert.equal(search.pending(), 1, "still dirty");
  down = false;
  const hit = await search.search("scheduler");
  assert.deepEqual(hit.hits.map((h) => h.identifier), ["WOR-02"]);
  advance(3600_000);
  await drain();
  assert.equal(search.pending(), 0);
  assert.deepEqual((await search.search("restart policies of the kernel")).hits.map((h) => h.identifier), ["WOR-02"], "a meaning hit once the vector landed");
});

test("deletion needs a complete listing and a 404; a late write can't bring a tombstone back", async () => {
  const issues = new Map([["t-03", issue("t-03", "Warehouse backups")], ["t-04", issue("t-04", "Review the board")]]);
  let failing = false;
  const { pg, search, drain } = await setup({ issues, listFails: (offset) => failing && offset === 0 });
  search.mark("t-03");
  search.mark("t-04");
  await drain();
  const gone = issues.get("t-03")!;
  issues.delete("t-03");
  failing = true;
  assert.deepEqual(await search.reconcile(), { listed: 0, marked: 0, complete: false }, "a failed listing marks nothing");
  failing = false;
  assert.equal((await search.reconcile()).complete, true);
  await drain();
  const live = async () => (await pg.query<{ task_id: string }>("SELECT task_id FROM src_tasks.task_search WHERE NOT deleted ORDER BY 1")).rows.map((r) => r.task_id);
  assert.deepEqual(await live(), ["t-04"], "t-03 confirmed gone");
  issues.set("t-03", gone);
  await search.rebuild("t-03", 1);
  assert.deepEqual(await live(), ["t-04"], "an older generation can't resurrect it");
});

test("keyword and meaning hits come back together with summaries off; a failed query embedding keeps the keyword hits", async () => {
  const issues = new Map([["t-05", issue("t-05", "Code-review lenses")], ["t-06", issue("t-06", "Critique module for pull requests")], ["t-07", issue("t-07", "Kernel restarts")]]);
  let queryDown = false;
  const { search, drain } = await setup({ issues, failEmbed: (texts) => queryDown && texts[0] === "lenses review" });
  for (const id of issues.keys()) search.mark(id);
  await drain();
  const both = await search.search("lenses review");
  assert.equal(both.semantic, true);
  assert.deepEqual(both.hits.map((h) => h.identifier).sort(), ["WOR-05", "WOR-06"], "WOR-05 by its words, WOR-06 by meaning");
  assert.equal(both.hits[0]!.identifier, "WOR-05", "matched both ways, it ranks first");
  queryDown = true;
  const words = await search.search("lenses review");
  assert.deepEqual({ semantic: words.semantic, hits: words.hits.map((h) => h.identifier) }, { semantic: false, hits: ["WOR-05"] });
  assert.deepEqual((await search.search("WOR-0")).hits.map((h) => h.identifier).sort(), ["WOR-05", "WOR-06", "WOR-07"], "a half-typed identifier is a prefix");
});

test("tasks closed before the window page out newest first by a cursor", async () => {
  const closed = (id: string, at: string) => issue(id, "Lens cleanup", { status: "done", completedAt: at, updatedAt: at });
  const issues = new Map([["t-10", issue("t-10", "Lens work in progress")], ["t-11", closed("t-11", "2026-09-01T00:00:00Z")], ["t-12", closed("t-12", "2026-10-01T00:00:00Z")], ["t-13", closed("t-13", "2026-08-01T00:00:00Z")], ["t-14", closed("t-14", "2026-11-22T00:00:00Z")]]);
  const { search, drain } = await setup({ issues });
  for (const id of issues.keys()) search.mark(id);
  await drain();
  const first = await search.search("lens", { closedBefore: "2026-11-21T00:00:00Z", limit: 2 });
  assert.deepEqual(first.hits.map((h) => h.id).sort(), ["t-10", "t-14"]);
  assert.deepEqual(first.recent.map((h) => h.id), ["t-14"], "a close inside the window comes as a card too");
  assert.deepEqual(first.done.map((h) => h.id), ["t-12", "t-11"]);
  const rest = await search.search("lens", { closedBefore: "2026-11-21T00:00:00Z", limit: 2, after: first.next! });
  assert.deepEqual({ done: rest.done.map((h) => h.id), next: rest.next }, { done: ["t-13"], next: null });
});

test("each side brings its best PER_SIDE, so a word every task shares doesn't return them all", async () => {
  const issues = new Map(Array.from({ length: PER_SIDE + 5 }, (_, i) => { const id = `t-${String(100 + i)}`; return [id, issue(id, `Review lens ${i}`, { identifier: `WOR-${100 + i}` })] as const; }));
  const { search, drain } = await setup({ issues });
  for (const id of issues.keys()) search.mark(id);
  await drain();
  assert.equal((await search.search("lens")).hits.length, PER_SIDE, "keyword side");
  assert.equal((await search.search("critique")).hits.length, PER_SIDE, "meaning side");
});

test("an identifier query is keyword only and ranks its own task first; a term's words match as a phrase", async () => {
  const issues = new Map([
    ["t-20", issue("t-20", "Kernel scheduler", { identifier: "WOR-1" })],
    ["t-21", issue("t-21", "Review lens, after WOR-1", { identifier: "WOR-10", description: "Follows WOR-1." })],
    ["t-22", issue("t-22", "task_wait answers early", { identifier: "WOR-11" })],
    ["t-23", issue("t-23", "A task that should wait for review", { identifier: "WOR-12" })],
  ]);
  const { search, drain, embeds } = await setup({ issues });
  for (const id of issues.keys()) search.mark(id);
  await drain();
  const asked = embeds.length;
  const r = await search.search("WOR-1");
  assert.equal(r.hits[0]!.identifier, "WOR-1", "its own task first, ahead of the tasks citing it and the prefix matches");
  assert.equal(r.semantic, true);
  assert.equal(embeds.length, asked, "no query embedding for an identifier");
  assert.deepEqual((await search.search("task_wait")).hits.map((h) => h.identifier), ["WOR-11"], "not task and wait anywhere");
});

test("live changes go before the backfill, and a fresh edit pulls a backed-off retry forward", async () => {
  const issues = new Map(Array.from({ length: 30 }, (_, i) => [`t-${20 + i}`, issue(`t-${20 + i}`, `Backlog item ${i}`)] as const));
  let down = true;
  const { pg, db, search, advance, now } = await setup({ issues, failEmbed: (texts) => down && texts[0]!.includes("Flaky") });
  const title = async (id: string) => (await pg.query<{ title: string }>("SELECT title FROM src_tasks.task_search WHERE task_id = $1", [id])).rows[0]?.title;
  assert.equal((await search.reconcile()).marked, 30);
  // A task changed after the backfill was queued: the next tick (24 rebuilds) takes it first.
  issues.set("t-60", issue("t-60", "Flaky embed"));
  search.mark("t-60");
  advance(30_000);
  await search.tick();
  assert.equal(await title("t-60"), "Flaky embed");
  // Its embed failed: backed off (as after many failures, an hour). An edit brings it back within the quiet window.
  db.prepare("UPDATE search_dirty SET due = ? WHERE task = 't-60'").run(now() + 3600_000);
  down = false;
  issues.set("t-60", issue("t-60", "Renamed task"));
  search.mark("t-60");
  advance(30_000);
  await search.tick();
  await search.tick();
  assert.equal(await title("t-60"), "Renamed task");
});

test("an older closed hit carries its crew: the agents on its subtasks", async () => {
  const at = "2026-09-01T00:00:00Z";
  const issues = new Map([
    ["t-70", issue("t-70", "Lens rollout", { status: "done", completedAt: at, updatedAt: at, assigneeAgentId: "a-1" })],
    ["t-71", issue("t-71", "Part one", { parentId: "t-70", assigneeAgentId: "a-2" })],
    ["t-72", issue("t-72", "Part two", { parentId: "t-70", assigneeAgentId: "a-1" })],
  ]);
  const { search, drain } = await setup({ issues });
  for (const id of issues.keys()) search.mark(id);
  await drain();
  const r = await search.search("lens", { closedBefore: "2026-11-21T00:00:00Z" });
  assert.deepEqual(r.done.map((h) => [h.id, h.crew]), [["t-70", ["a-2"]]]);
});

test("an edit that makes no fact is found among the recently updated tasks and rebuilt", async () => {
  const issues = new Map([["t-80", issue("t-80", "Old title")]]);
  const { pg, search, drain, advance } = await setup({ issues, recent: () => [...issues.values()] });
  search.mark("t-80");
  await drain();
  issues.set("t-80", issue("t-80", "New title", { updatedAt: "2026-11-23T11:00:00Z" }));
  advance(20_000);
  await search.tick(); // the poll marks it
  await drain();
  assert.equal((await pg.query<{ title: string }>("SELECT title FROM src_tasks.task_search WHERE task_id = 't-80'")).rows[0]!.title, "New title");
});

test("a queue behind the rows (a crash, a restored backup) moves past them instead of dropping the change", async () => {
  const issues = new Map([["t-90", issue("t-90", "Before", { status: "blocked" })]]);
  const { pg, db, search, drain } = await setup({ issues });
  search.mark("t-90");
  await drain();
  db.prepare("UPDATE search_meta SET v = '0' WHERE k = 'gen'").run(); // the counter starts over below the stored row
  issues.set("t-90", issue("t-90", "After", { status: "blocked" }));
  search.mark("t-90");
  await drain(); // refused by the stored row: marked again above it
  await drain();
  assert.equal((await pg.query<{ title: string }>("SELECT title FROM src_tasks.task_search WHERE task_id = 't-90'")).rows[0]!.title, "After");
  assert.equal(search.pending(), 0);
  assert.deepEqual((await search.search("blocked")).hits.map((h) => h.id), ["t-90"], "its status is a keyword");
});

test("a failed summary comes back for it, and turning summaries off redoes the summarized rows", async () => {
  const issues = new Map([["t-95", issue("t-95", "Summarize me")]]);
  let on = true, down = true;
  const summarize = async () => { if (down) throw new Error("timeout"); return { summary: "About lenses.", tags: ["lens"] }; };
  const { pg, search, drain, advance } = await setup({ issues, summarize: () => (on ? summarize : undefined) });
  search.mark("t-95");
  await drain();
  assert.equal(search.pending(), 1, "indexed, and back for its summary");
  down = false;
  advance(3600_000);
  await drain();
  const summary = async () => (await pg.query<{ summary: string | null }>("SELECT summary FROM src_tasks.task_search WHERE task_id = 't-95'")).rows[0]!.summary;
  assert.equal(await summary(), "About lenses.");
  on = false;
  assert.equal((await search.reconcile()).marked, 1);
  await drain();
  assert.equal(await summary(), null);
});

test("the backfill runs rebuilds in parallel, bounded, live changes first, each at its own generation", async () => {
  const issues = new Map(Array.from({ length: 40 }, (_, i) => [`t-${100 + i}`, issue(`t-${100 + i}`, `Backfill item ${i}`)] as const));
  let flying = 0, peak = 0;
  const { pg, search, advance } = await setup({ issues, slowEmbed: async () => { peak = Math.max(peak, ++flying); await new Promise((r) => setTimeout(r, 5)); flying--; } });
  assert.equal((await search.reconcile()).marked, 40);
  issues.set("t-200", issue("t-200", "Live edit"));
  search.mark("t-200");
  advance(60_000);
  assert.equal(await search.tick(), 41);
  assert.ok(peak > 1 && peak <= 8, `in flight at once: ${peak}`);
  const rows = (await pg.query<{ task_id: string; gen: number }>("SELECT task_id, gen FROM src_tasks.task_search ORDER BY gen")).rows;
  assert.equal(rows.length, 41);
  assert.equal(new Set(rows.map((r) => r.gen)).size, 41, "one generation per task");
  assert.equal(search.pending(), 0);
});

test("a summary the model cut off is a failure, and the request leaves it room and no reasoning", async () => {
  const bodies: any[] = [];
  const real = globalThis.fetch;
  let finish = "length";
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: finish === "length" ? '{"summary": "Cut o' : '{"summary":"Done.","tags":["a"]}' } }] }));
  }) as never;
  try {
    const m = gatewayModels({ url: "http://gw", token: () => "k", model: "acme/embed-1", threshold: 0.8, summaries: () => true })();
    await assert.rejects(m.summarize!("task text"), /cut off/);
    finish = "stop";
    assert.deepEqual(await m.summarize!("task text"), { summary: "Done.", tags: ["a"] });
    assert.deepEqual(bodies[0].reasoning, { enabled: false });
    assert.ok(bodies[0].max_tokens >= 1000);
  } finally { globalThis.fetch = real; }
});

test("a reconcile pass that hangs is abandoned at its deadline and the next cycle runs it again", async () => {
  const issues = new Map([["t-300", issue("t-300", "Hung listing")]]);
  let hung = true;
  const { search } = await setup({ issues, hang: () => hung, reconcileTimeoutMs: 50 });
  await assert.rejects(search.reconcileDue(), /timed out/);
  hung = false;
  assert.deepEqual(await search.reconcileDue(), { listed: 1, marked: 1, complete: true });
});
