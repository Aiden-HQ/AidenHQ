// Everything that depends on the exact shape of HubSpot's remote MCP tools lives here (src/probe.ts prints them). Confirmed live
// (2026-11-22): search_crm_objects takes filterGroups, one sort, `limit` up to 200 and a numeric `offset` (offset + limit may not
// pass 10,000, so the sync pages by modified time instead) and answers { results: [{ id (a number), properties }], total, offset }; properties HubSpot has no
// value for are left out. Neither it nor get_crm_objects can return associations, so the *_ids columns stay empty.
// search_owners answers { owners: [{ ownerId, name, isActive }], hasMore, offset } (no email; offset is an owner id).

export type CallHubSpot = (tool: string, args: Record<string, unknown>) => Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>;

/** One CRM record as the sync uses it. */
export interface CrmRecord {
  id: string;
  properties: Record<string, any>;
  /** The record's page in HubSpot (the answer's urlTemplate, which carries the portal id, without its tracking query). */
  url?: string;
}

/** What to read for one HubSpot object type. */
export interface ObjectDef {
  /** objectType argument (HubSpot accepts the plural names). */
  objectType: string;
  /** The property that holds the last-modified time (contacts: lastmodifieddate; the others hs_lastmodifieddate). */
  modified: string;
  properties: string[];
}

export const OBJECTS: Record<string, ObjectDef> = {
  contacts: {
    objectType: "contacts", modified: "lastmodifieddate",
    properties: ["email", "firstname", "lastname", "jobtitle", "lifecyclestage", "hs_lead_status", "hubspot_owner_id", "createdate", "lastmodifieddate"],
  },
  companies: {
    objectType: "companies", modified: "hs_lastmodifieddate",
    properties: ["name", "domain", "industry", "lifecyclestage", "hubspot_owner_id", "numberofemployees", "annualrevenue", "createdate", "hs_lastmodifieddate"],
  },
  deals: {
    objectType: "deals", modified: "hs_lastmodifieddate",
    properties: ["dealname", "pipeline", "dealstage", "amount", "deal_currency_code", "closedate", "hubspot_owner_id", "createdate", "hs_lastmodifieddate"],
  },
  // Activities: one table, one scope per type.
  emails: { objectType: "emails", modified: "hs_lastmodifieddate", properties: ["hs_timestamp", "hs_email_subject", "hs_email_text", "hs_email_direction", "hs_email_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  calls: { objectType: "calls", modified: "hs_lastmodifieddate", properties: ["hs_timestamp", "hs_call_title", "hs_call_body", "hs_call_direction", "hs_call_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  meetings: { objectType: "meetings", modified: "hs_lastmodifieddate", properties: ["hs_timestamp", "hs_meeting_title", "hs_meeting_body", "hs_meeting_outcome", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  notes: { objectType: "notes", modified: "hs_lastmodifieddate", properties: ["hs_timestamp", "hs_note_body", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
  tasks: { objectType: "tasks", modified: "hs_lastmodifieddate", properties: ["hs_timestamp", "hs_task_subject", "hs_task_body", "hs_task_status", "hubspot_owner_id", "hs_createdate", "hs_lastmodifieddate"] },
};
/** The activity types, and which setting words select which object types. */
export const ACTIVITY_TYPES = ["emails", "calls", "meetings", "notes", "tasks"] as const;
export const SETTING_OBJECTS = ["contacts", "companies", "deals", "activities"] as const;

export const SEARCH_LIMIT = 200; // documented maximum per page
/** Owners per page: small, so the owner scan checkpoints often and a spent budget replays little. */
const OWNERS_PAGE = 25;

/** The text blocks of a tool result. */
export const textsOf = (r: Awaited<ReturnType<CallHubSpot>>): string[] => (Array.isArray(r.content) ? r.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text));

/** A tool result's JSON (structured content, or JSON in a text block); an error result throws its text. */
export function toolJson(r: Awaited<ReturnType<CallHubSpot>>, tool: string): any {
  const texts = textsOf(r);
  if (r.isError) throw new Error(`${tool} failed: ${texts.join(" ").slice(0, 300)}`);
  for (const cand of [r.structuredContent, ...texts.map((t) => { try { return JSON.parse(t); } catch { return undefined; } })]) if (cand != null) return (cand as any).data ?? cand;
  throw new Error(`unexpected ${tool} response: ${texts.join(" ").slice(0, 200)}`);
}

/** The records of a search answer. */
export function parseRecords(o: any): CrmRecord[] {
  const list = o?.results;
  if (!Array.isArray(list)) throw new Error(`unexpected CRM answer: ${JSON.stringify(o).slice(0, 200)}`);
  const template = typeof o.urlTemplate === "string" ? o.urlTemplate.split("?")[0] : undefined;
  return list.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), properties: r.properties ?? {}, ...(template ? { url: template.replace("{id}", String(r.id)) } : {}) }));
}

/** A search answer's `total` (null when it gave none) and how many results it listed, malformed ones included. */
const counts = (o: any) => ({ total: Number.isInteger(o?.total) && o.total >= 0 ? o.total : null, returned: Array.isArray(o?.results) ? o.results.length : 0 });

/**
 * One page of records modified at or after `sinceMs`, oldest first, with HubSpot's `total` for the whole search (null when it
 * gave none) and how many results it listed (one with no id is unusable, so it must not read as a page HubSpot truncated).
 */
export async function searchPage(call: CallHubSpot, def: ObjectDef, sinceMs: number): Promise<{ records: CrmRecord[]; total: number | null; returned: number }> {
  const o = toolJson(
    await call("search_crm_objects", {
      objectType: def.objectType,
      filterGroups: [{ filters: [{ propertyName: def.modified, operator: "GTE", value: String(sinceMs) }] }],
      sorts: [{ propertyName: def.modified, direction: "ASCENDING" }],
      properties: def.properties,
      limit: SEARCH_LIMIT,
    }),
    "search_crm_objects",
  );
  return { records: parseRecords(o), ...counts(o) };
}

/**
 * One page of the records modified at exactly `ms` with an id above `afterId`, by id, with HubSpot's `total` for that same
 * filter (the records left from `afterId` on; null when it gave none). A time shared by more than one page of records (a bulk
 * edit) can't be passed by time, so it is read by id instead.
 */
export async function searchTie(call: CallHubSpot, def: ObjectDef, ms: number, afterId: string): Promise<{ records: CrmRecord[]; total: number | null; returned: number }> {
  const o = toolJson(
    await call("search_crm_objects", {
      objectType: def.objectType,
      filterGroups: [{ filters: [{ propertyName: def.modified, operator: "EQ", value: String(ms) }, { propertyName: "hs_object_id", operator: "GT", value: afterId }] }],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties: def.properties,
      limit: SEARCH_LIMIT,
    }),
    "search_crm_objects",
  );
  return { records: parseRecords(o), ...counts(o) };
}

/** A time property as an ISO string (HubSpot returns ISO strings or epoch milliseconds, as text). */
export function isoOf(v: unknown): string | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : /^\d{10,}$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/**
 * One page of owners from `offset`, active or not (records keep pointing at people who left); `next` is where the next
 * page starts, absent on the last. HubSpot gives no email.
 */
export async function ownersPage(call: CallHubSpot, offset?: number): Promise<{ owners: { id: string; name: string | null }[]; next?: number }> {
  const o = toolJson(await call("search_owners", { limit: OWNERS_PAGE, ...(offset != null ? { offset } : {}) }), "search_owners");
  if (!Array.isArray(o?.owners)) throw new Error(`unexpected search_owners answer: ${JSON.stringify(o).slice(0, 200)}`);
  const owners = o.owners.filter((x: any) => x?.ownerId != null).map((x: any) => ({ id: String(x.ownerId), name: String(x.name ?? "").trim() || null }));
  if (!o.hasMore || o.offset == null || Number(o.offset) === offset) return { owners };
  if (!Number.isInteger(Number(o.offset))) throw new Error(`unexpected search_owners offset: ${JSON.stringify(o.offset)}`);
  return { owners, next: Number(o.offset) };
}

/** Deal stage ids to labels, from the dealstage property's options. */
export async function dealStages(call: CallHubSpot): Promise<{ id: string; label: string; pipeline: string | null; order: number | null }[]> {
  const o = toolJson(await call("get_properties", { objectType: "deals", propertyNames: ["dealstage"] }), "get_properties");
  const prop = (Array.isArray(o) ? o : (o?.results ?? o?.properties ?? [o])).find((p: any) => p?.name === "dealstage") ?? {};
  return (prop.options ?? []).filter((x: any) => x?.value != null).map((x: any) => ({ id: String(x.value), label: String(x.label ?? x.value), pipeline: x.pipelineLabel ?? x.pipelineId ?? null, order: Number.isFinite(Number(x.displayOrder)) ? Number(x.displayOrder) : null }));
}
