// calendar_find_times: meeting times that fit the owner's calendar, working hours and preferences. Pure: the events and the
// attendees' busy time come in (accounts.ts fetches them), a ranked list goes out.
import type { GEvent } from "./workspace.js";
import { dateIn, nextDate, renderInZone, validZone, wallOn } from "./zones.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Day = (typeof DAYS)[number];
type Windows = [string, string][];

export interface FindTimesArgs {
  duration_min: number;
  window_start: string;
  window_end: string;
  attendees?: string[];
  working_hours: Record<Day, Windows>;
  call_windows?: { best?: Windows; ok?: Windows };
  /** Each omitted constraint is none: no buffer, no notice, no daily cap. */
  buffer_min?: number;
  min_notice_hours?: number;
  max_per_day?: number;
  /** Attendees' IANA zones, resolved by the caller. One missing or invalid is ignored, never guessed. */
  attendee_timezones?: Record<string, string>;
  /** The attendees' local hours slots are ranked into first; default 09:00-18:00. Never excludes a slot. */
  attendee_hours?: [string, string];
  timezone: string;
  account?: string;
}

export type Tier = "best" | "ok" | "last_resort";
export interface FoundSlot { start: string; end: string; tier: Tier; timezone: string }
export type AttendeeFreebusy = "used" | "not_granted" | "not_visible";
export interface AttendeeStatus { email: string; freebusy: AttendeeFreebusy; timezone_known: boolean }
export interface FoundTimes { slots: FoundSlot[]; attendee_freebusy: AttendeeFreebusy; attendees: AttendeeStatus[] }
const DEFAULT_ATTENDEE_HOURS: [string, string] = ["09:00", "18:00"];

/** Candidate starts fall on this many minutes of the local wall clock. */
const GRANULARITY_MIN = 15;
/** A meeting this close to a slot (beyond the buffer) still counts as back-to-back. */
const ADJACENT_SLACK_MS = 5 * 60_000;
/** A flight's destination stays the owner's place this long without a later flight. */
const FLIGHT_LAPSE_MS = 14 * 86_400_000;
const MAX_SLOTS = 30;
const DAY_MS = 86_400_000;

/** How far before a window find_times must read events: a flight that landed earlier still sets the owner's zone. */
export const LOOKBACK_MS = FLIGHT_LAPSE_MS + DAY_MS;

const FLIGHT = /\bflight\b/i;
const STAY = /hotel|airbnb|\bstay\b|accommodation|\btrip\b/i;

export interface Block { start: number; end: number; title: string; /** A meeting of the owner's (not a flight, an absence or someone else's busy time). */ meeting: boolean }

const isFlight = (e: GEvent) => FLIGHT.test(e.summary ?? "");
/** Working-location entries, Gmail's travel reservations and all-day "Hotel"/"Trip" markers say where the owner is; they do not block time. A timed meeting with such a word in its title is still a meeting. */
const isStay = (e: GEvent) => !isFlight(e) && (e.eventType === "workingLocation" || e.eventType === "fromGmail" || (!e.start?.dateTime && STAY.test(e.summary ?? "")));
const declined = (e: GEvent) => e.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false;
/** Only the owner's own travel moves the owner: entries they organised or accepted. Someone else's invitation is just text. */
const ownTravel = (e: GEvent) => e.status !== "cancelled" && !declined(e) && (e.organizer?.self === true || e.attendees?.some((a) => a.self && a.responseStatus === "accepted") === true);

function span(e: GEvent, zone: string): [number, number] | undefined {
  if (e.start?.dateTime) return [Date.parse(e.start.dateTime), Date.parse(e.end?.dateTime ?? e.start.dateTime)];
  if (e.start?.date && e.end?.date) return [wallOn(e.start.date, 0, zone) ?? Date.parse(e.start.date), wallOn(e.end.date, 0, zone) ?? Date.parse(e.end.date)];
  return undefined;
}

/**
 * What an event blocks on the owner's calendar: timed and opaque all-day events, not declined, cancelled or marked free;
 * travel reservations and working locations never block. An all-day date starts at midnight in `zone`. `except`: an event id
 * (or series id) to leave out, the one being moved.
 */
export function blocksOf(events: GEvent[], zone: string, except?: string): Block[] {
  const out: Block[] = [];
  for (const e of events) {
    if (e.status === "cancelled" || declined(e) || e.transparency === "transparent" || isStay(e)) continue;
    if (except && (e.id === except || e.recurringEventId === except)) continue;
    const s = span(e, zone);
    if (!s || !(s[1] > s[0])) continue;
    out.push({ start: s[0], end: s[1], title: e.summary ?? "", meeting: !!e.start?.dateTime && !isFlight(e) && e.eventType !== "outOfOffice" });
  }
  return out;
}

/** The first block overlapping [start, end). */
export const conflictWith = (blocks: Block[], start: number, end: number) => blocks.find((b) => start < b.end && end > b.start);

/**
 * The zone the owner is in on `date` (a day of `home`'s calendar): the arrival zone of the latest flight (organised or
 * accepted by the owner) that left by noon and landed within 14 days; else the zone of a stay or working location covering the
 * day; else `home`. An entry carries its zone on its own start/end `timeZone`; one without a known zone changes nothing.
 */
export function zoneOn(date: string, home: string, events: GEvent[], calendarZone = home): string {
  const noon = wallOn(date, 12 * 60, home)!;
  const dayStart = wallOn(date, 0, home) ?? noon - 12 * 3_600_000;
  const dayEnd = dayStart + DAY_MS;
  let best: { at: number; zone: string } | undefined;
  for (const e of events) {
    if (!isFlight(e) || !ownTravel(e)) continue;
    const zone = e.end?.timeZone ?? e.start?.timeZone;
    const s = span(e, calendarZone);
    if (!validZone(zone) || !s || s[0] > noon || s[1] < noon - FLIGHT_LAPSE_MS) continue;
    if (!best || s[0] > best.at) best = { at: s[0], zone };
  }
  if (best) return best.zone;
  const stay = events
    .filter((e) => isStay(e) && ownTravel(e) && validZone(e.start?.timeZone))
    .map((e) => ({ zone: e.start!.timeZone!, s: span(e, calendarZone) }))
    .filter((x) => x.s && x.s[0] < dayEnd && x.s[1] > dayStart)
    .sort((a, b) => b.s![0] - a.s![0])[0];
  return stay?.zone ?? home;
}

const OFFSET = /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/;
const MAX_WINDOW_DAYS = 62;
/** The window's instants: ISO-8601 with an explicit offset (a bare time would be read in the server's zone), at most 62 days. */
export function windowOf(args: { window_start: string; window_end: string }): [number, number] {
  for (const t of [args.window_start, args.window_end]) if (!t.includes("T") || !OFFSET.test(t) || Number.isNaN(Date.parse(t))) throw new Error(`"${t}" is not an ISO-8601 date-time with its offset (2026-12-02T09:00:00+04:00)`);
  const w: [number, number] = [Date.parse(args.window_start), Date.parse(args.window_end)];
  if (w[1] <= w[0]) throw new Error("window_end must be after window_start");
  if (w[1] - w[0] > MAX_WINDOW_DAYS * DAY_MS) throw new Error(`the window is longer than ${MAX_WINDOW_DAYS} days: ask for a shorter one`);
  return w;
}

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`"${hhmm}" is not a time: use HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const weekday = (date: string): Day => DAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;

interface Candidate { start: number; end: number; tier: Tier; zone: string; sides: number; /** Inside every known attendee zone's local hours. */ theirs: boolean }
const TIER_RANK: Record<Tier, number> = { best: 0, ok: 1, last_resort: 2 };

/**
 * Slots of `duration_min` inside `working_hours` (the owner's wall clock on each day, in the zone the owner is in that day),
 * clear of busy time plus `buffer_min` either side and of the attendees' busy time, at least `min_notice_hours` away, on days
 * with fewer than `max_per_day` meetings (each constraint optional, none when omitted). Ranked: inside every attendee's local hours (only attendees with a known zone; never excludes a slot), then tier (inside a best call window, an ok one, else last resort), then
 * back-to-back with a meeting of the owner's (both sides before one side), then earliest. Overlapping slots are thinned to the
 * best of each, so the list is distinct choices rather than every quarter-hour of one gap.
 */
export function findTimes(args: FindTimesArgs, events: GEvent[], attendeeBusy: { start: string; end: string }[], now = Date.now(), calendarZone = args.timezone): FoundSlot[] {
  if (!validZone(args.timezone)) throw new Error(`unknown timezone ${args.timezone}`);
  const [from, to] = windowOf(args);
  if (!(args.duration_min > 0)) throw new Error("duration_min must be positive");
  const home = args.timezone;
  const durMs = args.duration_min * 60_000;
  const buf = (args.buffer_min ?? 0) * 60_000;
  const busy = blocksOf(events, calendarZone);
  const theirs = attendeeBusy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => b.end > b.start);
  const earliest = now + (args.min_notice_hours ?? 0) * 3_600_000;
  const calls = args.call_windows;
  const windowsOf = (w?: Windows) => (w ?? []).map(([a, b]) => [minutes(a), minutes(b)] as const);
  const [best, ok] = [windowsOf(calls?.best), windowsOf(calls?.ok)];
  const tiered = best.length + ok.length > 0;

  // Only attendees with a valid zone count: one without is ignored, and with none the ranking is the owner's alone.
  const known = new Map(Object.entries(args.attendee_timezones ?? {}).map(([e, z]) => [e.toLowerCase(), z]));
  const attendeeZones = [...new Set((args.attendees ?? []).map((a) => known.get(a.toLowerCase())).filter(validZone))];
  const [theirOpen, theirClose] = (args.attendee_hours ?? DEFAULT_ATTENDEE_HOURS).map(minutes) as [number, number];
  const inTheirHours = (start: number, end: number) =>
    attendeeZones.every((z) => {
      const [s, e] = [renderInZone(new Date(start).toISOString(), z), renderInZone(new Date(end).toISOString(), z)];
      return s.slice(0, 10) === e.slice(0, 10) && minutes(s.slice(11, 16)) >= theirOpen && minutes(e.slice(11, 16)) <= theirClose;
    });

  const found = new Map<number, Candidate>();
  // One day either side: a day's hours in another zone can reach into the window from a neighbouring date.
  for (let date = dateIn(from - DAY_MS, home), last = dateIn(to + DAY_MS, home); date <= last; date = nextDate(date)) {
    const zone = zoneOn(date, home, events, calendarZone);
    const todays = busy.filter((b) => b.meeting && dateIn(b.start, zone) === date).length;
    if (args.max_per_day !== undefined && todays >= args.max_per_day) continue;
    for (const [a, b] of args.working_hours[weekday(date)] ?? []) {
      const [open, close] = [minutes(a), minutes(b)];
      const closeAt = wallOn(date, close, zone);
      if (closeAt === undefined) continue;
      for (let t = Math.ceil(open / GRANULARITY_MIN) * GRANULARITY_MIN; t < close; t += GRANULARITY_MIN) {
        const start = wallOn(date, t, zone);
        if (start === undefined) continue;
        const end = start + durMs;
        if (end > closeAt || start < from || end > to || start < earliest || found.has(start)) continue;
        if (busy.some((x) => start < x.end + buf && end > x.start - buf) || theirs.some((x) => start < x.end && end > x.start)) continue;
        const inside = (ws: readonly (readonly [number, number])[]) => ws.some(([x, y]) => x <= t && t + args.duration_min <= y);
        const tier: Tier = !tiered || inside(best) ? "best" : inside(ok) ? "ok" : "last_resort";
        const slack = buf + ADJACENT_SLACK_MS;
        const sides = (busy.some((m) => m.meeting && start >= m.end && start - m.end <= slack) ? 1 : 0) + (busy.some((m) => m.meeting && m.start >= end && m.start - end <= slack) ? 1 : 0);
        found.set(start, { start, end, tier, zone, sides, theirs: inTheirHours(start, end) });
      }
    }
  }

  const ranked = [...found.values()].sort((x, y) => Number(y.theirs) - Number(x.theirs) || TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.sides - x.sides || x.start - y.start);
  const picked: Candidate[] = [];
  for (const c of ranked) {
    if (picked.length >= MAX_SLOTS) break;
    if (!picked.some((p) => c.start < p.end && c.end > p.start)) picked.push(c);
  }
  return picked.map((c) => ({ start: renderInZone(new Date(c.start).toISOString(), c.zone), end: renderInZone(new Date(c.end).toISOString(), c.zone), tier: c.tier, timezone: c.zone }));
}
