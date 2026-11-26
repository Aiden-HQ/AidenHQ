// The task a delegation asked to be filed under, when the control plane placed it somewhere else. Paperclip limits
// agent-created trees to parent → child: a grandchild request is not refused, the task is placed beside its requester (or,
// when the caller didn't authorize that placement, at the top level) and the create response says so (`parentAdjusted`),
// and later reads carry only the placed `parentId`. AidenHQ routes a task's delegator, its parent notices and its sibling
// grouping by the task that asked for it, so the paperclip-events plugin records that task in the new task's description
// when the two differ. Reads fall back to `parentId`, which is the requested parent whenever no placement happened: a tree
// that was never adjusted resolves exactly as it did before.
//
// The marker goes FIRST in the description: Paperclip cuts every description in a task list to 1200 characters
// (`ISSUE_LIST_DESCRIPTION_MAX_CHARS`, `descriptionTruncated`), so a marker at the end of a long brief would be invisible to
// the readers that scan lists. A row that is still truncated without a marker is read whole (`requesterOfListed`).
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

/** The requester a task's description records, without the `parentId` fallback: undefined on a task that carries none. */
export function recordedRequesterOf(t: { description?: unknown } | undefined): string | undefined {
  return MARK.exec(String(t?.description ?? ""))?.[1] || undefined;
}

/** `text` with the requester marker `original` carried, first: an edit replaces the text the marker sits in, and the routing
 * it records must outlive that. Text that itself carries a marker is stripped of it, so only `original`'s counts. */
export function withRequester(original: unknown, text: string): string {
  const had = recordedRequesterOf({ description: original });
  const body = String(text).replace(MARK_G, "").trim();
  return had ? `${requestedParentMarker(had)}\n\n${body}` : body;
}

/** The task a delegation was asked to be filed under: the recorded requester, else the task's `parentId`; never the task itself. */
export function requestedParentOf(t: { id?: unknown; parentId?: string | null; description?: unknown } | undefined): string | undefined {
  const asked = recordedRequesterOf(t);
  const parent = asked || (typeof t?.parentId === "string" && t.parentId ? t.parentId : undefined);
  return parent && parent !== t?.id ? parent : undefined;
}

/**
 * The requester of a task read from a list, where Paperclip cuts every description to 1200 characters: a row whose
 * `descriptionTruncated` is true and carries no visible marker is read whole, so a marker the cut hid still resolves.
 * `full` reads one task (a single-task read is never cut).
 *
 * A row that is cut without a marker is only a preview, so it is never decided on: if `full` cannot read the task this
 * throws. Falling back to its `parentId` would route the task to the placed parent the cut exposed instead of the requester
 * the marker records — a wrong delegator, a dropped notice, or (in grading) a live child left out of its batch. A caller
 * that cannot tell retries; a caller that must answer says the read failed.
 */
export async function requesterOfListed(
  t: { id?: unknown; parentId?: string | null; description?: unknown; descriptionTruncated?: unknown } | undefined,
  full: (id: string) => Promise<{ description?: unknown } | undefined>,
): Promise<string | undefined> {
  if (t?.descriptionTruncated === true && typeof t.id === "string" && !recordedRequesterOf(t)) {
    const whole = await full(t.id);
    if (whole) return requestedParentOf({ ...t, description: whole.description });
  }
  return requestedParentOf(t);
}
