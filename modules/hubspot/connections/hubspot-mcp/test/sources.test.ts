import { expect, it } from "vitest";
import { listOwners, WINDOW } from "../src/adapter.js";
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
const answer = (results: unknown[], offset = results.length, total = results.length) => json({ results, total, offset });
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
  expect(writes[0]).toMatchObject({ table: "deal", baseline: true, row: { deal_id: "1", name: "Acme renewal", stage: "contractsent", amount: 12000.5, owner_id: "77", company_ids: [], contact_ids: [] } });
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

it("pages by offset; past HubSpot's 10,000-result cap a window restarts from the newest time seen; a spent budget saves the cursor and resumes", async () => {
  const { store, writes, scopes } = fakeStore();
  const since: number[] = [];
  const t = (i: number) => new Date(NOW - 20 * 86_400_000 + i * 60_000).toISOString();
  const call = async (_: string, args: Record<string, any>) => {
    const s = Number(args.filterGroups[0].filters[0].value);
    if (args.filterGroups[0].filters[0].operator === "EQ") return answer([]); // the check for a bulk-edit time
    if (!args.offset) since.push(s);
    if (since.length === 1) {
      const start = Number(args.offset ?? 0);
      const chunk = Array.from({ length: 200 }, (_, i) => deal(String(start + i), t(start + i)));
      return answer(chunk, start + 200, 50_000);
    }
    return answer([deal("last", t(WINDOW + 5))]);
  };
  await syncObject(store, call, "deals", opts());
  expect(since.length).toBe(2);
  expect(since[1]).toBe(Date.parse(t(WINDOW - 1))); // the newest of the first window (its last record)
  expect(scopes.get("deals")?.baselined).toBe(true);

  const slow = fakeStore();
  const full = [deal("1", t(1))].concat(Array.from({ length: 199 }, (_, i) => deal(`f${i}`, t(1))));
  await syncObject(slow.store, async (_, args) => (args.filterGroups[0].filters[0].operator === "EQ" ? answer([]) : answer(full, 200, 5000)), "deals", opts({ deadline: Date.now() - 1 }));
  expect(slow.scopes.get("deals")).toEqual({ baselined: false, cursor: t(1) });
  expect(writes.length).toBeGreaterThan(WINDOW);
});

it("more than WINDOW records at one modified time (a bulk edit) are read by id, and a spent budget resumes inside them", async () => {
  const TIE = "2026-09-01T04:00:00.000Z";
  const TOTAL = WINDOW + 450;
  const calls: Record<string, any>[] = [];
  let later = true;
  // The contacts of one bulk edit (ids 1..TOTAL, all modified at TIE), then one later contact.
  const call = async (_: string, args: Record<string, any>) => {
    calls.push(args);
    const [mod, id] = args.filterGroups[0].filters;
    const contact = (i: number, at = TIE) => ({ id: i, properties: { email: `c${i}@example.com`, lastmodifieddate: at } });
    if (mod.operator === "EQ") {
      if (Number(mod.value) !== Date.parse(TIE)) return answer([]);
      expect(args.sorts).toEqual([{ propertyName: "hs_object_id", direction: "ASCENDING" }]);
      const from = Number(id.value);
      const left = Math.max(0, TOTAL - from);
      return answer(Array.from({ length: Math.min(args.limit, left) }, (_, i) => contact(from + 1 + i)), 0, left);
    }
    if (Number(mod.value) > Date.parse(TIE)) return answer(later ? [contact(TOTAL + 1, "2026-09-02T00:00:00.000Z")] : []); // after the tie
    const start = Number(args.offset ?? 0);
    const all = Array.from({ length: TOTAL }, (_, i) => contact(i + 1)).concat(later ? [contact(TOTAL + 1, "2026-09-02T00:00:00.000Z")] : []);
    const chunk = all.slice(start, start + 200);
    return answer(chunk, start + chunk.length, all.length);
  };
  const { store, writes, scopes } = fakeStore();
  scopes.set("contacts", { baselined: true, cursor: TIE });
  await syncObject(store, call, "contacts", opts());
  expect(new Set(writes.map((w) => w.row.contact_id)).size).toBe(TOTAL + 1);
  expect(scopes.get("contacts")?.cursor).toBe("2026-09-02T00:00:00.000Z");

  // When the bulk edit is the newest time, finishing it moves the cursor past it (no rereading it every pass).
  later = false;
  const newest = fakeStore();
  newest.scopes.set("contacts", { baselined: true, cursor: TIE });
  await syncObject(newest.store, call, "contacts", opts());
  expect(newest.scopes.get("contacts")?.cursor).toBe(new Date(Date.parse(TIE) + 1).toISOString());
  later = true;

  // A budget that runs out inside the tie saves "<time>#<id>"; the next pass starts after that id.
  const part = fakeStore();
  part.scopes.set("contacts", { baselined: true, cursor: TIE });
  calls.length = 0;
  await syncObject(part.store, call, "contacts", opts({ deadline: Date.now() - 1 }));
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

it("owners: every page of search_owners, active or not, by owner id (HubSpot sends no email)", async () => {
  const pages: Record<string, unknown> = {
    "": { owners: [{ ownerId: 11, name: "Ada Lovelace", isActive: false }, { ownerId: 12, name: " ", isActive: true }], hasMore: true, offset: 20 },
    "20": { owners: [{ ownerId: 20, name: "Grace Hopper", isActive: true }], hasMore: false, offset: 21 },
  };
  const seen: unknown[] = [];
  const call = async (tool: string, args: Record<string, any>) => (expect(tool).toBe("search_owners"), seen.push(args.offset), json(pages[String(args.offset ?? "")]));
  expect(await listOwners(call)).toEqual([{ id: "11", name: "Ada Lovelace" }, { id: "12", name: null }, { id: "20", name: "Grace Hopper" }]);
  expect(seen).toEqual([undefined, 20]);

  const { store, writes } = fakeStore();
  await syncReference(store, call, ["contacts"]);
  expect(writes.map((w) => [w.table, w.row.user_id, w.row.display_name])).toEqual([["users", "11", "Ada Lovelace"], ["users", "12", null], ["users", "20", "Grace Hopper"]]);
});
