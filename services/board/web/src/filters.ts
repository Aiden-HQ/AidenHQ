// The Tasks page's filters, as one pure function over the cards both layouts draw: filters AND, values within one OR. Every
// value is a stable id (an agent, label or project id; "me" and "none" for You and Unassigned / no project); a value whose
// thing is gone matches nothing. The lane is the kernel's (state.lane): a card with no reported state is Idle. The text is the
// kernel's task search (search.ts): a card matches when the search hit it (identifiers included: a typed prefix matches).
import type { Card, Filters, Lane, WorkCard } from "./types";

export const LANES: readonly Lane[] = ["needs_you", "working", "waiting", "blocked", "idle", "done"];
export const LANE_NAMES: Record<Lane, string> = { needs_you: "Needs you", working: "Working", waiting: "Waiting", blocked: "Blocked", idle: "Idle", done: "Done" };
export const UPDATED_NAMES = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" } as const;

/** The filters a chip can show (text is the search field). */
export type FilterKey = "agent" | "state" | "label" | "priority" | "project" | "updated";
export const FILTER_KEYS: readonly FilterKey[] = ["agent", "state", "label", "priority", "project", "updated"];
export const FILTER_NAMES: Record<FilterKey, string> = { agent: "Agent", state: "State", label: "Label", priority: "Priority", project: "Project", updated: "Updated" };

export const laneOf = (c: Card): Lane => c.state?.lane ?? "idle";
const crewOf = (c: Card | WorkCard): string[] => ("crewIds" in c ? c.crewIds : (c.crew ?? []).map((m) => m.agent));

/** Start of the viewer's day, or N days back. */
function since(updated: NonNullable<Filters["updated"]>, now: number): number {
  if (updated === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (updated === "7d" ? 7 : 30) * 864e5;
}

/** The text term: the search hit the card. `hits` undefined: no answer to apply yet, so the text hides nothing (the cards stay). */
const textMatches = (c: Card, text: string, hits: ReadonlySet<string> | undefined) => !text.trim() || !hits || hits.has(c.id);

export function cardMatches(c: Card | WorkCard, f: Filters, now = Date.now(), hits?: ReadonlySet<string>): boolean {
  const any = <T,>(vals: T[] | undefined, test: (v: T) => boolean) => !vals?.length || vals.some(test);
  return (
    any(f.agent, (a) => (a === "none" ? c.assignee === null : c.assignee === a || crewOf(c).includes(a))) &&
    any(f.state, (s) => laneOf(c) === s) &&
    any(f.label, (l) => c.labelIds.includes(l)) &&
    any(f.priority, (p) => c.priority === p) &&
    any(f.project, (p) => (p === "none" ? c.projectId === null : c.projectId === p)) &&
    (!f.updated || Date.parse(c.activityAt) >= since(f.updated, now)) &&
    textMatches(c, f.text ?? "", hits)
  );
}

export const applyFilters = <T extends Card>(cards: T[], f: Filters, hits?: ReadonlySet<string>, now = Date.now()): T[] => (isEmpty(f) ? cards : cards.filter((c) => cardMatches(c, f, now, hits)));

/** How many chips are set (text excluded: it is the search field). */
export const chipCount = (f: Filters) => FILTER_KEYS.filter((k) => (k === "updated" ? !!f.updated : !!f[k]?.length)).length;
export const isEmpty = (f: Filters) => chipCount(f) === 0 && !f.text;

/** The same filters, whatever order or empty fields they carry (a saved board's draft dot compares these). */
export function sameFilters(a: Filters, b: Filters): boolean {
  const norm = (f: Filters) => JSON.stringify(FILTER_KEYS.map((k) => (k === "updated" ? f.updated ?? null : [...(f[k] ?? [])].sort())).concat([f.text ?? ""]));
  return norm(a) === norm(b);
}

/** The filters without the empty fields (what a saved board stores). */
export function compact(f: Filters): Filters {
  const out: Filters = {};
  for (const k of FILTER_KEYS) {
    if (k === "updated") { if (f.updated) out.updated = f.updated; }
    else if (f[k]?.length) (out as Record<string, unknown>)[k] = f[k];
  }
  if (f.text) out.text = f.text;
  return out;
}
