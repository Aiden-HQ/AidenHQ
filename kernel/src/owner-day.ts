// "Today" is the owner's day: a day bucket resets at midnight in the owner's `timezone` setting (IANA), not at 00:00 UTC.
// Stored times stay UTC instants; only the day a time falls in is read in the owner's zone. A day is a `YYYY-MM-DD` string:
// compare and step days as strings (addDays), and use dayStart only where SQL or an API needs the instant a day began.
// An unknown zone reads as UTC.

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (tz: string) => {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f;
};

/** The zone to read days in: `tz` when it is a real IANA zone, else UTC. */
export const zone = (tz: unknown): string => { try { return format(String(tz || "UTC")).resolvedOptions().timeZone; } catch { return "UTC"; } };
/** The owner's calendar day (`YYYY-MM-DD`) at instant `ms`. */
export const ownerDay = (ms: number, tz: unknown): string => format(zone(tz)).format(ms);
/** The owner's calendar month (`YYYY-MM`) at instant `ms`. */
export const ownerMonth = (ms: number, tz: unknown): string => ownerDay(ms, tz).slice(0, 7);
/** The day `n` calendar days after `day` (before, if negative). */
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** The instant (epoch ms) the owner's `day` began: its first moment, so a 23-hour or 25-hour day is whole. */
export function dayStart(day: string, tz: unknown): number {
  const z = zone(tz), mid = Date.parse(`${day}T00:00:00Z`);
  let lo = mid - 15 * 36e5, hi = mid + 15 * 36e5; // every zone's offset is within +-14h: the day begins in (lo, hi]
  while (hi - lo > 6e4) { const m = lo + Math.floor((hi - lo) / 2 / 6e4) * 6e4; if (format(z).format(m) >= day) hi = m; else lo = m; }
  return hi;
}
