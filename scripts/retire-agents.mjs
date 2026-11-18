/**
 * Setup-owned agents (setupKey aidenhq:<key>) that are no longer configured (pruned, or their module disabled) are
 * terminated, so they leave the board's agent list and its "needs you" count; the routines of a setup-owned agent that are
 * no longer configured are archived. ensureAgents ignores terminated agents and creates a fresh one if the key returns,
 * and ensureRoutines reactivates an archived routine by title.
 */
export async function retireUnconfigured({ api, companyId, cfg, step }) {
  const keys = new Set(Object.keys(cfg.agents ?? {}).map((k) => `aidenhq:${k}`));
  const titles = new Set(Object.values(cfg.routines ?? {}).map((r) => r.title));
  const { json: all } = await api("GET", `/api/companies/${companyId}/agents`);
  const owned = all.filter((x) => String(x.metadata?.setupKey ?? "").startsWith("aidenhq:") && x.status !== "terminated");
  const ownedIds = new Set(owned.map((x) => x.id));
  const { json: routines } = await api("GET", `/api/companies/${companyId}/routines`);
  for (const r of routines.filter((r) => ownedIds.has(r.assigneeAgentId) && !titles.has(r.title) && r.status !== "archived")) {
    await api("PATCH", `/api/routines/${r.id}`, { status: "archived" });
    step(`Archived routine ${r.title} (no longer configured)`);
  }
  for (const x of owned.filter((x) => !keys.has(x.metadata.setupKey))) {
    await api("POST", `/api/agents/${x.id}/terminate`, {});
    step(`Terminated ${x.name} (no longer configured)`);
  }
}
