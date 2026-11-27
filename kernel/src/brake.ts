// The notify brake (POST /v1/brake/notify; spec §2.5, lean-core 2f): an agent may send at most NOTIFY_LIMIT notify messages
// about one task since the owner last wrote there (and the owner's midnight), so a looping agent can't flood the owner. A decision is
// never held back (it still counts). The owner's router (owner-channel) asks before it sends. The owner's last message is
// read as the owner (the board key); unreadable, nothing is limited (fail open).
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import { dayStart, ownerDay } from "./owner-day.ts";

export const NOTIFY_LIMIT = 5;

/** The owner's own words: not an agent's, and no AidenHQ marker, except the board passing on what the owner wrote elsewhere. */
export const isOwnerComment = (c: { body?: string; authorType?: string | null; authorAgentId?: string | null }) =>
  !(c.authorType === "agent" || c.authorAgentId) && (!String(c.body ?? "").includes("<!-- aidenhq-") || String(c.body).includes("<!-- aidenhq-from:"));

export function createBrake({ db, owner, timezone, now = Date.now }: { db: DatabaseSync; owner: Api; /** The owner's timezone: the limit counts from the owner's midnight. */ timezone?: () => unknown; now?: () => number }) {
  db.exec("CREATE TABLE IF NOT EXISTS notify_brake (task TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS notify_brake_task ON notify_brake (task, agent, at);");
  return async function notify(b: { task?: unknown; agent?: unknown; decision?: unknown }): Promise<{ allow: boolean; note?: string }> {
    const task = typeof b.task === "string" ? b.task.slice(0, 100) : "", agent = typeof b.agent === "string" ? b.agent.slice(0, 100) : "";
    if (!task) return { allow: true };
    const t = now();
    const day = dayStart(ownerDay(t, timezone?.()), timezone?.());
    db.prepare("DELETE FROM notify_brake WHERE at < ?").run(day - 86_400_000);
    if (b.decision !== true) {
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=100`).catch(() => undefined);
      if (r?.status === 200) {
        const list = (Array.isArray(r.json) ? r.json : (r.json?.comments ?? [])) as { body?: string; authorType?: string; authorAgentId?: string; createdAt?: string }[];
        const at = list.filter(isOwnerComment).map((c) => Date.parse(String(c.createdAt))).filter(Number.isFinite);
        const since = Math.max(day, ...at);
        const n = (db.prepare("SELECT count(*) AS n FROM notify_brake WHERE task = ? AND agent = ? AND at >= ?").get(task, agent, since) as { n: number }).n;
        if (n >= NOTIFY_LIMIT) return { allow: false, note: `Limit reached: ${NOTIFY_LIMIT} messages about ${task} since the owner last wrote there (or since midnight in the owner's timezone). Nothing was sent; batch it into your next update, after they reply or tomorrow.` };
      }
    }
    db.prepare("INSERT INTO notify_brake (task, agent, at) VALUES (?, ?, ?)").run(task, agent, t);
    return { allow: true };
  };
}
export type Brake = ReturnType<typeof createBrake>;
