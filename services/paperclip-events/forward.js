// What the worker sends the kernel for one Paperclip event: the task's id and whether a comment reopened it. Paperclip's
// delivery is at most once with duplicates (the scheduler spike), so the kernel only scans the task; its poll is the backstop.
export const EVENTS = ["issue.created", "issue.updated", "issue.comment.created"];

export function wakeEvent(e) {
  if (!EVENTS.includes(e?.eventType) || e.entityType !== "issue" || typeof e.entityId !== "string") return undefined;
  const p = e.payload ?? {};
  return { type: e.eventType, issueId: e.entityId, ...(typeof p.commentId === "string" ? { commentId: p.commentId } : {}), ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}), reopened: p.reopened === true, ...(typeof e.actorType === "string" ? { actorType: e.actorType } : {}), ...(typeof e.actorId === "string" ? { actorId: e.actorId } : {}) };
}

export async function forward(e, { url, key, fetch = globalThis.fetch }) {
  const body = wakeEvent(e);
  if (!body) return false;
  const r = await fetch(`${url}/v1/wakes/events`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`kernel answered ${r.status}`);
  return true;
}
