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
 * The fields of a routine that differ from what setup writes, and its schedule triggers that do (missing, disabled, another
 * cron or timezone; or enabled while the config no longer names it). Variables are compared on the fields setup writes
 * (Paperclip adds a label and options).
 */
export function routineDrift(body: Obj, row: Obj, schedules: Obj[]) {
  const pick = (v: Obj) => ({ name: v.name, type: v.type, required: v.required, defaultValue: v.defaultValue });
  const out = Object.keys(body).filter((k) => (k === "variables" ? canon((row.variables ?? []).map(pick)) !== canon(body.variables.map(pick)) : canon(row[k]) !== canon(body[k])));
  const triggers: Obj[] = (row.triggers ?? []).filter((t: Obj) => t.kind === "schedule");
  for (const s of schedules) {
    const t = triggers.find((t) => t.label === s.label);
    if (!t || !t.enabled || t.cronExpression !== s.cron || (s.timezone ?? t.timezone) !== t.timezone) out.push(`schedule "${s.label}"`);
  }
  for (const t of triggers) if (t.enabled && !schedules.some((s) => s.label === t.label)) out.push(`schedule "${t.label}" (no longer configured)`);
  return out;
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
