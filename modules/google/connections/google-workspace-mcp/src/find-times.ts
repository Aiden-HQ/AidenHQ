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
  /** The owner is always required. `required` must be free for a slot to be offered; `optional` only count in `optional_free`. */
  required: string[];
  optional?: string[];
  working_hours: Record<Day, Windows>;
  call_windows?: { best?: Windows; ok?: Windows };
  /** Each omitted constraint is none: no buffer, no notice, no daily cap. */
  buffer_min?: number;
  min_notice_hours?: number;
  max_per_day?: number;
  /** What the caller knows of each attendee (Slack profile, memory): zone and, if known, their own hours. Missing or invalid data is ignored, never guessed. */
  attendees_local?: Record<string, { timezone?: string; hours?: [string, string] }>;
  /** Core hours of an attendee with a zone but no hours of their own (default 09:00-18:00). */
  default_hours?: [string, string];
  /** Stretch hours of such an attendee (default 06:00-22:00). */
  default_stretch?: [string, string];
  /** How far beyond core a person with known hours stretches, and the owner beyond working_hours (default 2). */
  stretch_hours?: number;
  /** strict: working_hours only; stretch (default): up to stretch_hours beyond them; any: any hour. */
  owner_hours?: "strict" | "stretch" | "any";
  /** The owner's busy time from these events (ids) counts as free: the owner is willing to move them. */
  movable_event_ids?: string[];
  /** A slot must also be free at the same weekday and time in each of the next N weeks (default 1: this one only). */
  weeks?: number;
  /** Only these weekdays. */
  days?: Day[];
  /** Owner-local ranges ranked higher. */
  preferred?: Windows;
  timezone: string;
  account?: string;
}

export type Tier = "best" | "ok" | "last_resort";
export type AttendeeFreebusy = "used" | "not_granted" | "not_visible";
export type PersonStatus = "free" | "busy" | "unknown";
export type PersonTier = "core" | "stretch" | "outside" | "unknown";
export interface PersonSlot { email: string; status: PersonStatus; tier: PersonTier }
export interface FoundSlot { start: string; end: string; tier: Tier; timezone: string; people: PersonSlot[]; optional_free: number }
export type HoursSource = "given" | "inferred" | "default";
/** What the search knows of one invited person: their busy time (undefined: not visible), zone and hours (minutes of their day). */
export interface PersonInput { email: string; required: boolean; busy?: { start: string; end: string }[]; zone?: string; core?: [number, number]; stretch?: [number, number] }
export interface CheckedCandidate { start: string; end: string; owner_conflicts: { event_id: string; title: string }[]; people: PersonSlot[] }
/** `hours`: the core hours used for an attendee with a known zone: given by the caller, inferred from their busy history, or the default. */
export interface AttendeeStatus { email: string; freebusy: AttendeeFreebusy; timezone_known: boolean; hours?: { core: [string, string]; source: HoursSource }; optional?: true }
export interface FoundTimes { slots: FoundSlot[]; attendee_freebusy: AttendeeFreebusy; attendees: AttendeeStatus[] }
/** A person as the tools show them: how their calendar was read, their zone, and the hours used (core and stretch) with where they came from. */
export interface PersonView { email: string; freebusy: AttendeeFreebusy; busy?: { start: string; end: string }[]; timezone?: string; hours?: { core: [string, string]; stretch: [string, string]; source: HoursSource } }
export const DEFAULT_HOURS: [string, string] = ["09:00", "18:00"];
/** Hours are inferred from this many past days of busy time, needing at least MIN_BUSY_DAYS days with a block and a span of 4 to 14 hours. */
export const HISTORY_DAYS = 28;
const MIN_BUSY_DAYS = 8;
export const DEFAULT_STRETCH: [string, string] = ["06:00", "22:00"];
export const DEFAULT_STRETCH_HOURS = 2;

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

export interface Block { id: string; start: number; end: number; title: string; /** A meeting of the owner's (not a flight, an absence or someone else's busy time). */ meeting: boolean }

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
    out.push({ id: e.id, start: s[0], end: s[1], title: e.summary ?? "", meeting: !!e.start?.dateTime && !isFlight(e) && e.eventType !== "outOfOffice" });
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

export const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`"${hhmm}" is not a time: use HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
};
const weekday = (date: string): Day => DAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7]!;

interface Candidate { start: number; end: number; tier: Tier; zone: string; sides: number; /** People (the owner and the required with a known zone) in their stretch hours, and outside their hours. */ stretch: number; outside: number; preferred: boolean; people: PersonSlot[]; optionalFree: number }
const TIER_RANK: Record<Tier, number> = { best: 0, ok: 1, last_resort: 2 };
const BAND_NAME = ["core", "stretch", "outside"] as const;

/** 0: inside `core`, 1: inside `stretch`, 2: outside, for a slot on `zone`'s wall clock. */
function band(start: number, end: number, zone: string, core: readonly [number, number], stretch: readonly [number, number]): 0 | 1 | 2 {
  const [s, e] = [renderInZone(new Date(start).toISOString(), zone), renderInZone(new Date(end).toISOString(), zone)];
  const endMin = s.slice(0, 10) === e.slice(0, 10) ? minutes(e.slice(11, 16)) : e.slice(0, 10) === nextDate(s.slice(0, 10)) && e.slice(11, 16) === "00:00" ? 1440 : Infinity;
  const sm = minutes(s.slice(11, 16));
  return sm >= core[0] && endMin <= core[1] ? 0 : sm >= stretch[0] && endMin <= stretch[1] ? 1 : 2;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** One person's status and hours-tier for the slot [start, end). */
function personAt(p: PersonInput, start: number, end: number): PersonSlot {
  const status: PersonStatus = p.busy === undefined ? "unknown" : p.busy.some((b) => start < Date.parse(b.end) && end > Date.parse(b.start)) ? "busy" : "free";
  const tier: PersonTier = p.zone && p.core && p.stretch ? BAND_NAME[band(start, end, p.zone, p.core, p.stretch)] : "unknown";
  return { email: p.email, status, tier };
}

/**
 * Slots of `duration_min` that fit the owner's calendar and the `required` people's busy time, clear of busy time plus
 * `buffer_min` either side, at least `min_notice_hours` away, on days with fewer than `max_per_day` meetings (each constraint
 * optional, none when omitted). Owner hours: `owner_hours` strict (working_hours only), stretch (the default: up to
 * `stretch_hours` beyond), or any. `movable_event_ids` free the owner's time; `weeks` N needs the same time free in the next
 * N weeks; `days` limits the weekdays. Ranked: everyone required in core hours, then fewer people outside their hours, then
 * fewer in stretch (only people with a known zone; never excluded for hours), then inside `preferred`, then tier (inside a
 * best call window, an ok one, else last resort), then back-to-back with a meeting of the owner's (both sides before one side),
 * then more optional people free, then earliest. Overlapping slots are thinned to the best of each.
 */
export function findTimes(args: FindTimesArgs, events: GEvent[], people: PersonInput[], now = Date.now(), calendarZone = args.timezone): FoundSlot[] {
  if (!validZone(args.timezone)) throw new Error(`unknown timezone ${args.timezone}`);
  const [from, to] = windowOf(args);
  if (!(args.duration_min > 0)) throw new Error("duration_min must be positive");
  const weeks = args.weeks ?? 1;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 8) throw new Error("weeks must be 1 to 8");
  const home = args.timezone;
  const durMs = args.duration_min * 60_000;
  const buf = (args.buffer_min ?? 0) * 60_000;
  const movable = new Set(args.movable_event_ids ?? []);
  const busy = blocksOf(movable.size ? events.filter((e) => !movable.has(e.id) && !(e.recurringEventId && movable.has(e.recurringEventId))) : events, calendarZone);
  const mustBeFree = people.filter((p) => p.required && p.busy).flatMap((p) => p.busy!.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))).filter((b) => b.end > b.start);
  const earliest = now + (args.min_notice_hours ?? 0) * 3_600_000;
  const calls = args.call_windows;
  const windowsOf = (w?: Windows) => (w ?? []).map(([a, b]) => [minutes(a), minutes(b)] as const);
  const [best, ok, preferred] = [windowsOf(calls?.best), windowsOf(calls?.ok), windowsOf(args.preferred)];
  const tiered = best.length + ok.length > 0;
  const mode = args.owner_hours ?? "stretch";
  const stretchMin = (args.stretch_hours ?? DEFAULT_STRETCH_HOURS) * 60;
  const ownerStretch = mode === "stretch" ? stretchMin : 0;
  const free = (start: number, end: number) => !busy.some((x) => start < x.end + buf && end > x.start - buf) && !mustBeFree.some((x) => start < x.end && end > x.start);
  const workings = (day: Day) => (args.working_hours[day] ?? []).map((w) => [minutes(w[0]), minutes(w[1])] as const);

  const found = new Map<number, Candidate>();
  // One day either side: a day's hours in another zone can reach into the window from a neighbouring date.
  for (let date = dateIn(from - DAY_MS, home), last = dateIn(to + DAY_MS, home); date <= last; date = nextDate(date)) {
    if (args.days && !args.days.includes(weekday(date))) continue;
    const zone = zoneOn(date, home, events, calendarZone);
    const todays = busy.filter((b) => b.meeting && dateIn(b.start, zone) === date).length;
    if (args.max_per_day !== undefined && todays >= args.max_per_day) continue;
    const ownerCore = workings(weekday(date));
    // The owner's hours: working hours, stretched by stretch_hours, or the whole day.
    const ranges = mode === "any" ? [[0, 1440] as const] : ownerCore.map(([a, b]) => [Math.max(0, a - ownerStretch), Math.min(1440, b + ownerStretch)] as const);
    for (const [open, close] of ranges) {
      const closeAt = wallOn(date, close, zone);
      if (closeAt === undefined) continue;
      for (let t = Math.ceil(open / GRANULARITY_MIN) * GRANULARITY_MIN; t < close; t += GRANULARITY_MIN) {
        const start = wallOn(date, t, zone);
        if (start === undefined) continue;
        const end = start + durMs;
        if (end > closeAt || start < from || end > to || start < earliest || found.has(start) || !free(start, end)) continue;
        // The same wall-clock time in each of the next weeks must be free too.
        let repeats = true;
        for (let k = 1; k < weeks && repeats; k++) {
          const s2 = wallOn(addDays(date, 7 * k), t, zone);
          repeats = s2 !== undefined && free(s2, s2 + durMs);
        }
        if (!repeats) continue;
        const inside = (ws: readonly (readonly [number, number])[]) => ws.some(([x, y]) => x <= t && t + args.duration_min <= y);
        const tier: Tier = !tiered || inside(best) ? "best" : inside(ok) ? "ok" : "last_resort";
        const slack = buf + ADJACENT_SLACK_MS;
        const sides = (busy.some((m) => m.meeting && start >= m.end && start - m.end <= slack) ? 1 : 0) + (busy.some((m) => m.meeting && m.start >= end && m.start - end <= slack) ? 1 : 0);
        const ownerBand = ownerCore.length ? Math.min(...ownerCore.map((c) => band(start, end, zone, c, [Math.max(0, c[0] - ownerStretch), Math.min(1440, c[1] + ownerStretch)] as const))) : 2;
        const seen = people.map((p) => personAt(p, start, end));
        const rated = [ownerBand, ...people.flatMap((p, i) => (p.required && seen[i]!.tier !== "unknown" ? [BAND_NAME.indexOf(seen[i]!.tier as "core")] : []))];
        found.set(start, {
          start, end, tier, zone, sides, preferred: inside(preferred), people: seen,
          stretch: rated.filter((x) => x === 1).length, outside: rated.filter((x) => x === 2).length,
          optionalFree: people.reduce((n, p, i) => n + (!p.required && seen[i]!.status === "free" ? 1 : 0), 0),
        });
      }
    }
  }

  const ranked = [...found.values()].sort((x, y) => Number(!!(x.stretch + x.outside)) - Number(!!(y.stretch + y.outside)) || x.outside - y.outside || x.stretch - y.stretch || Number(!x.preferred) - Number(!y.preferred) || TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.sides - x.sides || y.optionalFree - x.optionalFree || x.start - y.start);
  const picked: Candidate[] = [];
  for (const c of ranked) {
    if (picked.length >= MAX_SLOTS) break;
    if (!picked.some((p) => c.start < p.end && c.end > p.start)) picked.push(c);
  }
  return picked.map((c) => ({ start: renderInZone(new Date(c.start).toISOString(), c.zone), end: renderInZone(new Date(c.end).toISOString(), c.zone), tier: c.tier, timezone: c.zone, people: c.people, optional_free: c.optionalFree }));
}

/** The verifier for slots composed by hand: per candidate, the owner's overlapping events and each person's status and hours-tier. */
export function checkTimes(candidates: { start: string; end: string }[], events: GEvent[], people: PersonInput[], calendarZone: string): CheckedCandidate[] {
  const busy = blocksOf(events, calendarZone);
  return candidates.map((c) => {
    const [start, end] = [Date.parse(c.start), Date.parse(c.end)];
    return {
      start: c.start,
      end: c.end,
      owner_conflicts: busy.filter((b) => start < b.end && end > b.start).map((b) => ({ event_id: b.id, title: b.title })),
      people: people.map((p) => personAt(p, start, end)),
    };
  });
}

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const percentile = (sorted: number[], p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;

/**
 * Typical working hours from past busy blocks, in `zone`: the 10th percentile of each busy day's first start and the 90th of its
 * last end, rounded to 15 minutes. Null (use the defaults) with fewer than 8 busy days or a span outside 4 to 14 hours.
 */
export function inferHours(busy: { start: string; end: string }[], zone: string): [string, string] | null {
  const days = new Map<string, { first: number; last: number }>();
  for (const b of busy) {
    const [s, e] = [Date.parse(b.start), Date.parse(b.end)];
    if (!(e > s)) continue;
    const date = dateIn(s, zone);
    const local = (t: number) => minutes(renderInZone(new Date(t).toISOString(), zone).slice(11, 16));
    const [first, last] = [local(s), dateIn(e - 1, zone) === date ? local(e - 1) + 1 : 1440];
    const d = days.get(date);
    days.set(date, d ? { first: Math.min(d.first, first), last: Math.max(d.last, last) } : { first, last });
  }
  if (days.size < MIN_BUSY_DAYS) return null;
  const starts = [...days.values()].map((d) => d.first).sort((a, b) => a - b);
  const ends = [...days.values()].map((d) => d.last).sort((a, b) => a - b);
  const [open, close] = [Math.round(percentile(starts, 0.1) / 15) * 15, Math.round(percentile(ends, 0.9) / 15) * 15];
  return close - open >= 4 * 60 && close - open <= 14 * 60 ? [hhmm(open), hhmm(Math.min(close, 1440))] : null;
}

export interface LocationDay { date: string; kind: "home" | "office" | "custom"; label?: string }
/** Where the owner is, per day, from their own working-location entries, flights (the arrival day) and stays. */
export function locationsOf(events: GEvent[], zone: string): LocationDay[] {
  const out: LocationDay[] = [];
  const clean = (t?: string) => (t ? t.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) : undefined);
  for (const e of events) {
    if (!ownTravel(e) && e.organizer?.self !== true) continue;
    const label = clean(e.workingLocationProperties?.officeLocation?.label ?? e.workingLocationProperties?.customLocation?.label ?? e.summary);
    if (e.eventType === "workingLocation" && e.start?.date) {
      const t = e.workingLocationProperties?.type;
      out.push({ date: e.start.date, kind: t === "homeOffice" ? "home" : t === "officeLocation" ? "office" : "custom", ...(label ? { label } : {}) });
    } else if (isFlight(e)) {
      const s = span(e, zone);
      if (s) out.push({ date: dateIn(s[1], e.end?.timeZone && validZone(e.end.timeZone) ? e.end.timeZone : zone), kind: "custom", ...(clean(e.summary) ? { label: clean(e.summary) } : {}) });
    } else if (isStay(e) && e.eventType !== "workingLocation") {
      const s = span(e, zone);
      if (s) for (let d = dateIn(s[0], zone), last = dateIn(s[1] - 1, zone); d <= last; d = nextDate(d)) out.push({ date: d, kind: "custom", ...(clean(e.summary) ? { label: clean(e.summary) } : {}) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
