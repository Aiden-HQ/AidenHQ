// The task a delegation asked to be filed under, when the control plane placed it somewhere else. Paperclip limits
// agent-created trees to parent → child: a grandchild request is not refused, the task is created beside its requester
// under the requester's parent and the create response says so (`parentAdjusted`), and later reads carry only the placed
// `parentId`. AidenHQ routes a task's delegator, its parent notices and its sibling grouping by the task that asked for
// it, so the paperclip-events plugin records that task in the new task's description when the two differ. Reads fall back
// to `parentId`, which is the requested parent whenever no placement happened: a tree that was never adjusted resolves
// exactly as it did before.
//
// The marker is in the `aidenhq:` namespace, which the plugin's text sanitiser and the task tools both quote out of any
// text an agent writes, so only the plugin's own write can produce one.
//
// Canonical copy: services/shared/requested-parent.ts. Byte-identical copies (scripts/sync-shared.ts) live in the task
// tools, dispatch and the grading service.
const MARK = /<!--\s*aidenhq:requested-parent:([A-Za-z0-9_-]{1,100})\s*-->/;
const MARK_G = new RegExp(MARK.source, "g");

/** The marker that records `id` as the task a delegation was asked to be filed under. */
export const requestedParentMarker = (id: string) => `<!-- aidenhq:requested-parent:${id} -->`;

/**
 * `edited` with any `requested-parent` marker the task already carried kept on it: a description rewritten by a later edit
 * (task_update, the board's own edit or merge) replaces the text the marker sits in, and the routing it records must outlive
 * that. The marker goes last, as the plugin writes it.
 */
export function keepRequestedParent(original: unknown, edited: string): string {
  const had = MARK.exec(String(original ?? ""))?.[1];
  const text = edited.replace(MARK_G, "");
  return had ? `${text.trimEnd()}\n\n${requestedParentMarker(had)}`.trimStart() : text;
}

/** The task a delegation was asked to be filed under: the recorded requester, else the task's `parentId`; never the task itself. */
export function requestedParentOf(t: { id?: unknown; parentId?: string | null; description?: unknown } | undefined): string | undefined {
  const asked = MARK.exec(String(t?.description ?? ""))?.[1];
  const parent = asked || (typeof t?.parentId === "string" && t.parentId ? t.parentId : undefined);
  return parent && parent !== t?.id ? parent : undefined;
}
