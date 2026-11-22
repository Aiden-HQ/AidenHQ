// Setup's plan against Paperclip's actual state: what each agent and routine should be (from the compiled config) next to
// what Paperclip returns for it, compared in normalised form. Only what differs is written, so an apply that changes one
// handbook writes one agent, and a UI edit or a half-finished run is put right by the next apply (Paperclip is the truth).
import { mapLimit } from "./modules.ts";
import { writeRecord, RECORD_ADAPTER } from "./record-agent.ts";
import type { Api } from "./record-agent.ts";

type Obj = Record<string, any>;
/** A Paperclip agent row. */
type Row = Obj & { id: string };
type Step = (msg: string) => void;

/** A value as JSON with sorted keys and no undefined: Paperclip returns objects with their keys reordered. */
const canon = (v: unknown): string => JSON.stringify(sorted(JSON.parse(JSON.stringify(v ?? null))));
const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

/**
 * The fields of an agent's record that differ from what setup writes. Metadata is compared whole (an agent may edit its own:
 * setup puts it back); adapterConfig only on the keys setup writes, since Paperclip adds its own (instructions paths, env).
 */
export function agentDrift(body: Obj, row: Obj) {
  const want: Obj = { ...body, ...RECORD_ADAPTER };
  return Object.keys(want).filter((k) => (k === "adapterConfig" ? Object.entries<unknown>(want.adapterConfig).some(([c, v]) => canon(row.adapterConfig?.[c]) !== canon(v)) : canon(row[k]) !== canon(want[k])));
}

/**
 * The fields of a routine that differ from what setup writes, and its triggers that do: a configured schedule missing,
 * disabled or with another cron or timezone; or any enabled trigger the compiled form no longer names (a schedule by label,
 * the routine's one webhook by `webhookLabel`). Variables are compared on the fields setup writes (Paperclip adds a label and
 * options). `fields` are the routine's own; `triggers` its triggers'.
 */
export function routineDrift(body: Obj, row: Obj, schedules: Obj[], webhookLabel?: string) {
  const pick = (v: Obj) => ({ name: v.name, type: v.type, required: v.required, defaultValue: v.defaultValue });
  const fields = Object.keys(body).filter((k) => (k === "variables" ? canon((row.variables ?? []).map(pick)) !== canon(body.variables.map(pick)) : canon(row[k]) !== canon(body[k])));
  const triggers: string[] = [];
  const all: Obj[] = row.triggers ?? [];
  for (const s of schedules) {
    const t = all.find((t) => t.kind === "schedule" && t.label === s.label);
    if (!t || !t.enabled || t.cronExpression !== s.cron || (s.timezone ?? t.timezone) !== t.timezone) triggers.push(`schedule "${s.label}"`);
  }
  for (const t of obsoleteTriggers(all, schedules, webhookLabel)) triggers.push(`${t.kind} "${t.label}" (no longer configured)`);
  return { fields, triggers };
}
/** A routine's enabled triggers the compiled form doesn't name: setup disables them. */
const obsoleteTriggers = (triggers: Obj[], schedules: Obj[], webhookLabel?: string) =>
  triggers.filter((t) => t.enabled && !(t.kind === "schedule" && schedules.some((s) => s.label === t.label)) && !(t.kind === "webhook" && t.label === webhookLabel));

const webhookOf = (row: Obj, label: string) => (row.triggers ?? []).find((t: Obj) => t.kind === "webhook" && t.label === label);

/** The last line of every routine setup creates: Paperclip itself holds the routine's compiled key, so a lost one is found again. */
export const routineMarker = (key: string) => `<!-- aidenhq:routine:${key} -->`;
const MARKER = /(?:^|\n)<!-- aidenhq:routine:([a-z0-9][a-z0-9_-]*) -->$/;
/** The compiled key a routine's own last line marks it with, or undefined (a routine made on the board). */
export const markedKey = (row: Obj) => MARKER.exec(String(row.description ?? ""))?.[1];
/** A routine's description as setup writes it: the compiled text, then the marker line. */
export const markedDescription = (description: unknown, key: string) => [String(description ?? "").trimEnd(), routineMarker(key)].filter(Boolean).join("\n\n");

/**
 * One compiled routine as setup writes it: its own fields, its status at create, its schedules and its signed webhook trigger
 * (`label`; `secret`: whether this host still holds the trigger's secret, else it is rotated).
 */
export interface RoutinePlan { key: string; title: string; body: Obj; status: string; schedules: Obj[]; webhook?: { label: string; secret: boolean } }

/**
 * A compiled routine (config/paperclip.yaml `routines.<key>`) as setup writes it, run as the Paperclip agent `agentId`.
 * `hasSecret(name)`: whether this host holds that secret (a webhook trigger's, else it is rotated). Throws on a webhook a
 * local routine names: webhooks come from product modules only (a local routine, writable through apply, could otherwise
 * take another routine's secret).
 */
export function routinePlan(key: string, r: Obj, agentId: string, hasSecret: (name: string) => boolean): RoutinePlan {
  let webhook;
  if (r.webhook) {
    if (r.tier === "local") throw new Error(`routine ${key}: a local routine can't have a webhook`);
    if (r.secrets_prefix != null && !/^[a-z0-9_]+$/.test(r.secrets_prefix)) throw new Error(`routine ${key}: secrets_prefix must be lowercase letters, digits and _`);
    // Secret files: <secrets_prefix>_url / _secret (default meeting_webhook, the transcript watcher).
    webhook = { label: r.secrets_prefix ? `${key} webhook` : "transcript watcher", secret: hasSecret(`${r.secrets_prefix ?? "meeting_webhook"}_secret`) };
  }
  const body = {
    title: r.title,
    // The compiled text, then the marker naming the routine's compiled key (its identity, held by Paperclip itself).
    description: markedDescription(r.description, key),
    assigneeAgentId: agentId,
    priority: "medium",
    concurrencyPolicy: r.concurrency ?? "coalesce_if_active",
    // Placeholders like {{tasks}} are filled by whoever starts the run (API); give them a default.
    variables: [...new Set([...String(r.description ?? "").matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))]
      .filter((v) => !["date", "timestamp"].includes(v!))
      .map((name) => ({ name, type: "text", required: false, defaultValue: "" })),
    // A lost scheduler tick still fires on the next one (Paperclip enqueues one run per missed tick, at most one for sub-hourly crons); always_enqueue routines already queue every event, so they skip.
    catchUpPolicy: (r.concurrency ?? "coalesce_if_active") === "always_enqueue" ? "skip_missed" : "enqueue_missed_with_cap",
    // A routine's model and reasoning_effort are the kernel's (grants.json `routines`); nothing rides in the routine's env.
    env: null,
  };
  // Its status at create, which compile sets from the module that defines it; Paperclip owns pause and resume after that.
  return { key, title: r.title, body, status: r.status ?? "active", schedules: r.schedules ?? [], ...(webhook ? { webhook } : {}) };
}

/**
 * Brings Paperclip's managed routines to the compiled ones, by identity, never by title. A compiled key's routine is the one
 * `keys` (the last grants table's id → key) maps it to; a key with none is recovered from the routine whose marker names it,
 * archived ones included (a crash after create, a lost create response, a removed routine coming back); only then is one
 * created, its marker in the create request. A routine's status is written only on create (and when an archived one comes
 * back): pause and resume are Paperclip's after that. Its own fields are written when they differ, and its triggers are
 * reconciled on every pass: a configured schedule is put right, and any enabled trigger the compiled form doesn't name is
 * disabled. A managed routine no longer compiled (marked, or mapped by `keys`) is archived and its triggers disabled; a
 * routine with no marker that `keys` doesn't map (made on the board) is never touched. `onKeys` gets the live id → key map
 * whenever it grows (setup writes it into the grants table before a new routine's triggers exist); `onWebhook` the secret
 * material of a webhook trigger made or rotated. Returns the live id → key map: compiled keys only.
 */
export async function syncRoutines({ api, companyId, plans, keys, step, onKeys, onWebhook }: {
  api: Api; companyId: string; plans: RoutinePlan[]; keys: Record<string, string>; step: Step;
  onKeys: (live: Record<string, string>) => void; onWebhook?: (plan: RoutinePlan, material: Obj) => void;
}): Promise<Record<string, string>> {
  const rows: Obj[] = (await api("GET", `/api/companies/${companyId}/routines`)).json;
  const compiled = new Set(plans.map((p) => p.key));
  const idOf: Record<string, string> = {};
  for (const [id, key] of Object.entries(keys)) if (compiled.has(key) && !idOf[key] && rows.some((r) => r.id === id)) idOf[key] = id;
  for (const r of rows) {
    const key = markedKey(r);
    if (key && compiled.has(key) && !idOf[key] && !Object.values(idOf).includes(r.id)) idOf[key] = r.id;
  }
  const live = Object.fromEntries(Object.entries(idOf).map(([k, id]) => [id, k]));
  onKeys({ ...live });
  const work: { plan: RoutinePlan; row?: Obj; fields: string[]; triggers: string[]; restore: boolean }[] = [];
  for (const plan of plans) {
    const row = rows.find((r) => r.id === idOf[plan.key]);
    const restore = row?.status === "archived";
    const d = row ? routineDrift(plan.body, row, plan.schedules, plan.webhook?.label) : { fields: [], triggers: [] };
    const hook = row && plan.webhook && webhookOf(row, plan.webhook.label);
    if (row && plan.webhook && (!hook || !hook.enabled || !plan.webhook.secret)) d.triggers.push(`webhook "${plan.webhook.label}"`);
    if (!row || restore || d.fields.length || d.triggers.length) {
      work.push({ plan, row, ...d, restore });
      step(`Routine ${plan.title}: ${row ? [...(restore ? ["restored"] : []), ...d.fields, ...d.triggers].join(", ") + " changed" : "new"}`);
    }
  }
  // Managed routines no longer compiled: archived, their triggers off.
  const gone = rows.filter((r) => !Object.values(idOf).includes(r.id) && ((markedKey(r) && !compiled.has(markedKey(r)!)) || (keys[r.id] && !compiled.has(keys[r.id]!))) && (r.status !== "archived" || (r.triggers ?? []).some((t: Obj) => t.enabled)));
  step(`setup: ${work.length} routines changed, ${plans.length - work.length} unchanged, ${gone.length} archived`);
  await mapLimit(work, 4, async ({ plan, row, fields, restore }: (typeof work)[number]) => {
    const created = !row;
    if (!row) {
      row = (await api("POST", `/api/companies/${companyId}/routines`, { ...plan.body, status: plan.status })).json as Obj;
      step(`Created routine ${plan.title}`);
      live[row.id] = plan.key;
      onKeys({ ...live });
    }
    const triggers: Obj[] = row.triggers ?? [];
    for (const s of plan.schedules) {
      const existing = triggers.find((t: Obj) => t.kind === "schedule" && t.label === s.label);
      if (existing) {
        if (!existing.enabled || existing.cronExpression !== s.cron || (s.timezone ?? existing.timezone) !== existing.timezone) await api("PATCH", `/api/routine-triggers/${existing.id}`, { cronExpression: s.cron, timezone: s.timezone, enabled: true });
      } else {
        await api("POST", `/api/routines/${row.id}/triggers`, { kind: "schedule", label: s.label, cronExpression: s.cron, timezone: s.timezone });
        step(`Added schedule "${s.label}" (${s.cron} ${s.timezone}) to ${plan.title}`);
      }
    }
    if (plan.webhook) {
      const hook = webhookOf(row, plan.webhook.label);
      let material: Obj | undefined;
      if (!hook) {
        material = (await api("POST", `/api/routines/${row.id}/triggers`, { kind: "webhook", label: plan.webhook.label, signingMode: "hmac_sha256", replayWindowSec: 300 })).json.secretMaterial;
        step(`Added signed webhook trigger to ${plan.title}`);
      } else {
        if (!hook.enabled) await api("PATCH", `/api/routine-triggers/${hook.id}`, { enabled: true });
        if (!plan.webhook.secret) {
          material = (await api("POST", `/api/routine-triggers/${hook.id}/rotate-secret`, {})).json.secretMaterial;
          step("Rotated webhook secret (local copy was missing)");
        }
      }
      if (material) onWebhook?.(plan, material);
    }
    for (const t of obsoleteTriggers(triggers, plan.schedules, plan.webhook?.label)) await api("PATCH", `/api/routine-triggers/${t.id}`, { enabled: false }).then(() => step(`Disabled ${t.kind} "${t.label}" on ${plan.title}: its config no longer names it`));
    // Its own fields last; its status only when it comes back from archive (pause and resume are the live controls').
    if (!created && (fields.length || restore)) await api("PATCH", `/api/routines/${row.id}`, restore ? { ...plan.body, status: plan.status } : plan.body);
  });
  for (const r of gone) {
    if (r.status !== "archived") await api("PATCH", `/api/routines/${r.id}`, { status: "archived" });
    for (const t of (r.triggers ?? []).filter((t: Obj) => t.enabled)) await api("PATCH", `/api/routine-triggers/${t.id}`, { enabled: false });
    step(`Archived routine ${r.title}: no longer configured`);
  }
  return live;
}

export interface AgentPlan { key: string; name: string; agent?: Row; body: Obj; instructions: string }

/**
 * Brings each planned agent's record and handbook (Paperclip's AGENTS.md, revisioned) to its plan, writing only those that
 * differ. Reads: the agents list the caller passed (`rows`), plus one handbook GET per existing agent (Paperclip's list
 * carries no handbook hash), a few side by side. Returns key → the agent's current row (re-listed once when anything was written).
 */
export async function syncAgents({ api, companyId, rows, plans, step }: { api: Api; companyId: string; rows: Row[]; plans: AgentPlan[]; step: Step }): Promise<Record<string, Row>> {
  const file = (id: string) => api("GET", `/api/agents/${id}/instructions-bundle/file?path=AGENTS.md`, undefined, { allow: [404] }).then((r) => r.json);
  const files: (Obj | null)[] = await mapLimit(plans, 8, (p: AgentPlan) => (p.agent ? file(p.agent.id) : null));
  const work = plans
    .map((p, i) => ({ p, cur: files[i], fields: p.agent ? agentDrift(p.body, p.agent) : [], handbook: !p.agent || files[i]?.content !== p.instructions }))
    .filter((w) => !w.p.agent || w.fields.length || w.handbook);
  for (const { p, fields, handbook } of work) step(p.agent ? `Agent ${p.name}: ${[...fields, ...(handbook ? ["handbook"] : [])].join(", ")} changed` : `Agent ${p.name}: new`);
  step(`setup: ${work.length} agents changed, ${plans.length - work.length} unchanged`);
  await mapLimit(work, 4, async ({ p, cur, fields }: (typeof work)[number]) => {
    if (!p.agent || fields.length) {
      const w = await writeRecord({ api, companyId, agent: p.agent, body: p.body, instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": p.instructions } } });
      if (w.created) { p.agent = w.agent; cur = await file(w.agent.id); step(`Created agent ${p.name}`); }
    }
    // Instructions are revisioned (2026.1106): written against the current revision.
    if (cur?.content !== p.instructions) await api("PUT", `/api/agents/${p.agent!.id}/instructions-bundle/file`, { path: "AGENTS.md", content: p.instructions, baseRevisionId: cur?.revision?.id ?? null });
  });
  const live: Row[] = work.length ? (await api("GET", `/api/companies/${companyId}/agents`)).json : rows;
  return Object.fromEntries(plans.map((p) => [p.key, live.find((x) => x.id === p.agent!.id)!]));
}
