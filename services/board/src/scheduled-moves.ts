// Scheduled moves ("bring this back on the 15th", Snooze): on a date the board moves a task to a column. The user (board UI) and the
// Researcher (tasks bridge) reach this through app.ts; the board's minute loop (main.ts) applies the due ones.
import { z } from "zod";
import { BadRequest } from "./board.js";
import { DATE, addDays } from "./dates.js";
import type { Issue } from "./paperclip.js";
import { BUCKETS, localDate, type Store } from "./store.js";

const CLOSED = new Set(["done", "cancelled"]);
const MAX_AHEAD_DAYS = 366;

export const ScheduleSchema = z.union([
  z
    .object({
      // Today when absent (first-pass triage places a task now).
      date: z.string().regex(DATE, "date must be YYYY-MM-DD").optional(),
      bucket: z.enum(BUCKETS).default("today"),
      position: z.enum(["top", "bottom"]).default("top"),
      // Where the task waits until then (Snooze parks it in Backlog); left where it is when absent.
      park: z.enum(BUCKETS).optional(),
      // Why an agent placed it (first-pass triage, skill owner-triage): shown on the task until the owner moves it.
      reason: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

export interface ScheduleView {
  date: string;
  bucket: string;
  position: "top" | "bottom";
}

/** Schedule (or clear) a move, parking the task in a column until then if asked. A date of today moves the task right away. */
export function scheduleMove(store: Store, issue: Issue, input: z.infer<typeof ScheduleSchema>, tz: string, by = ""): { scheduled: ScheduleView | null; movedNow: boolean } {
  if ("clear" in input) {
    store.unschedule(issue.id);
    return { scheduled: null, movedNow: false };
  }
  if (CLOSED.has(issue.status)) throw new BadRequest("this task is closed");
  if (store.recurring(issue.id)) throw new BadRequest("this is a recurring task; its runs land in Today by themselves");
  const today = localDate(tz);
  const date = input.date ?? today;
  /** A move now: an agent's placement keeps its reason; anyone else's is a move by hand. */
  const moveNow = (bucket: (typeof BUCKETS)[number], position: "top" | "bottom" = "top") => (input.reason && by ? store.place(issue.id, bucket, input.reason, by, position) : store.move(issue.id, bucket, position));
  if (date < today) throw new BadRequest(`${date} is in the past (today is ${today})`);
  if (date > addDays(today, MAX_AHEAD_DAYS)) throw new BadRequest("at most a year ahead");
  if (date === today) {
    moveNow(input.bucket, input.position);
    return { scheduled: null, movedNow: true };
  }
  // Parking is a move by hand, which drops any earlier schedule, so it goes first.
  if (input.park) moveNow(input.park);
  // `parked` is what the rollover reads: only a card a schedule parked waits for its own move.
  store.schedule(issue.id, date, input.bucket, input.position, Boolean(input.park));
  return { scheduled: { date, bucket: input.bucket, position: input.position }, movedNow: false };
}
