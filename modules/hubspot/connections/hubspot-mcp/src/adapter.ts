// Everything that depends on the exact shape of HubSpot's remote MCP tools lives here, so correcting it after a live probe
// (src/probe.ts) touches this file only. Every guess is marked TODO(probe). The shapes below follow what HubSpot documents
// (search_crm_objects: filter groups, sorts, `limit` up to 200, a paging cursor; get_crm_objects: up to 100 ids; the answers
// look like the CRM API's records: { id, properties, associations }) and are not yet confirmed against the live server.

export type CallHubSpot = (tool: string, args: Record<string, unknown>) => Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>;

/** One CRM record as the sync uses it. `associations` is absent when the tool didn't return them. */
export interface CrmRecord {
  id: string;
  properties: Record<string, any>;
  associations?: Record<string, string[]>;
}

/** What to read for one HubSpot object type. */
export interface ObjectDef {
  /** objectType argument. TODO(probe): plural names ("contacts") or singular ("contact") or object type ids ("0-1")? */
  objectType: string;
  /** The property that holds the last-modified time (contacts: lastmodifieddate; the others hs_lastmodifieddate). */
  modified: string;
  properties: string[];
  /** Association targets worth storing as id lists. */
  associations: string[];
}

const ACTIVITY_ASSOC = ["contacts", "companies", "deals"];
export const OBJECTS: Record<string, ObjectDef> = {
  contacts: {
    objectType: "contacts", modified: "lastmodifieddate", associations: ["companies"],
    properties: ["email", "firstname", "lastname", "jobtitle", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "createdate", "lastmodifieddate"],
  },
  companies: {
    objectType: "companies", modified: "hs_lastmodifieddate", associations: [],
    properties: ["name", "domain", "industry", "lifecyclestage", "hubspot_owner_id", "numberofemployees", "annualrevenue", "createdate", "hs_lastmodifieddate"],
  },
  deals: {
    objectType: "deals", modified: "hs_lastmodifieddate", associations: ["companies", "contacts"],
    properties: ["dealname", "pipeline", "dealstage", "amount", "deal_currency_code", "closedate", "hubspot_owner_id", "createdate", "hs_lastmodifieddate"],
  },
  // Activities: one table, one scope per type. Property names per type are TODO(probe) (HubSpot's engagement properties).
  emails: { objectType: "emails", modified: "hs_lastmodifieddate", associations: ACTIVITY_ASSOC, properties: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_direction", "hs_email_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  calls: { objectType: "calls", modified: "hs_lastmodifieddate", associations: ACTIVITY_ASSOC, properties: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hs_call_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  meetings: { objectType: "meetings", modified: "hs_lastmodifieddate", associations: ACTIVITY_ASSOC, properties: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  notes: { objectType: "notes", modified: "hs_lastmodifieddate", associations: ACTIVITY_ASSOC, properties: ["hs_timestamp", "hs_note_body", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  tasks: { objectType: "tasks", modified: "hs_lastmodifieddate", associations: ACTIVITY_ASSOC, properties: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
};
/** The activity types, and which setting words select which object types. */
export const ACTIVITY_TYPES = ["emails", "calls", "meetings", "notes", "tasks"] as const;
export const SETTING_OBJECTS = ["contacts", "companies", "deals", "activities"] as const;

export const SEARCH_LIMIT = 200; // documented maximum per page
/** HubSpot's search never pages past 10,000 results; a window stops here and the next starts from the newest time seen. */
export const WINDOW = 9_000;

/** The text blocks of a tool result. */
export const textsOf = (r: Awaited<ReturnType<CallHubSpot>>): string[] => (Array.isArray(r.content) ? r.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text));

/** A tool result's JSON (structured content, or JSON in a text block); an error result throws its text. */
export function toolJson(r: Awaited<ReturnType<CallHubSpot>>, tool: string): any {
  const texts = textsOf(r);
  if (r.isError) throw new Error(`${tool} failed: ${texts.join(" ").slice(0, 300)}`);
  for (const cand of [r.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return undefined; } })]) if (cand != null) return (cand as any).data ?? cand;
  throw new Error(`unexpected ${tool} response: ${texts.join(" ").slice(0, 200)}`);
}

/** Association ids from either CRM shape: { companies: { results: [{ id }] } } or { companies: [id, ...] }. */
function associationsOf(a: any): Record<string, string[]> | undefined {
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(a)) {
    const list: any[] = Array.isArray(v) ? v : Array.isArray((v as any)?.results) ? (v as any).results : [];
    out[k] = list.map((x) => String(x?.id ?? x?.toObjectId ?? x)).filter((x) => x && x !== "undefined");
  }
  return out;
}

/** The records and the next-page cursor of a search or get answer. TODO(probe): the list's name and the cursor's. */
export function parseRecords(o: any): { records: CrmRecord[]; next?: string } {
  const list = Array.isArray(o) ? o : (o?.results ?? o?.records ?? o?.objects ?? o?.items ?? []);
  if (!Array.isArray(list)) throw new Error(`unexpected CRM answer: ${JSON.stringify(o).slice(0, 200)}`);
  const next = o?.paging?.next?.after ?? o?.nextCursor ?? o?.next ?? o?.after;
  return {
    records: list.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), properties: r.properties ?? {}, ...(r.associations ? { associations: associationsOf(r.associations) } : {}) })),
    ...(next != null && next !== "" ? { next: String(next) } : {}),
  };
}

/**
 * One page of records modified at or after `sinceMs`, oldest first. TODO(probe): the tool's argument names (objectType,
 * filterGroups with propertyName/operator/value, sorts, properties, limit, after, associations) and whether the filter value is
 * epoch milliseconds or an ISO time.
 */
export async function searchPage(call: CallHubSpot, def: ObjectDef, sinceMs: number, after?: string): Promise<{ records: CrmRecord[]; next?: string }> {
  const r = await call("search_crm_objects", {
    objectType: def.objectType,
    filterGroups: [{ filters: [{ propertyName: def.modified, operator: "GTE", value: String(sinceMs) }] }],
    sorts: [{ propertyName: def.modified, direction: "ASCENDING" }],
    properties: def.properties,
    limit: SEARCH_LIMIT,
    ...(after ? { after } : {}),
    ...(def.associations.length ? { associations: def.associations } : {}),
  });
  return parseRecords(toolJson(r, "search_crm_objects"));
}

/** Fill in associations for records the search returned without them (get_crm_objects takes up to 100 ids). TODO(probe). */
export async function withAssociations(call: CallHubSpot, def: ObjectDef, records: CrmRecord[]): Promise<CrmRecord[]> {
  if (!def.associations.length || !records.length || records.some((r) => r.associations)) return records;
  const byId = new Map<string, CrmRecord>();
  for (let i = 0; i < records.length; i += 100) {
    const ids = records.slice(i, i + 100).map((r) => r.id);
    // get_crm_objects takes ids as numbers; HubSpot ids are well below Number.MAX_SAFE_INTEGER.
    const got = parseRecords(toolJson(await call("get_crm_objects", { objectType: def.objectType, objectIds: ids.map(Number), properties: [], associations: def.associations }), "get_crm_objects"));
    for (const g of got.records) byId.set(g.id, g);
  }
  return records.map((r) => ({ ...r, associations: byId.get(r.id)?.associations ?? {} }));
}

/** A time property as an ISO string (HubSpot returns ISO strings or epoch milliseconds, as text). */
export function isoOf(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : /^\d{10,}$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** Owners: { id, email, firstName, lastName }. TODO(probe): does search_owners with an empty query list them all (up to 100)? */
export async function listOwners(call: CallHubSpot): Promise<{ id: string; email: string | null; name: string | null }[]> {
  const o = toolJson(await call("search_owners", { limit: 100 }), "search_owners");
  const list: any[] = Array.isArray(o) ? o : (o?.results ?? o?.owners ?? []);
  return list.filter((x) => x?.id != null).map((x) => ({ id: String(x.id), email: x.email ?? null, name: [x.firstName, x.lastName].filter(Boolean).join(" ") || x.name || null }));
}

/** Deal stage ids to labels, from the dealstage property's options. TODO(probe): get_properties' answer and the options' fields. */
export async function dealStages(call: CallHubSpot): Promise<{ id: string; label: string; pipeline: string | null; order: number | null }[]> {
  const o = toolJson(await call("get_properties", { objectType: "deals", propertyNames: ["dealstage"] }), "get_properties");
  const prop = (Array.isArray(o) ? o : (o?.results ?? o?.properties ?? [o])).find((p: any) => p?.name === "dealstage") ?? {};
  return (prop.options ?? []).filter((x: any) => x?.value != null).map((x: any) => ({ id: String(x.value), label: String(x.label ?? x.value), pipeline: x.pipelineLabel ?? x.pipelineId ?? null, order: Number.isFinite(Number(x.displayOrder)) ? Number(x.displayOrder) : null }));
}
