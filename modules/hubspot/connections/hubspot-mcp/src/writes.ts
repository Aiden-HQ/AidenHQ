// hubspot.crm_write (module.yaml writes.crm_write), the executor side: the kernel files every manage_crm_objects call as a
// record and calls execute only once the AI reviewer (and, when raised, the owner) approved it. The args are the tool's own,
// so the digest covers exactly what was reviewed. Creating or updating one or a few records and logging activities
// (note, task, call, meeting) is the reviewer's (floor Tier 1); a change to more than BULK records is the owner's.
// HubSpot has no delete tool in the exposed set, so nothing here deletes.
import type { Executor } from "./aidenhq-sdk/executor.js";

/** More records than this in one call is the owner's decision. */
export const BULK = 5;
type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

/**
 * What a manage_crm_objects call touches, for the card and the tier. TODO(probe): the tool's real argument shape. Guessed:
 * { objectType, operation?, objects | records | inputs: [ { id?, properties } ] } or one object's { id?, properties }.
 */
// Until HubSpot's real inputSchema is probed, describe() reads only these shapes. The top-level fields it understands. Anything else (or no recognisable records) means it can't count what the call
// touches, so the plan fails closed: the owner decides (Tier 2), never the reviewer on a guessed count.
const ITEM = new Set(["id", "objectId", "properties", "associations"]);
const OPERATIONS = new Set(["create", "update"]);
const KNOWN = new Set(["objectType", "operation", "action", "objects", "records", "inputs", "items", "id", "objectId", "properties", "associations"]);

export function describe(args: any): { objectType: string; operation: string; count: number; ids: string[]; properties: string[]; known: boolean } {
  const lists = [args?.objects, args?.records, args?.inputs, args?.items].filter(Array.isArray);
  const single = args?.properties || args?.id ? [args] : [];
  const items: any[] = lists[0] ?? single;
  const op = args?.operation ?? args?.action;
  const known =
    Boolean(args) && typeof args === "object" && Object.keys(args).every((k) => KNOWN.has(k)) &&
    (lists.length === 1 ? !single.length : lists.length === 0 && single.length === 1) && items.length > 0 &&
    // Each record carries only these fields (a nested list could hide a bulk change), and the operation is one of these.
    (lists.length === 0 || items.every((i) => i && typeof i === "object" && !Array.isArray(i) && Object.keys(i).every((k) => ITEM.has(k)))) &&
    (op == null || OPERATIONS.has(String(op)));
  const objectType = String(args?.objectType ?? items[0]?.objectType ?? "records");
  const ids = items.map((i) => i?.id ?? i?.objectId).filter((x) => x != null).map(String);
  return {
    objectType,
    operation: String(args?.operation ?? args?.action ?? (ids.length ? "update" : "create")),
    count: items.length || 1,
    ids,
    properties: [...new Set(items.flatMap((i) => Object.keys(i?.properties ?? {})))].sort(),
    known,
  };
}

export function crmWriter(call: Call): Executor {
  return {
    async plan(req) {
      const d = describe(req.args);
      const what = `${d.operation} ${d.count} HubSpot ${d.objectType}${d.ids.length ? ` (${d.ids.slice(0, 5).join(", ")}${d.ids.length > 5 ? ", ..." : ""})` : ""}`;
      return {
        args: req.args,
        targets: { object_type: d.objectType, ...(d.ids.length ? { ids: d.ids.slice(0, 50).join(",") } : {}) },
        facts: { count: d.count, object_type: d.objectType, operation: d.operation, fields: d.properties.join(", ") || "none named" },
        ...(!d.known
          ? { raise: { tier: 2 as const, rule: "hubspot-unknown-shape", reason: "the call's records can't be counted from its arguments" } }
          : d.count > BULK ? { raise: { tier: 2 as const, rule: "hubspot-bulk", reason: `one call changes ${d.count} HubSpot ${d.objectType}, more than ${BULK}` } } : {}),
        card: {
          what,
          changes: `Runs ${what} in the company's HubSpot (fields: ${d.properties.join(", ") || "not named"}). Everyone who uses that HubSpot sees it.`,
          content: JSON.stringify(req.args, null, 2),
        },
      };
    },
    async execute(rec) {
      // TODO(probe): HubSpot says manage_crm_objects "requires user confirmation before executing". If a client without
      // elicitation gets a "confirm" answer or a flag to pass, handle it here: the kernel's approval is the confirmation.
      const r = await call("manage_crm_objects", rec.args);
      return r.isError ? { ok: false, text: r.text.slice(0, 2000) } : { ok: true, text: `Done in HubSpot: ${r.text.slice(0, 1500)}` };
    },
  };
}
