// What Aria proposes for a new owner's settings from their last weeks of meetings: working hours per weekday and the calendars
// that block time. Pure code (the model reads the calendar and hands the meetings here; it never does this arithmetic).
// The owner only corrects a proposal on the Aria page and saves it.
import { DAYS } from "./settings.ts";

/** A meeting as Aria read it: instants (ISO, with Z or an offset). */
export interface Meeting { start: string; end: string; all_day?: boolean }
export interface Suggestion {
  working_hours: Record<(typeof DAYS)[number], string>;
  blocking_calendars: string[];
  /** What it was worked out from: meetings counted, the fraction of them inside the proposed hours. */
  based_on: { meetings: number; coverage: number };
}

const WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const two = (n: number) => String(n).padStart(2, "0");
const hm = (m: number) => `${two(Math.floor(m / 60))}:${two(m % 60)}`;
/** A day's date, weekday and minutes of the day on the wall clock of `timeZone`. */
function local(at: number, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(at));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const day = (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const).indexOf(get("weekday") as "Sun");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, day: WEEKDAY[day < 0 ? 0 : day]!, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

const domain = (email: string) => email.toLowerCase().split("@")[1] ?? "";
/** A quantile of a sorted list, the lower side for the start and the upper for the end, so that at most `p` of the meetings fall outside it. */
const cut = (sorted: number[], p: number, low: boolean) => sorted[low ? Math.floor(sorted.length * p) : Math.ceil(sorted.length * (1 - p)) - 1]!;

/**
 * The proposal. Hours per weekday cover at least 90% of that weekday's meetings (the earliest and latest 5% of starts and ends are
 * left outside, rounded outward to the half hour), and a weekday with meetings on fewer than two different dates is off.
 */
export function suggest(meetings: Meeting[], opts: { timeZone: string; calendars?: string[] }): Suggestion {
  const rows = meetings.flatMap((m) => {
    // A date-only start is an all-day entry; an end at or before the start is nothing to place.
    if (m.all_day || !/T/.test(m.start) || !/T/.test(m.end)) return [];
    const [s, e] = [Date.parse(m.start), Date.parse(m.end)];
    if (!(e > s)) return [];
    const a = local(s, opts.timeZone), b = local(e, opts.timeZone);
    // A meeting that runs past midnight on the wall clock is capped at the day's end.
    return [{ day: a.day, date: a.date, from: a.minute, to: b.date === a.date ? b.minute : 24 * 60 - 1 }];
  });
  const hours = Object.fromEntries(DAYS.map((d) => {
    const mine = rows.filter((r) => r.day === d);
    if (new Set(mine.map((r) => r.date)).size < 2) return [d, "off"];
    const starts = mine.map((r) => r.from).sort((x, y) => x - y), ends = mine.map((r) => r.to).sort((x, y) => x - y);
    const from = Math.floor(cut(starts, 0.05, true) / 30) * 30, to = Math.min(24 * 60 - 1, Math.ceil(cut(ends, 0.05, false) / 30) * 30);
    return [d, to > from ? `${hm(from)}-${hm(to)}` : "off"];
  })) as Suggestion["working_hours"];
  const inside = rows.filter((r) => { const h = hours[r.day]; if (h === "off") return false; const [a, b] = h.split("-") as [string, string]; return r.from >= Number(a.slice(0, 2)) * 60 + Number(a.slice(3)) && r.to <= Number(b.slice(0, 2)) * 60 + Number(b.slice(3)); }).length;
  const calendars = [...new Set((opts.calendars ?? []).map((c) => c.trim()).filter(Boolean))].slice(0, 20);
  return { working_hours: hours, blocking_calendars: calendars.length ? calendars : ["primary"], based_on: { meetings: rows.length, coverage: rows.length ? Math.round((inside / rows.length) * 1000) / 1000 : 0 } };
}

/** Email domains that are no organisation: never a team. */
const CONSUMER = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "aol.com", "gmx.com", "fastmail.com"]);
/** The owner's own organisation domain, the team Aria starts with; none for a personal address. */
export const teamDomainOf = (email: string | undefined): string | undefined => { const d = domain(email ?? ""); return d && !CONSUMER.has(d) ? d : undefined; };
