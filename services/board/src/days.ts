// Activity: what each agent did, by the owner's local day, newest first. A view over Paperclip's
// own records (finished tasks and failed runs), not a new store.
import type { Agent, Issue, PastRun } from "./paperclip.js";

export interface ActivityItem {
  when: string;
  agent: string;
  chat: string;
  sentence: string;
  link: string;
  kind: "done" | "failed";
}

const dayIn = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });

export function activityDays(
  closed: Issue[],
  failed: PastRun[],
  agents: Agent[],
  tz: string,
  titles: Map<string, { identifier: string; title: string }> = new Map(),
): { day: string; items: ActivityItem[] }[] {
  const nameOf = (id: string | null | undefined) => agents.find((a) => a.id === id)?.name ?? "You";
  const known = new Map(titles);
  for (const i of closed) known.set(i.id, { identifier: i.identifier, title: i.title });
  const items: ActivityItem[] = [];
  for (const i of closed) {
    const when = i.completedAt ?? i.cancelledAt ?? i.updatedAt;
    const agent = nameOf(i.assigneeAgentId);
    items.push({ when, agent, chat: i.identifier, sentence: `${agent} ${i.status === "cancelled" ? "stopped" : "finished"} ${i.title}`, link: `#/t/${i.identifier}`, kind: "done" });
  }
  for (const r of failed) {
    const task = r.issueId ? known.get(r.issueId) : undefined;
    if (!task || !r.finishedAt) continue;
    const agent = nameOf(r.agentId);
    const reason = (r.error ?? "").split("\n")[0]!.trim() || "ended without a reply";
    items.push({ when: r.finishedAt, agent, chat: task.identifier, sentence: `${agent} failed on ${task.title}: ${reason}`, link: `#/t/${task.identifier}`, kind: "failed" });
  }
  items.sort((a, b) => b.when.localeCompare(a.when));
  const days = new Map<string, ActivityItem[]>();
  for (const it of items) {
    const d = dayIn(it.when, tz);
    days.set(d, [...(days.get(d) ?? []), it]);
  }
  return [...days].map(([day, list]) => ({ day, items: list }));
}
