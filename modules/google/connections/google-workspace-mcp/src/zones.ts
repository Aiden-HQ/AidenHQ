// Time-zone arithmetic on Intl alone (no date library): wall clock, UTC offset and instants in an IANA zone.

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall clock and UTC offset in `zone` at once; throws on a zone name the runtime doesn't know. */
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    zoneFormatters.set(zone, f);
  }
  return f;
}

/** `zone` if the runtime knows it, else UTC, so the label and the offset still agree. */
export function zoneOrUtc(zone: string | undefined): string {
  try {
    zoneFormatter(zone ?? "UTC");
    return zone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * `iso` rendered in `zone` with the offset `zone` is on at that instant, e.g.
 * "2026-11-16T18:30:00+04:00". Google returns an event's `dateTime` in the calendar's default zone,
 * not the event's, so the offset has to be recomputed for the zone we label the event with.
 * The instant is kept; an unknown or missing zone falls back to UTC.
 */
export function renderInZone(iso: string, zone: string | undefined): string {
  const epochMs = Date.parse(iso);
  if (Number.isNaN(epochMs)) return iso;
  const parts = Object.fromEntries(zoneFormatter(zoneOrUtc(zone)).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  // UTC comes out as plain "GMT"; every other zone carries its offset.
  const offset = (parts.timeZoneName ?? "").replace("GMT", "") || "+00:00";
  const millis = epochMs % 1000;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${millis ? `.${String(millis).padStart(3, "0")}` : ""}${offset}`;
}


/** Whether the runtime knows `zone`. */
export const validZone = (zone: string | undefined): zone is string => {
  if (!zone) return false;
  try {
    zoneFormatter(zone);
    return true;
  } catch {
    return false;
  }
};

/** `zone`'s UTC offset in ms at the instant `at`. */
export function offsetMs(at: number, zone: string): number {
  const m = renderInZone(new Date(at).toISOString(), zone).match(/([+-])(\d\d):(\d\d)$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/**
 * The instant at which `zone`'s wall clock reads `date` (YYYY-MM-DD) plus `minutes`. A repeated hour (clocks going back) takes
 * its first occurrence; a skipped hour (clocks going forward) has no instant: undefined.
 */
export function wallOn(date: string, minutes: number, zone: string): number | undefined {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const valid = new Set<number>();
  for (const o of new Set([offsetMs(wall - 86_400_000, zone), offsetMs(wall + 86_400_000, zone)])) {
    const t = wall - o;
    if (offsetMs(t, zone) === o) valid.add(t);
  }
  return valid.size ? Math.min(...valid) : undefined;
}

/** The instant of a zone-less date-time ("2026-11-24T15:00" or with seconds) read on `zone`'s wall clock. */
export function wallInstant(dateTime: string, zone: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/.exec(dateTime);
  const t = m ? wallOn(m[1]!, Number(m[2]) * 60 + Number(m[3]), zone) : undefined;
  if (t === undefined) throw new Error(`${dateTime} is not a time that exists on ${zone}'s clock`);
  return t + Number(m![4] ?? 0) * 1000 + Math.round(Number(m![5] ?? 0) * 1000);
}

/** The calendar date (YYYY-MM-DD) at the instant `at` in `zone`. */
export const dateIn = (at: number, zone: string) => renderInZone(new Date(at).toISOString(), zone).slice(0, 10);

/** The next calendar date after `date`. */
export const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
