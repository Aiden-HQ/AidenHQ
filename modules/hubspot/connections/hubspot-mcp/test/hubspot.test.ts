import { describe, expect, it } from "bun:test";
import { BULK, crmWriter } from "../src/writes.js";

describe("hubspot.crm_write", () => {
  it("plans a bulk change to the owner, a small one to the reviewer, and runs an approved call as it was reviewed", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const w = crmWriter(async (name, args) => (calls.push({ name, args }), { text: "ok" }));
    const requester = { agent: "a", key: "chief-of-staff", name: "Aiden", roles: [], kind: "agent" };
    const many = { objectType: "deals", objects: Array.from({ length: BULK + 1 }, (_, i) => ({ id: String(i), properties: { dealstage: "won" } })) };
    expect(await w.plan({ kind: "hubspot.crm_write", args: many, requester, task: "t" })).toMatchObject({ raise: { tier: 2, rule: "hubspot-bulk" }, facts: { count: BULK + 1, object_type: "deals" } });
    const one = { objectType: "notes", objects: [{ properties: { hs_note_body: "Called" } }] };
    expect(((await w.plan({ kind: "hubspot.crm_write", args: one, requester, task: "t" })) as { raise?: unknown }).raise).toBeUndefined();
    const oddShapes = [
      { objectType: "deals", requests: [{ id: "1" }] },
      { objectType: "deals" },
      { objectType: "deals", objects: [{ id: "1" }], records: [{ id: "2" }] },
      // A bulk change hidden one level down, and an operation the plan can't vouch for.
      { objectType: "deals", objects: [{ inputs: Array.from({ length: 50 }, (_, i) => ({ id: String(i) })) }] },
      { objectType: "deals", operation: "delete", objects: [{ id: "1" }] },
    ];
    for (const odd of oddShapes)
      expect(await w.plan({ kind: "hubspot.crm_write", args: odd, requester, task: "t" })).toMatchObject({ raise: { tier: 2, rule: "hubspot-unknown-shape" } });
    expect((await w.execute({ id: "k-0123456789abcdef", kind: "hubspot.crm_write", args: one, digest: "d", idempotency_key: "i" })).ok).toBe(true);
    expect(calls.at(-1)).toEqual({ name: "manage_crm_objects", args: one });
  });
});
