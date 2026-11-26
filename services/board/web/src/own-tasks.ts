// What "My tasks" and Home's "Your day" read: the owner's own tasks by bucket, and the Delegated summary. One place counts
// them, so Home's tiles and the Tasks page can never disagree. A task assigned to an agent is Delegated, never "mine".
import { BUCKETS, type Board, type Bucket, type Card, type NeedRow, type WorkCard } from "./types";
import { SOURCE_NAMES } from "./util";

export type Buckets = Record<Bucket, Card[]>;

export const isMine = (c: Card) => c.assignee === "me";

/** The owner's own tasks in each bucket (`keep`: a search's filter). */
export const mineOf = (items: Buckets, keep: (c: Card) => boolean = () => true): Buckets =>
  Object.fromEntries(BUCKETS.map((b) => [b, items[b].filter((c) => isMine(c) && keep(c))])) as Buckets;

/** Backlog rows shown before "Show all N". */
export const BACKLOG_TOP = 3;

/** The planning groups My tasks lists, in order (This week is the `later` bucket). */
export const GROUPS: readonly Bucket[] = ["today", "tomorrow", "later", "backlog"];
/** What the Inbox's quick moves send a task to, in order. */
export const QUICK_MOVES: readonly (readonly [Bucket, string])[] = [["today", "Today"], ["tomorrow", "Tomorrow"], ["later", "Week"], ["backlog", "Later"]];

/** What My tasks draws: the planning groups, Backlog cut to its top few unless `all` or a search is on. */
export const visibleOf = (mine: Buckets, narrowed: boolean, all: boolean): Buckets => (narrowed || all ? mine : { ...mine, backlog: mine.backlog.slice(0, BACKLOG_TOP) });

/** Delegated at a glance: the open tasks assigned to agents, and how many run or queue now. */
export function delegatedOf(work: WorkCard[]) {
  const open = work.filter((c) => c.assignee && c.assignee !== "me" && !c.closedAt && c.state?.lane !== "done");
  return {
    total: open.length,
    running: open.filter((c) => c.state?.kind === "working").length,
    queued: open.filter((c) => c.state?.reason === "job_queued" || c.state?.reason === "job_held").length,
  };
}

/** "2 approvals, 1 question": what the team needs, by kind. */
export function needsSummary(needs: NeedRow[]): string {
  const n = (kind: NeedRow["kind"]) => needs.filter((r) => r.kind === kind).length;
  const part = (count: number, one: string, many = `${one}s`) => (count ? [`${count} ${count === 1 ? one : many}`] : []);
  return [...part(n("approval"), "approval"), ...part(n("answer"), "question"), ...part(n("open"), "update")].join(", ");
}

/** A group's second line: today's date, when Tomorrow rolls into Today, what the others hold. */
export function hintOf(bucket: Bucket, board: Pick<Board, "timezone" | "rollsTomorrow" | "rollsOn">): string {
  if (bucket === "today") return new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: board.timezone });
  if (bucket === "tomorrow") return board.rollsTomorrow ? "Rolls into Today" : `Rolls into Today on ${new Date(`${board.rollsOn}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}`;
  return { triage: "New tasks land here", later: "This week or so", backlog: "Someday" }[bucket] ?? "";
}

/** A task's one chip: its project, else its first label. */
export function chipOf(card: Card, projects: Board["projects"]): string | undefined {
  const project = projects?.find((p) => p.id === card.projectId)?.name;
  const label = card.labels.find((l) => l.name !== "daily-brief")?.name;
  return project ?? (label && (SOURCE_NAMES[label] ?? label)) ?? undefined;
}
