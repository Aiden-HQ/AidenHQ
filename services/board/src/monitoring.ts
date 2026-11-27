/**
 * The monitoring module's board route (modules/monitoring, docs/design/monitoring.md), on the internal listener with its own
 * token (MONITORING_TOKEN_FILE), never the board's internal token:
 *   GET /internal/metrics  Prometheus text: approval cards created and decided today by tier, and pending by tier. The detector's
 *                          open incidents and firing alerts are the fleet-steward service's own /metrics.
 */
import type { Approval, Records } from "./records.js";
import { dayStart, ownerDay } from "./aidenhq-sdk/owner-day.js";

/** Prometheus text exposition (version 0.0.4). */
export async function metricsText(records: Pick<Records, "list">, tz: string, now = Date.now()): Promise<string> {
  const since = new Date(dayStart(ownerDay(now, tz), tz)).toISOString();
  const cards = await records.list("recent", { limit: 1000 });
  const count = (xs: Approval[], by: (a: Approval) => Record<string, string | number>): [Record<string, string | number>, number][] => {
    const n = new Map<string, [Record<string, string | number>, number]>();
    for (const a of xs) n.set(JSON.stringify(by(a)), [by(a), (n.get(JSON.stringify(by(a)))?.[1] ?? 0) + 1]);
    return [...n.values()];
  };
  const out: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", rows: [Record<string, string | number>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of rows) {
      const l = Object.entries(labels).map(([k, x]) => `${k}="${String(x).replace(/["\\\n]/g, "_")}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${v}`);
    }
  };
  metric("aidenhq_board_cards_created_today", "Approval cards created today (the owner's day), by tier.", "gauge", count(cards.filter((a) => a.createdAt >= since), (a) => ({ tier: a.tier })));
  metric("aidenhq_board_cards_decided_today", "Approval cards decided today (the owner's day), by tier and outcome state.", "gauge", count(cards.filter((a) => (a.decidedAt ?? "") >= since), (a) => ({ tier: a.tier, state: a.state })));
  metric("aidenhq_board_cards_pending", "Approval cards waiting for a decision, by tier.", "gauge", [1, 2].map((t) => [{ tier: t }, cards.filter((a) => a.state === "pending" && a.tier === t).length]));
  return out.join("\n") + "\n";
}
