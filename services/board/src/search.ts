// Task search (docs/design/task-search.md), as the board reads it: the warehouse module's search (its board provider, POST
// /search, through the kernel's /v1/board-api/warehouse/search with the board's key). The module ranks; the board keeps its
// lanes, so it takes the ranked hit ids (what its inventory holds: open, and closed in the last 48 hours), and draws the tasks
// closed before that, a page at a time newest first, as Done cards. Without the module the kernel answers 404: unavailable.
import { isWork, onMyDay, workCard, type Assignee, type WorkCard } from "./board.js";
import type { Issue, Label } from "./paperclip.js";

/** An older closed hit as the module answers it (modules/warehouse/search/src/search.ts Hit; change them together). */
export type Hit = {
  id: string; identifier: string; title: string; status: string; closedAt: string | null; updatedAt: string | null; assignee: string | null;
  assigneeUser: string | null; createdByAgent: string | null; projectId: string | null; labels: { id: string; name: string }[]; priority: string | null;
};
/**
 * `recent` (the first page only): the hits closed in the board's window, as cards too, for one its inventory lacks (no task
 * state yet). `recent` and `done` hits carry their crew: the agents on their subtasks (other than the assignee), as Agent work
 * counts it.
 */
export type SearchAnswer = { ids: string[]; recent?: (Hit & { crew: string[] })[]; done: (Hit & { crew: string[] })[]; next: string | null; semantic: boolean };
export type TaskSearch = { search(q: string, page: { closedBefore: string; after?: string; keyword?: boolean; limit: number }): Promise<SearchAnswer> };

export function kernelSearch(k: { url: string; token: string }): TaskSearch {
  return {
    async search(q, page) {
      const body = { q, closed_before: page.closedBefore, limit: page.limit, ...(page.after ? { after: page.after } : {}), ...(page.keyword ? { keyword: true } : {}) };
      const res = await fetch(`${k.url}/v1/board-api/warehouse/search`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`task search answered ${res.status}`);
      return (await res.json()) as SearchAnswer;
    },
  };
}

/**
 * What the Tasks page takes from an answer: the ids of the hits its inventory holds (rank order), and the closed hits as Done
 * cards (the recent ones, which the page drops where it holds them, then the page of older ones), newest close first, drawn by the board's own card projection (workCard). Only what Agent work would
 * show: not the brief, the owner's settings tasks or setup's log tasks. Their state is Paperclip's own close (no task-state row is
 * read for a task closed long ago).
 */
export function searchView(a: SearchAnswer, ctx: { me: string; labels: Label[]; assignees: Assignee[]; logs: Set<string> }): { ids: string[]; done: (WorkCard & { mine: boolean; recent?: true })[]; next: string | null; semantic: boolean } {
  const colour = new Map(ctx.labels.map((l) => [l.id, l.color]));
  const done: (WorkCard & { mine: boolean; recent?: true })[] = [];
  const recent = new Set((a.recent ?? []).map((h) => h.id));
  for (const h of [...(a.recent ?? []), ...a.done]) {
    if (ctx.logs.has(h.id) || ctx.logs.has(h.identifier)) continue;
    const closed = h.closedAt ?? h.updatedAt ?? "";
    const issue = {
      id: h.id, identifier: h.identifier, title: h.title, description: null, status: h.status, priority: h.priority ?? "medium",
      assigneeAgentId: h.assignee, assigneeUserId: h.assigneeUser, assigneeAdapterOverrides: null, createdByAgentId: h.createdByAgent,
      // Its close orders Done; its last update is what the Updated filter reads.
      labels: h.labels.map((l) => ({ id: l.id, name: l.name, color: colour.get(l.id) ?? "" })), createdAt: closed, updatedAt: h.updatedAt ?? closed,
      completedAt: h.status === "done" ? closed : null, cancelledAt: h.status === "cancelled" ? closed : null, projectId: h.projectId,
    } as Issue;
    if (!isWork(issue)) continue;
    const state = { task: h.id, identifier: h.identifier, idle_wakes: 0, kind: "done" as const, reason: h.status === "cancelled" ? ("cancelled" as const) : ("closed" as const), since: closed, holder: null, attention: [], lane: "done" as const };
    // `mine`: what My day's own Done would hold (log tasks are already left out above).
    // `recent`: closed in the board's window (My day's own Done lists every such close it shows; Agent work may lack one).
    done.push({ ...workCard(issue, ctx.assignees, state, null, h.crew), mine: onMyDay(issue, ctx), ...(recent.has(h.id) ? { recent: true as const } : {}) });
  }
  return { ids: a.ids, done, next: a.next, semantic: a.semantic };
}
