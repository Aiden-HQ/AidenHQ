// A chat's handed-out work and its live state (ChatPane.tsx), and the apps pinned into the nav. Pure, so it can be tested
// without React.
import { isActive, needsOwner } from "./ui/TaskState";
import type { ShownState } from "./types.js";
import { isLocalDoor } from "./util.js";

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

/** A chat's handed-out tasks for its Tasks panel: what needs the owner, what is running, what waits, and the recent finished ones. */
export function groupTasks<T extends { state: ShownState | null; updatedAt: string }>(items: T[], now = Date.now()): { needs: T[]; working: T[]; waiting: T[]; finished: T[] } {
  const cutoff = new Date(now - 7 * 86_400_000).toISOString();
  const done = items.filter((t) => t.state?.kind === "done");
  const open = items.filter((t) => t.state?.kind !== "done");
  return {
    needs: open.filter((t) => needsOwner(t.state)).sort(newestFirst),
    working: open.filter((t) => !needsOwner(t.state) && t.state?.kind === "working").sort(newestFirst),
    waiting: open.filter((t) => !needsOwner(t.state) && t.state?.kind !== "working").sort(newestFirst),
    finished: done.filter((t) => t.updatedAt >= cutoff).sort(newestFirst).slice(0, 5),
  };
}
/** A chat that may be settled: nothing running and nothing waiting on anyone (the board checks again). */
export const settleableChat = (s: ShownState | null) => !isActive(s);

/** A run is live somewhere: poll faster. */
export const anyLive = (rows: { state: ShownState | null }[]) => rows.some((r) => r.state?.kind === "working" || r.state?.reason === "job_queued");

/**
 * The apps pinned into the nav (apps.yaml `panel`): links to each app's own https URL, or its local door when this browser
 * can open one (`localDoors`, util.ts keepsSecureCookies), never frames (an app signs in at the gate).
 */
export function panelsOf(apps: { name: string; panel?: string; url?: string }[], localDoors = false): { name: string; label: string; url: string }[] {
  return apps.flatMap((a) => (a.panel && a.url && (a.url.startsWith("https://") || (localDoors && isLocalDoor(a.url))) ? [{ name: a.name, label: a.panel, url: a.url }] : []));
}
