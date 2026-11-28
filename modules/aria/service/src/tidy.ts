// The nightly tidy-up's trigger. While the owner has it on, the service files one task for Aria a night at the owner's chosen time
// (kernel.tasks, source aria:tidy:<owner-local date>, so a restart or a second look files nothing twice). While it is off the service
// does nothing and nothing is spent. Turning it on arms it for the next night: a switch flipped at 14:00 never runs a tidy-up at 14:00.
import type { State } from "./state.ts";

/** The wall clock in a zone: its date (YYYY-MM-DD) and minutes of the day. */
export function wallClock(at: Date, timeZone: string): { date: string; minute: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** A run late by more than this many hours is skipped for the night (a tidy-up at noon would move meetings in the day). */
const LATE_HOURS = 3;

/**
 * What a look at `now` does: `{ file: date }` to file tonight's task, or nothing; and the state to keep. Pure.
 * `on`/`at`: the owner's settings (at: HH:MM).
 */
export function look(now: Date, timeZone: string, on: boolean, at: string, tidy: NonNullable<State["tidy"]> | undefined): { file?: string; tidy: NonNullable<State["tidy"]> } {
  const clock = wallClock(now, timeZone);
  if (!on) return { tidy: { ...tidy, armed: false } };
  // Just turned on: today counts as done, so the first run is the next night.
  if (!tidy?.armed) return { tidy: { ...tidy, armed: true, date: clock.date } };
  const due = Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
  if (tidy.date === clock.date || clock.minute < due || clock.minute > due + LATE_HOURS * 60) return { tidy };
  return { file: clock.date, tidy };
}

export interface TidyDeps {
  now: () => Date;
  timeZone: string;
  settings: () => { on: boolean; at: string; prompt: string[]; plan: { max_moves: number; no_move_within_hours: number; horizon_working_days: number } };
  state: { get: () => State; set: (s: State) => void };
  /** Files the task; resolves its id, or false when the kernel refused or isn't reachable yet (tried again at the next look). */
  file: (title: string, description: string, source: string) => Promise<false | { id: string }>;
  log: (msg: string, f?: Record<string, unknown>) => void;
}

/** One look: arms or disarms, and files tonight's task when it is due. */
export async function tidyLook(d: TidyDeps): Promise<void> {
  const s = d.settings(), now = d.now();
  const r = look(now, d.timeZone, s.on, s.at, d.state.get().tidy);
  const keep = (tidy: NonNullable<State["tidy"]>) => d.state.set({ ...d.state.get(), tidy });
  if (!r.file) { if (JSON.stringify(r.tidy) !== JSON.stringify(d.state.get().tidy)) keep(r.tidy); return; }
  const description = [
    ...s.prompt,
    "",
    `Limits (skill optimize-calendar): at most ${s.plan.max_moves} moves tonight, counted by aria_move_budget before each one; nothing starting within ${s.plan.no_move_within_hours} hours; look ${s.plan.horizon_working_days} working days ahead.`,
  ].join("\n");
  const task = await d.file(`Aria: nightly calendar tidy-up ${r.file}`, description, `aria:tidy:${r.file}`);
  if (!task) { d.log("tidy-up not filed; trying again at the next look", { date: r.file }); return; }
  keep({ ...r.tidy, date: r.file, filed_at: now.toISOString(), task: task.id });
}
