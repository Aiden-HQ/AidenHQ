#!/usr/bin/env node
// A read-only per-agent baseline over a window: runs, billed spend, tasks done and cancelled, write-record outcomes.
//   node scripts/fleet-baseline.ts --days 14 > out.json
// Env: KERNEL_DB (data/kernel/kernel.db), PAPERCLIP_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_KEY_FILE.
// Reads only: SQLite opened readOnly, Paperclip GET.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { paperclipClient } from "../kernel/sdk/src/paperclip.ts";
import { OWNER_SQL } from "../kernel/src/records.ts";

const DAY = 864e5;

interface PaperclipAgent { id: string; name?: string; metadata?: { setupKey?: string } }
interface Issue { id: string; status: string; assigneeAgentId?: string; completedAt?: string; updatedAt: string }
interface Paperclip { agents(): Promise<PaperclipAgent[]>; closed(since: string): Promise<Issue[]> }
interface Stats { runs: number; costUsd: number; tasksDone: number; tasksCancelled: number; costPerDone: number | null; records: { filed: number; rejected: number; failed: number; ownerDecided: number } }

export async function baseline({ days, now = new Date() }: { days: number; now?: Date }, { kernelDb, paperclip }: { kernelDb: DatabaseSync; paperclip: Paperclip }) {
  const from = new Date(Date.parse(now.toISOString().slice(0, 10)) - (days - 1) * DAY);
  const fromIso = from.toISOString();
  const fromDay = fromIso.slice(0, 10);
  const names = new Map((await paperclip.agents()).map((a): [string, string] => [a.id, a.metadata?.setupKey ?? a.name ?? a.id]));
  const key = (id: string) => names.get(id) ?? id;
  const agents: Record<string, Stats> = {};
  const of = (id: string) => (agents[key(id)] ??= { runs: 0, costUsd: 0, tasksDone: 0, tasksCancelled: 0, costPerDone: null, records: { filed: 0, rejected: 0, failed: 0, ownerDecided: 0 } });

  for (const r of kernelDb.prepare("SELECT agent_id, COUNT(DISTINCT run_key) runs, SUM(cost_usd) cost FROM calls WHERE day >= ? AND agent_id IS NOT NULL GROUP BY agent_id").all(fromDay) as unknown as { agent_id: string; runs: number; cost: number | null }[]) {
    const a = of(r.agent_id);
    a.runs = r.runs;
    a.costUsd = r.cost ?? 0;
  }
  for (const r of kernelDb.prepare(`SELECT json_extract(requester, '$.agent') agent, COUNT(*) filed, SUM(state = 'rejected') rejected, SUM(state = 'failed') failed, SUM(${OWNER_SQL}) owner
      FROM records WHERE created_at >= ? AND json_extract(requester, '$.agent') IS NOT NULL GROUP BY 1`).all(fromIso) as unknown as { agent: string; filed: number; rejected: number; failed: number; owner: number }[]) {
    of(r.agent).records = { filed: r.filed, rejected: r.rejected, failed: r.failed, ownerDecided: r.owner };
  }
  for (const i of await paperclip.closed(fromIso)) {
    if (!i.assigneeAgentId || (i.completedAt ?? i.updatedAt) < fromIso) continue;
    const a = of(i.assigneeAgentId);
    if (i.status === "cancelled") a.tasksCancelled++;
    if (i.status !== "done") continue;
    a.tasksDone++;
  }
  for (const a of Object.values(agents)) a.costPerDone = a.tasksDone ? a.costUsd / a.tasksDone : null;
  return { window: { from: fromIso, to: now.toISOString() }, agents };
}

/** Paperclip over GET only: the company's agents and its done/cancelled tasks since a time, paged. */
export function paperclipReader(url: string, companyId: string, key: string, fetcher: typeof fetch = fetch): Paperclip {
  const client = paperclipClient({ url, token: key, lane: "direct", timeoutMs: 30_000, fetcher });
  const get = (path: string) => client.request("GET", path);
  return {
    agents: () => get(`/api/companies/${companyId}/agents`),
    async closed(since: string) {
      const all: Issue[] = [];
      for (let offset = 0; ; offset += 500) {
        const q = new URLSearchParams({ status: "done,cancelled", limit: "500", offset: String(offset), excludeRoutineExecutions: "true", updatedSince: since });
        const page = await get(`/api/companies/${companyId}/issues?${q}`);
        all.push(...page);
        if (page.length < 500) return all;
      }
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n: string, d: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const need = (n: string): string => process.env[n] ?? (console.error(`${n} is required`), process.exit(2));
  const out = await baseline(
    { days: Number(arg("--days", "14")) },
    {
      kernelDb: new DatabaseSync(need("KERNEL_DB"), { readOnly: true }),
      paperclip: paperclipReader(need("PAPERCLIP_URL"), need("PAPERCLIP_COMPANY_ID"), readFileSync(need("PAPERCLIP_KEY_FILE"), "utf8").trim()),
    },
  );
  console.log(JSON.stringify(out, null, 2));
}
