// Owner-local time: what the model sees and writes. The model never handles UTC.

/** The owner's `time_format` (OWNER_TIME_FORMAT, the instance setting): "9:05 PM" by default, "21:05" for 24h. */
function clock(tz: string, at: number): string {
  const d = new Date(at);
  if (process.env.OWNER_TIME_FORMAT === "24h") return d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).replace(/\u202f/g, " ");
}

/** "Friday 14 November 2026, 9:05 PM (Indian/Mauritius)" */
export function localNow(tz: string, now = Date.now()): string {
  const date = new Date(now).toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "");
  return `${date}, ${clock(tz, now)} (${tz})`;
}

/** "Sat 15 Nov 5:00 PM" in the owner's timezone: prose, in the owner's time_format. */
export function localShort(tz: string, at: number): string {
  const date = new Date(at).toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  return `${date} ${clock(tz, at)}`;
}

/** "Sat 15 Nov 17:00" in the owner's timezone: a structured value (a tool's `due_local`), always 24-hour. */
export function localStamp(tz: string, at: number): string {
  return new Date(at).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
}

/** The UTC offset (ms) of `tz` at instant `at`. */
function offsetMs(tz: string, at: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/**
 * When a wake is due, from what the model wrote: "in 20 minutes" / "in 2 hours" / "in 1 day", or an owner-local
 * "YYYY-MM-DD HH:MM" (a "T" works too). undefined if it can't be read.
 */
export function parseWhen(s: string, tz: string, now = Date.now()): number | undefined {
  const rel = /^\s*in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s*$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase()[0];
    return now + n * (unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 864e5);
  }
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes settle the offset across a DST change.
  let at = wall - offsetMs(tz, wall);
  at = wall - offsetMs(tz, at);
  return Number.isFinite(at) ? at : undefined;
}
