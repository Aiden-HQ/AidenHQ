import { expect, it, vi } from "vitest";
import { ownersPage } from "../src/adapter.js";
import { selected, syncObject, syncReference } from "../src/sources.js";
import type { SourceStore } from "../src/source-store.js";

// The writer side against a fake store: what lands, with which baseline flag, and how the cursor moves (the SQL itself is the
// shared source-store's, smoke-run on postgres in the other source writers).
function fakeStore() {
  const scopes = new Map<string, { baselined: boolean; cursor: string | null }>();
  const writes: { table: string; row: Record<string, any>; baseline: boolean }[] = [];
  const store = {
    migrate: async () => undefined,
    scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
    saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor: cursor ?? scopes.get(s)?.cursor ?? null }),
    upsert: async (t: { name: string }, row: Record<string, any>, o: { baseline: boolean }) => (writes.push({ table: t.name, row, baseline: o.baseline }), "new"),
  };
  return { store: store as unknown as SourceStore, writes, scopes };
}
const json = (o: unknown) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
// HubSpot's search answer as seen live: numeric ids, `total`, and `offset` = where the next page starts.
const answer = (results: unknown[], offset = results.length, total = results.length) => json({ results, total, offset, urlTemplate: "https://app.hubspot.com/contacts/1234567/record/0-3/{id}?utm_source=mcp" });
const deal = (id: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id, properties: { dealname: "Acme renewal", pipeline: "default", dealstage: "contractsent", amount: "12000.50", hubspot_owner_id: "77", hs_lastmodifieddate: updated, ...extra },
});
const NOW = Date.parse("2026-11-17T00:00:00Z");
const opts = (extra = {}) => ({ days: 30, deadline: Date.now() + 60_000, now: NOW, ...extra });

it("deals: the first pass is baseline from history_days, later passes from the cursor; ids, owner and amount land", async () => {
  const { store, writes, scopes } = fakeStore();
  let sinceSeen = "";
  let page = [deal("1", "2026-11-10T10:00:00.000Z")];
  const call = async (tool: string, args: Record<string, any>) => {
    expect(tool).toBe("search_crm_objects");
    sinceSeen = args.filterGroups[0].filters[0].value;
    return answer(page);
  };
  await syncObject(store, call, "deals", opts());
  expect(Number(sinceSeen)).toBe(NOW - 30 * 86_400_000);
  expect(writes[0]).toMatchObject({ table: "deal", baseline: true, row: { deal_id: "1", name: "Acme renewal", stage: "contractsent", amount: 12000.5, owner_id: "77", company_ids: [], contact_ids: [], url: "https://app.hubspot.com/contacts/1234567/record/0-3/1" } });
  expect(scopes.get("deals")).toEqual({ baselined: true, cursor: "2026-11-10T10:00:00.000Z" });

  writes.length = 0;
  page = [deal("2", "2026-11-16T07:00:00.000Z")];
  await syncObject(store, call, "deals", opts());
  expect(Number(sinceSeen)).toBe(Date.parse("2026-11-10T10:00:00.000Z"));
  expect(writes[0]).toMatchObject({ row: { deal_id: "2" }, baseline: false });
});

it("odd data never fails a pass (a junk amount, no timestamp); a search error leaves the cursor and the type un-baselined", async () => {
  const { store, writes, scopes } = fakeStore();
  const odd = { id: "2", properties: { dealname: "x", amount: "n/a" } };
  await syncObject(store, async () => answer([deal("1", "2026-11-10T00:00:00.000Z"), odd, deal("3", "2026-11-12T00:00:00.000Z")]), "deals", opts());
  expect(writes.map((w) => w.row.deal_id)).toEqual(["1", "2", "3"]);
  expect(writes[1]!.row).toMatchObject({ amount: null, company_ids: [], source_updated_at: null });
  expect(scopes.get("deals")?.cursor).toBe("2026-11-12T00:00:00.000Z");
  const f2 = fakeStore();
  await expect(syncObject(f2.store, async () => ({ isError: true, content: [{ type: "text", text: "no access to deals" }] }), "deals", opts())).rejects.toThrow(/no access/);
  expect(f2.scopes.get("deals")).toEqual({ baselined: false, cursor: expect.any(String) });
});

// A fake HubSpot search over records { id, time }: GTE by time (oldest first, ties by id), or EQ time with id GT, by id.
const searchOver = (data: { id: number; time: string }[], rec: (id: number, time: string) => unknown, log: Record<string, any>[] = []) => async (_: string, args: Record<string, any>) => {
  log.push(args);
  const [mod, idf] = args.filterGroups[0].filters;
  const t = Number(mod.value);
  const hit = mod.operator === "EQ" ? data.filter((d) => Date.parse(d.time) === t && d.id > Number(idf.value)).sort((a, b) => a.id - b.id) : data.filter((d) => Date.parse(d.time) >= t).sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id - b.id);
  return answer(hit.slice(0, args.limit).map((d) => rec(d.id, d.time)), 0, hit.length);
};

it("pages by modified time (the next page starts at the last time seen); a spent budget saves the cursor and resumes", async () => {
  const t = (i: number) => new Date(NOW - 20 * 86_400_000 + i * 60_000).toISOString();
  const data = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, time: t(i) }));
  const { store, writes, scopes } = fakeStore();
  await syncObject(store, searchOver(data, (id, time) => deal(String(id), time)), "deals", opts());
  expect(new Set(writes.map((w) => w.row.deal_id)).size).toBe(450);
  expect(scopes.get("deals")).toEqual({ baselined: true, cursor: t(449) });

  const slow = fakeStore();
  await syncObject(slow.store, searchOver(data, (id, time) => deal(String(id), time)), "deals", opts({ deadline: Date.now() - 1 }));
  expect(slow.scopes.get("deals")).toEqual({ baselined: false, cursor: t(199) }); // one page read, then the budget was spent
});

it("a caught-up pass starts the next one a little before, for records HubSpot indexed late", async () => {
  const recent = new Date(NOW - 60_000).toISOString();
  const data = [{ id: 1, time: recent }];
  const { store, scopes } = fakeStore();
  await syncObject(store, searchOver(data, (id, time) => deal(String(id), time)), "deals", opts());
  expect(scopes.get("deals")?.cursor).toBe(new Date(NOW - 60_000 - 10 * 60_000).toISOString());
});

it("more than a page of records at one modified time (a bulk edit) are read by id, and a spent budget resumes inside them", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const TOTAL = 450;
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const data = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1, time: TIE }));
  const calls: Record<string, any>[] = [];
  const call = searchOver(data.concat([{ id: TOTAL + 1, time: "2026-09-02T00:00:00.000Z" }]), contact, calls);
  const { store, writes, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: TIE });
  await syncObject(store, call, "contacts", opts());
  expect(new Set(writes.map((w) => w.row.contact_id)).size).toBe(TOTAL + 1);
  expect(scopes.get("contacts")?.cursor).toBe("2026-09-02T00:00:00.000Z");

  // When the bulk edit is the newest time, finishing it moves the cursor past it (no rereading it every pass).
  const newest = fakeStore();
  newest.scopes.set("contacts", { baselined: true, cursor: TIE });
  await syncObject(newest.store, searchOver(data, contact), "contacts", opts());
  expect(newest.scopes.get("contacts")?.cursor).toBe(new Date(Date.parse(TIE) + 1).toISOString());

  // A budget that runs out inside the tie saves "<time>#<id>"; the next pass starts after that id.
  const part = fakeStore();
  part.scopes.set("contacts", { baselined: true, cursor: TIE });
  const slowTie = async (tool: string, args: Record<string, any>) => (args.filterGroups[0].filters[0].operator === "EQ" && (await new Promise((r) => setTimeout(r, 40))), call(tool, args));
  await syncObject(part.store, slowTie, "contacts", opts({ deadline: Date.now() + 20 }));
  const first = part.scopes.get("contacts")!.cursor!;
  expect(first).toMatch(/^2026-09-01T04:00:00.000Z#\d+$/);
  const done = Number(first.split("#")[1]);
  calls.length = 0;
  part.writes.length = 0;
  await syncObject(part.store, call, "contacts", opts());
  expect(calls[0]!.filterGroups[0].filters[1]).toMatchObject({ propertyName: "hs_object_id", operator: "GT", value: String(done) });
  expect(Number(part.writes[0]!.row.contact_id)).toBe(done + 1);
});

it("activities: one table keyed by type and id, body capped, the setting selects types and rejects unknown words", async () => {
  const { store, writes } = fakeStore();
  const note = { id: "9", properties: { hs_timestamp: "1794000000000", hs_note_body: "x".repeat(5000), hubspot_owner_id: "77", hs_lastmodifieddate: "2026-11-16T00:00:00.000Z" } };
  await syncObject(store, async () => answer([note]), "notes", opts());
  expect(writes[0]).toMatchObject({ table: "activity", row: { activity_id: "notes:9", type: "note", body_truncated: true, contact_ids: [], deal_ids: [], company_ids: [], owner_id: "77", occurred_at: new Date(1794000000000).toISOString() } });
  expect(writes[0]!.row.body.length).toBeLessThanOrEqual(4096);
  expect(selected(["deals", "activities"])).toEqual(["deals", "emails", "calls", "meetings", "notes", "tasks"]);
  expect(() => selected(["deals", "tickets"])).toThrow(/unknown tickets/);
});

it("owners: every page of search_owners, active or not, by owner id, checkpointed a page at a time (HubSpot sends no email)", async () => {
  const pages: Record<string, unknown> = {
    "": { owners: [{ ownerId: 11, name: "Ada Lovelace", isActive: false }, { ownerId: 12, name: " ", isActive: true }], hasMore: true, offset: 20 },
    "20": { owners: [{ ownerId: 20, name: "Grace Hopper", isActive: true }], hasMore: false, offset: 21 },
    "12": { owners: [{ ownerId: 12, name: " ", isActive: true }], hasMore: true, offset: 20 },
  };
  const seen: unknown[] = [];
  const call = async (tool: string, args: Record<string, any>) => (expect(tool).toBe("search_owners"), seen.push(args.offset), json(pages[String(args.offset ?? "")]));
  expect(await ownersPage(call)).toEqual({ owners: [{ id: "11", name: "Ada Lovelace" }, { id: "12", name: null }], next: 20 });
  expect(await ownersPage(call, 20)).toEqual({ owners: [{ id: "20", name: "Grace Hopper" }] });
  seen.length = 0;

  const { store, writes } = fakeStore();
  const spent = fakeStore();
  await syncReference(spent.store, call, ["contacts"], Date.now() - 1); // a spent budget stops the writes too: nothing is written
  expect(spent.writes).toEqual([]);
  expect((await spent.store.scope("owners")).cursor).toBe("11"); // and the next pass starts at the first owner not written
  let clock = 1000; // a controlled clock: each write takes 20 ms
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const slowStore = { ...store, upsert: async (...a: Parameters<typeof store.upsert>) => ((clock += 20), store.upsert(...a)) } as unknown as SourceStore;
  await syncReference(slowStore, call, ["contacts"], 1030); // the budget runs out after page one: its offset is kept
  now.mockRestore();
  expect(writes.map((w) => w.row.user_id)).toEqual(["11", "12"]);
  expect((await store.scope("owners")).cursor).toBe("20");
  // ...and one that runs out inside a page keeps the id of the first owner not written, which is where the next pass starts.
  const mid = fakeStore();
  clock = 1000;
  const now2 = vi.spyOn(Date, "now").mockImplementation(() => clock);
  const slowMid = { ...mid.store, upsert: async (...a: Parameters<typeof store.upsert>) => ((clock += 20), mid.store.upsert(...a)) } as unknown as SourceStore;
  await syncReference(slowMid, call, ["contacts"], 1010);
  now2.mockRestore();
  expect(mid.writes.map((w) => w.row.user_id)).toEqual(["11"]);
  expect((await mid.store.scope("owners")).cursor).toBe("12");
  seen.length = 0;
  mid.writes.length = 0;
  await syncReference(mid.store, call, ["contacts"]); // resumes at 12 (not page one), writes the rest, clears the cursor
  expect(seen).toEqual([12, 20]);
  expect(mid.writes.map((w) => w.row.user_id)).toEqual(["12", "20"]);
  expect((await mid.store.scope("owners")).cursor).toBe("");
  writes.length = 0;
  seen.length = 0;
  await syncReference(store, call, ["contacts"]); // the next pass resumes there and, reaching the end, clears it
  expect(seen).toEqual([20]);
  expect((await store.scope("owners")).cursor).toBe("");
  writes.length = 0;
  await syncReference(store, call, ["contacts"]);
  expect(writes.map((w) => [w.table, w.row.user_id, w.row.display_name])).toEqual([["users", "11", "Ada Lovelace"], ["users", "12", null], ["users", "20", "Grace Hopper"]]);
});

it("a budget spent right after the first page of a bulk-edit time still saves the switch to id paging", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const data = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, time: TIE }));
  const { store, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: TIE });
  await syncObject(store, searchOver(data, contact), "contacts", opts({ deadline: Date.now() - 1 }));
  expect(scopes.get("contacts")?.cursor).toBe(`${TIE}#0`);
});

it("a bulk edit that is recent when its id scan finishes is read again next pass, for records HubSpot indexes late", async () => {
  const T = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { lastmodifieddate: time } });
  const data = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, time: T }));
  const { store, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: T });
  await syncObject(store, searchOver(data, contact), "contacts", opts());
  expect(scopes.get("contacts")?.cursor).toBe(T); // not T + 1 ms: the lookback is clamped to where the pass began
});

it("an out-of-range headcount is stored as null and the type goes on", async () => {
  const { store, writes } = fakeStore();
  const company = (id: string, employees: string) => ({ id, properties: { name: id, numberofemployees: employees, hs_lastmodifieddate: "2026-11-16T00:00:00.000Z" } });
  await syncObject(store, async () => answer([company("1", "3000000000"), company("2", "250")]), "companies", opts());
  expect(writes.map((w) => w.row.employees)).toEqual([null, 250]);
});

it("a search that ran from its start to its end reports HubSpot's total against the distinct records read; a resumed one compares nothing", async () => {
  const mk = (total: number, ids: string[]) => async () => answer(ids.map((id) => deal(id, "2026-11-10T10:00:00.000Z")), ids.length, total);
  const whole = { pass: {} as any };
  await syncObject(fakeStore().store, mk(2, ["1", "2"]), "deals", opts(whole));
  expect(whole.pass.complete).toEqual({ total: 2, fetched: 2 });
  // A pass resumed inside a bulk-edit time counts from the middle: no comparison.
  const f = fakeStore();
  await f.store.saveScope("deals", "2026-11-10T10:00:00.000Z#7", false);
  const resumed = { pass: {} as any };
  await syncObject(f.store, async (tool, args: any) => answer([deal("8", "2026-11-10T10:00:00.000Z")], 1, 1), "deals", opts(resumed));
  expect(resumed.pass.complete).toBeUndefined();
});

it("a resumed bulk-edit read whose newer time range ends short keeps the cursor", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const NEW = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const { store, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: `${TIE}#1` });
  const call = async (_: string, args: Record<string, any>) => {
    const [mod] = args.filterGroups[0].filters;
    if (mod.operator === "EQ") return answer([contact(2, TIE)], 1, 1); // the resumed tie finishes whole
    // The newer range reports five but serves four distinct ids, every page matching its own total.
    const sinceMs = Number(mod.value);
    const rest = [contact(10, NEW), contact(11, NEW), contact(12, NEW), contact(13, NEW)];
    return answer(sinceMs <= Date.parse(NEW) ? rest : [], rest.length, sinceMs <= Date.parse(NEW) ? 5 : rest.length);
  };
  await syncObject(store, call, "contacts", opts());
  // Held at the exact checkpoint it began at (tie id included), not past the gap.
  expect(scopes.get("contacts")).toEqual({ baselined: true, cursor: `${TIE}#1` });
});

// These two drive real retries (which sleep between attempts), so the clock and timers are faked around them.
const withRetries = async (run: () => Promise<unknown>) => {
  vi.useFakeTimers({ now: NOW });
  try {
    const p = run();
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
  } finally {
    vi.useRealTimers();
  }
};

it("a short page below HubSpot's total keeps the contacts cursor at the pass start and records the shortfall", async () => {
  const T = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const full = Array.from({ length: 200 }, (_, i) => contact(i + 1, T));
  let calls = 0;
  const call = async () => (calls++ === 0 ? answer(full, full.length, 4950) : answer([], 0, 4950));
  const { store, scopes } = fakeStore();
  const pass = {} as any;
  await withRetries(() => syncObject(store, call, "contacts", opts({ pass })));
  expect(calls).toBe(4); // the full page, then the same time re-issued three times in all before giving up
  expect(pass.complete).toEqual({ total: 4950, fetched: 200 }); // the shortfall stays visible to the detector
  // The pass began 30 days back; the cursor did not move past it, so the next pass re-reads the same window. A short first
  // pass is not a finished baseline either.
  expect(scopes.get("contacts")).toEqual({ baselined: false, cursor: new Date(NOW - 30 * 86_400_000).toISOString() });
});

it("a resumed bulk-edit read that ends short keeps its own id checkpoint and reports that page's shortfall", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const { store, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: `${TIE}#100` });
  const boundaries: string[] = [];
  let calls = 0;
  const shortTie = async (_: string, args: Record<string, any>) => {
    calls++;
    const [mod, idf] = args.filterGroups[0].filters;
    expect(mod).toMatchObject({ propertyName: "lastmodifieddate", operator: "EQ", value: String(Date.parse(TIE)) });
    boundaries.push(idf.value); // every attempt starts at the same boundary
    return answer([contact(101, TIE)], 1, 2); // 2 matches reported, only id 101 served
  };
  const pass = {} as any;
  await withRetries(() => syncObject(store, shortTie, "contacts", opts({ pass })));
  expect(calls).toBe(3);
  expect(boundaries).toEqual(["100", "100", "100"]);
  expect(scopes.get("contacts")).toEqual({ baselined: true, cursor: `${TIE}#100` }); // not past the unread time
  expect(pass.complete).toEqual({ total: 2, fetched: 1 }); // the shortfall is visible on a resumed pass too
});

it("a short page that fills out on retry is read whole in the same pass", async () => {
  const T = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const first = Array.from({ length: 100 }, (_, i) => contact(i + 1, T));
  const all = Array.from({ length: 150 }, (_, i) => contact(i + 1, T));
  let calls = 0;
  // The same GTE query: the first answer omits the last 50 (index lag), the retry has the whole set.
  const call = async () => (calls++ === 0 ? answer(first, first.length, 150) : answer(all, all.length, 150));
  const { store, writes, scopes } = fakeStore();
  const pass = {} as any;
  await withRetries(() => syncObject(store, call, "contacts", opts({ pass })));
  expect(calls).toBe(2);
  expect(new Set(writes.map((w) => w.row.contact_id)).size).toBe(150);
  expect(pass.complete).toEqual({ total: 150, fetched: 150 });
  expect(scopes.get("contacts")).toEqual({ baselined: true, cursor: new Date(Date.parse(T) - 10 * 60_000).toISOString() }); // caught up, with the overlap
});

it("a retry that omits its total keeps the short page's count, so a held cursor is not released", async () => {
  const T = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const first = Array.from({ length: 100 }, (_, i) => contact(i + 1, T));
  const full = Array.from({ length: 200 }, (_, i) => contact(i + 1, T));
  let calls = 0;
  // The first answer says 250 matched but serves 100; the retry serves a full 200-row page and gives no total at all; the
  // next page (past the only time in the burst) is empty, also without a count. 250 exist, only 200 are indexed.
  const start = NOW - 30 * 86_400_000;
  const call = async (_: string, args: Record<string, any>) => {
    const since = Number(args.filterGroups[0].filters[0].value);
    calls++;
    if (since > start) return json({ results: [], offset: 0 }); // the page after the burst: empty, no total
    return calls === 1 ? answer(first, first.length, 250) : json({ results: full, offset: 0 });
  };
  const { store, writes } = fakeStore();
  const pass = {} as any;
  await withRetries(() => syncObject(store, call, "contacts", opts({ pass })));
  expect(calls).toBe(3);
  expect(new Set(writes.map((w) => w.row.contact_id)).size).toBe(200);
  expect(pass.complete).toEqual({ total: 250, fetched: 200 }); // the count is not wiped by the retry's silence
  // 200 of 250 read: the cursor stays where the pass began instead of moving past the 50 that are unindexed.
  expect((await store.scope("contacts")).cursor).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
});

it("a resumed pass takes its newer range's total from the retry that resolved the short page", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const NEW = new Date(NOW - 60_000).toISOString();
  const contact = (id: number, time: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: time } });
  const { store, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: `${TIE}#1` });
  let newer = 0;
  const call = async (_: string, args: Record<string, any>) => {
    const since = Number(args.filterGroups[0].filters[0].value);
    if (args.filterGroups[0].filters[0].operator === "EQ") return answer([contact(2, TIE)], 1, 1); // the resumed tie is whole
    if (since > Date.parse(NEW)) return json({ results: [], offset: 0 });
    // The range first reports two matches but serves one; the retry reports one and serves it: a record archived between the
    // attempts, not a gap. Its accepted count is the range's total, so the range is read whole and the cursor moves on.
    newer++;
    return newer === 1 ? answer([contact(10, NEW)], 1, 2) : answer([contact(10, NEW)], 1, 1);
  };
  const pass = {} as any;
  await withRetries(() => syncObject(store, call, "contacts", opts({ pass })));
  expect(newer).toBe(2);
  expect(scopes.get("contacts")?.cursor).toBe(new Date(Date.parse(NEW) - 10 * 60_000).toISOString()); // caught up, no id checkpoint
  expect(pass.complete).toBeUndefined(); // a resumed pass never reports a whole-search comparison
});
