#!/usr/bin/env node
// A read-only per-agent baseline over a window: runs, billed spend, tasks done and cancelled, write-record outcomes and grades.
//   node scripts/fleet-baseline.mjs --days 14 > out.json
// Env: KERNEL_DB (data/kernel/kernel.db), GRADES_DB (grading module's grades.sqlite), PAPERCLIP_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_KEY_FILE.
// Reads only: SQLite opened readOnly, Paperclip GET. `reopened` = done tasks the grader sent back at least once (attempts > 0).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { OWNER_SQL } from "../kernel/src/records.ts";

const DAY = 864e5;

export async function baseline({ days, now = new Date() }, { kernelDb, gradesDb, paperclip }) {
  const from = new Date(Date.parse(now.toISOString().slice(0, 10)) - (days - 1) * DAY);
  const fromIso = from.toISOString();
  const fromDay = fromIso.slice(0, 10);
  const names = new Map((await paperclip.agents()).map((a) => [a.id, a.metadata?.setupKey ?? a.name ?? a.id]));
  const key = (id) => names.get(id) ?? id;
  const agents = {};
  const of = (id) => (agents[key(id)] ??= { runs: 0, costUsd: 0, tasksDone: 0, tasksCancelled: 0, costPerDone: null, records: { filed: 0, rejected: 0, failed: 0, ownerDecided: 0 }, grades: { satisfied: 0, escalated: 0, failed: 0 }, reopened: 0 });

  for (const r of kernelDb.prepare("SELECT agent_id, COUNT(DISTINCT run_key) runs, SUM(cost_usd) cost FROM calls WHERE day >= ? AND agent_id IS NOT NULL GROUP BY agent_id").all(fromDay)) {
    const a = of(r.agent_id);
    a.runs = r.runs;
    a.costUsd = r.cost ?? 0;
  }
  for (const r of kernelDb.prepare(`SELECT json_extract(requester, '$.agent') agent, COUNT(*) filed, SUM(state = 'rejected') rejected, SUM(state = 'failed') failed, SUM(${OWNER_SQL}) owner
      FROM records WHERE created_at >= ? AND json_extract(requester, '$.agent') IS NOT NULL GROUP BY 1`).all(fromIso)) {
    of(r.agent).records = { filed: r.filed, rejected: r.rejected, failed: r.failed, ownerDecided: r.owner };
  }
  const grade = new Map(gradesDb.prepare("SELECT issue_id, state, failures, attempts FROM grades").all().map((g) => [g.issue_id, g]));
  for (const i of await paperclip.closed(fromIso)) {
    if (!i.assigneeAgentId || (i.completedAt ?? i.updatedAt) < fromIso) continue;
    const a = of(i.assigneeAgentId);
    if (i.status === "cancelled") a.tasksCancelled++;
    if (i.status !== "done") continue;
    a.tasksDone++;
    const g = grade.get(i.id);
    if (!g) continue;
    if (g.state === "satisfied") a.grades.satisfied++;
    if (g.state === "escalated") a.grades.escalated++;
    if (g.state === "grading_failed") a.grades.failed++;
    if (g.attempts > 0) a.reopened++;
  }
  for (const a of Object.values(agents)) a.costPerDone = a.tasksDone ? a.costUsd / a.tasksDone : null;
  return { window: { from: fromIso, to: now.toISOString() }, agents };
}

/** Paperclip over GET only: the company's agents and its done/cancelled tasks since a time, paged. */
export function paperclipReader(url, companyId, key, fetchFn = fetch) {
  const get = async (path) => {
    const res = await fetchFn(new URL(path, url), { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Paperclip GET ${path.split("?")[0]} -> ${res.status}`);
    return res.json();
  };
  return {
    agents: () => get(`/api/companies/${companyId}/agents`),
    async closed(since) {
      const all = [];
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
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const need = (n) => process.env[n] ?? (console.error(`${n} is required`), process.exit(2));
  const out = await baseline(
    { days: Number(arg("--days", "14")) },
    {
      kernelDb: new DatabaseSync(need("KERNEL_DB"), { readOnly: true }),
      gradesDb: new DatabaseSync(need("GRADES_DB"), { readOnly: true }),
      paperclip: paperclipReader(need("PAPERCLIP_URL"), need("PAPERCLIP_COMPANY_ID"), readFileSync(need("PAPERCLIP_KEY_FILE"), "utf8").trim()),
    },
  );
  console.log(JSON.stringify(out, null, 2));
}
