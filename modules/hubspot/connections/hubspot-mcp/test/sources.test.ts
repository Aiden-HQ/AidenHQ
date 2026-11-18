import { expect, it } from "vitest";
import { WINDOW } from "../src/adapter.js";
import { selected, syncObject } from "../src/sources.js";
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
const deal = (id: string, updated: string, extra: Record<string, unknown> = {}) => ({
  id, properties: { dealname: "Acme renewal", pipeline: "default", dealstage: "contractsent", amount: "12000.50", hubspot_owner_id: "77", hs_lastmodifieddate: updated, ...extra },
  associations: { companies: { results: [{ id: "c1" }] }, contacts: { results: [{ id: "p2" }, { id: "p1" }] } },
});
const NOW = Date.parse("2026-11-17T00:00:00Z");
const opts = (extra = {}) => ({ days: 30, deadline: Date.now() + 60_000, now: NOW, ...extra });

it("deals: the first pass is baseline from history_days, later passes from the cursor; ids, owner, amount and associations land", async () => {
  const { store, writes, scopes } = fakeStore();
  let sinceSeen = "";
  let page = [deal("1", "2026-11-10T10:00:00.000Z")];
  const call = async (tool: string, args: Record<string, any>) => {
    expect(tool).toBe("search_crm_objects");
    sinceSeen = args.filterGroups[0].filters[0].value;
    return json({ results: page });
  };
  await syncObject(store, call, "deals", opts());
  expect(Number(sinceSeen)).toBe(NOW - 30 * 86_400_000);
  expect(writes[0]).toMatchObject({ table: "deal", baseline: true, row: { deal_id: "1", name: "Acme renewal", stage: "contractsent", amount: 12000.5, owner_id: "77", company_ids: ["c1"], contact_ids: ["p1", "p2"] } });
  expect(scopes.get("deals")).toEqual({ baselined: true, cursor: "2026-11-10T10:00:00.000Z" });

  writes.length = 0;
  page = [deal("2", "2026-11-16T07:00:00.000Z")];
  await syncObject(store, call, "deals", opts());
  expect(Number(sinceSeen)).toBe(Date.parse("2026-11-10T10:00:00.000Z"));
  expect(writes[0]).toMatchObject({ row: { deal_id: "2" }, baseline: false });
});

it("odd data never fails a pass (a junk amount, no associations, no timestamp); a search error leaves the cursor and the type un-baselined", async () => {
  const { store, writes, scopes } = fakeStore();
  const odd = { id: "2", properties: { dealname: "x", amount: "n/a" } };
  await syncObject(store, async () => json({ results: [deal("1", "2026-11-10T00:00:00.000Z"), odd, deal("3", "2026-11-12T00:00:00.000Z")] }), "deals", opts());
  expect(writes.map((w) => w.row.deal_id)).toEqual(["1", "2", "3"]);
  expect(writes[1]!.row).toMatchObject({ amount: null, company_ids: [], source_updated_at: null });
  expect(scopes.get("deals")?.cursor).toBe("2026-11-12T00:00:00.000Z");
  const f2 = fakeStore();
  await expect(syncObject(f2.store, async () => ({ isError: true, content: [{ type: "text", text: "no access to deals" }] }), "deals", opts())).rejects.toThrow(/no access/);
  expect(f2.scopes.get("deals")).toEqual({ baselined: false, cursor: expect.any(String) });
});

it("past HubSpot's 10,000-result cap a window restarts from the newest time seen; a spent budget saves the cursor and resumes", async () => {
  const { store, writes, scopes } = fakeStore();
  const since: number[] = [];
  const t = (i: number) => new Date(NOW - 20 * 86_400_000 + i * 60_000).toISOString();
  const call = async (_: string, args: Record<string, any>) => {
    const s = Number(args.filterGroups[0].filters[0].value);
    if (!args.after) since.push(s);
    if (since.length === 1) {
      const start = Number(args.after ?? 0);
      const chunk = Array.from({ length: 200 }, (_, i) => deal(String(start + i), t(start + i)));
      return json({ results: chunk, paging: { next: { after: String(start + 200) } } });
    }
    return json({ results: [deal("last", t(WINDOW + 5))] });
  };
  await syncObject(store, call, "deals", opts());
  expect(since.length).toBe(2);
  expect(since[1]).toBe(Date.parse(t(WINDOW - 1))); // the newest of the first window (its last record)
  expect(scopes.get("deals")?.baselined).toBe(true);

  const slow = fakeStore();
  await syncObject(slow.store, async () => json({ results: [deal("1", t(1))], paging: { next: { after: "x" } } }), "deals", opts({ deadline: Date.now() - 1 }));
  expect(slow.scopes.get("deals")).toEqual({ baselined: false, cursor: t(1) });
  expect(writes.length).toBeGreaterThan(WINDOW);
});

it("activities: one table keyed by type and id, body capped, logged-against ids; the setting selects types and rejects unknown words", async () => {
  const { store, writes } = fakeStore();
  const note = { id: "9", properties: { hs_timestamp: "1794000000000", hs_note_body: "x".repeat(5000), hubspot_owner_id: "77", hs_lastmodifieddate: "2026-11-16T00:00:00.000Z" }, associations: { contacts: { results: [{ id: "p1" }] }, deals: { results: [{ id: "1" }] } } };
  await syncObject(store, async () => json({ results: [note] }), "notes", opts());
  expect(writes[0]).toMatchObject({ table: "activity", row: { activity_id: "notes:9", type: "note", body_truncated: true, contact_ids: ["p1"], deal_ids: ["1"], company_ids: [], owner_id: "77", occurred_at: new Date(1794000000000).toISOString() } });
  expect(writes[0]!.row.body.length).toBeLessThanOrEqual(4096);
  expect(selected(["deals", "activities"])).toEqual(["deals", "emails", "calls", "meetings", "notes", "tasks"]);
  expect(() => selected(["deals", "tickets"])).toThrow(/unknown tickets/);
});

it("associations the search left out are filled by get_crm_objects with numeric ids; rows keep their string ids", async () => {
  const { store, writes } = fakeStore();
  const contact = (id: string) => ({ id, properties: { email: `c${id}@example.com`, lastmodifieddate: "2026-11-16T00:00:00.000Z" } });
  let sent: unknown[] = [];
  const call = async (tool: string, args: Record<string, any>) => {
    if (tool === "search_crm_objects") return json({ results: [contact("1001"), contact("1002")] });
    expect(tool).toBe("get_crm_objects");
    sent = args.objectIds;
    return json({ results: args.objectIds.map((id: number) => ({ id: String(id), properties: {}, associations: { companies: { results: [{ id: "c1" }] } } })) });
  };
  await syncObject(store, call, "contacts", opts());
  expect(sent).toEqual([1001, 1002]);
  expect(sent.every((id) => typeof id === "number")).toBe(true);
  expect(writes.map((w) => w.row.contact_id)).toEqual(["1001", "1002"]);
  expect(writes[0]!.row.company_ids).toEqual(["c1"]);
});
