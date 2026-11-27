// What Tasks (Mine, Delegated) and Home's "Your day" read: the owner's own tasks by bucket, the sections they are listed in, and
// the delegated groups. One place counts them, so Home's tiles and the Tasks page can never disagree. A task assigned to an
// agent is Delegated, never "mine".
import { laneOf } from "./filters";
import { BUCKETS, type Board, type Bucket, type Card, type WorkCard } from "./types";
import { stateWords } from "./ui/TaskState";
import { SOURCE_NAMES, addDays, dayDate, ago, todayIn } from "./util";

export type Buckets = Record<Bucket, Card[]>;

export const isMine = (c: Card) => c.assignee === "me";

/** The owner's own tasks in each bucket (`keep`: a search's filter). */
export const mineOf = (items: Buckets, keep: (c: Card) => boolean = () => true): Buckets =>
  Object.fromEntries(BUCKETS.map((b) => [b, items[b].filter((c) => isMine(c) && keep(c))])) as Buckets;

/** Every task of Mine: the tab's count and Home's. */
export const mineCount = (mine: Buckets) => BUCKETS.reduce((n, b) => n + mine[b].length, 0);

/** Next Monday after `today` (YYYY-MM-DD): where Later's "Next week" goes. */
export const nextWeekOf = (today: string) => addDays(today, (8 - new Date(`${today}T00:00:00Z`).getUTCDay()) % 7 || 7);

export type Section = "new" | "today" | "upcoming" | "later";
/** The page's sections, in order: New is the triage bucket, Upcoming holds Tomorrow and the week's. `into`: the bucket a move to the section lands in. */
export const SECTIONS: readonly { id: Section; name: string; buckets: readonly Bucket[]; into: Bucket }[] = [
  { id: "new", name: "New", buckets: ["triage"], into: "triage" },
  { id: "today", name: "Today", buckets: ["today"], into: "today" },
  { id: "upcoming", name: "Upcoming", buckets: ["tomorrow", "later"], into: "later" },
  { id: "later", name: "Later", buckets: ["backlog"], into: "backlog" },
];
/** Rows New shows before "Show all N". */
export const NEW_ROWS = 5;

export const sectionOf = (b: Bucket): Section => SECTIONS.find((s) => s.buckets.includes(b))!.id;

/** Upcoming's tasks by date: Tomorrow's own bucket under its date, a scheduled task under its day, the rest of the week's bucket last. */
export function upcomingGroups(mine: Buckets, board: Pick<Board, "timezone" | "rollsOn">): { label: string; cards: Card[] }[] {
  const tomorrow = addDays(todayIn(board.timezone), 1);
  const label = (date: string) => (date === tomorrow ? `Tomorrow · ${dayDate(date)}` : dayDate(date));
  const by = new Map<string, Card[]>();
  const add = (date: string, c: Card) => by.set(date, [...(by.get(date) ?? []), c]);
  for (const c of mine.tomorrow) add(c.scheduled?.date ?? board.rollsOn, c);
  const undated: Card[] = [];
  for (const c of mine.later) (c.scheduled ? add(c.scheduled.date, c) : undated.push(c));
  const groups = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, cards]) => ({ label: label(date), cards }));
  return undated.length ? [...groups, { label: "Coming up", cards: undated }] : groups;
}

/** The icon a task's source gets: the labels that say where a task came from (util SOURCE_NAMES), each with a kind. */
const KINDS: Record<string, "chat" | "mail" | "calendar" | "pr" | "doc"> = { "needs-response": "chat", email: "mail", "meeting-action": "calendar", "needs-review": "pr", engineer: "pr" };
export const SOURCES = Object.fromEntries(Object.entries(SOURCE_NAMES).map(([label, name]) => [label, { name, kind: KINDS[label] ?? "doc" }])) as Record<string, { name: string; kind: "chat" | "mail" | "calendar" | "pr" | "doc" }>;
export function sourceOf(c: Card): { name: string; kind: "chat" | "mail" | "calendar" | "pr" | "doc"; label?: string } {
  const l = c.labels.find((x) => SOURCES[x.name]);
  return l ? { ...SOURCES[l.name]!, label: l.name } : { name: "Board", kind: "doc" };
}

/** An amber line for a task that waits: a person's reply (Intake's "Reply to <person>: …"), or something owed to the owner. */
export function waitingOf(c: Card, now = Date.now()): string | undefined {
  const named = c.labels.some((l) => l.name === "needs-response");
  const owed = c.labels.some((l) => l.name === "waiting-on");
  if (!named && !owed) return undefined;
  const person = named ? /^Reply to (.+?):/i.exec(c.title)?.[1] : undefined;
  return `${named ? (person ? `${person} is waiting for you` : "Waiting for your reply") : "Waiting on a reply"} · ${ago(c.createdAt, now)}`;
}

/** A task's one chip: its project, else its first label. */
export function chipOf(card: Card, projects: Board["projects"]): string | undefined {
  const project = projects?.find((p) => p.id === card.projectId)?.name;
  const label = card.labels.find((l) => l.name !== "daily-brief")?.name;
  return project ?? (label && (SOURCE_NAMES[label] ?? label)) ?? undefined;
}

export type DelegatedGroup = "working" | "waiting" | "queued" | "done";
export const DELEGATED: readonly { id: DelegatedGroup; name: string }[] = [
  { id: "working", name: "Working" },
  { id: "waiting", name: "Waiting on you" },
  { id: "queued", name: "Queued" },
  { id: "done", name: "Done today" },
];

/**
 * The tasks assigned to agents by the kernel's lane: working; Waiting on you holds what needs the owner and what is blocked
 * (both are his to act on); the rest are queued; finished ones show for the day (a search shows every close it found). One function: the tab's count is the first
 * three groups.
 */
export function delegatedOf(work: WorkCard[], anyDay = false, agentsOnly = true): Record<DelegatedGroup, WorkCard[]> {
  const out: Record<DelegatedGroup, WorkCard[]> = { working: [], waiting: [], queued: [], done: [] };
  const today = new Date().toDateString();
  for (const c of work) {
    // A saved board that picked Unassigned or You keeps those tasks.
    if (agentsOnly && (!c.assignee || c.assignee === "me")) continue;
    const lane = laneOf(c);
    if (c.closedAt || lane === "done") {
      // The viewer's day, as the times on the rows are; a search lists every close it found.
      if (anyDay || (c.closedAt && new Date(c.closedAt).toDateString() === today)) out.done.push(c);
    } else out[lane === "working" ? "working" : lane === "needs_you" || lane === "blocked" ? "waiting" : "queued"].push(c);
  }
  return out;
}
export const delegatedCount = (g: Record<DelegatedGroup, WorkCard[]>) => g.working.length + g.waiting.length + g.queued.length;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** What a delegated task says it is doing: the kernel's own words for its state (the question it asked, the card that waits, the stage). */
export function progressOf(c: WorkCard): string {
  const s = c.state;
  if (!s) return c.status === "done" || c.closedAt ? "Done" : "No reported state";
  if (laneOf(c) === "needs_you") {
    const a = s.attention.find((x) => x.who === "owner");
    if (a?.why === "card") return "Approval card ready";
    if (s.question) return `Asked you: ${s.question}`;
  }
  const w = stateWords(s);
  return cap(w.detail) || w.word;
}

/** A column's second line on All: today's date, when Tomorrow rolls into Today, what the others hold. */
export function hintOf(bucket: Bucket, board: Pick<Board, "timezone" | "rollsTomorrow" | "rollsOn">): string {
  if (bucket === "today") return new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: board.timezone });
  if (bucket === "tomorrow") return board.rollsTomorrow ? "Rolls into Today" : `Rolls into Today on ${new Date(`${board.rollsOn}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}`;
  return { triage: "New tasks land here", later: "Coming up", backlog: "Someday" }[bucket] ?? "";
}
