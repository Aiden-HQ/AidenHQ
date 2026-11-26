// calendar_today: the owner's day on the primary calendar, for the board's Home (board.reads). Today is the owner's
// (OWNER_TIMEZONE, the instance `timezone` setting), never the server's.
import { renderInZone, type NormalizedEvent } from "./workspace.js";

export type TodayEvent = { id: string; start: string; end: string; title: string; all_day: boolean };

const offsetMs = (at: number, zone: string) => {
  const m = renderInZone(new Date(at).toISOString(), zone).match(/([+-])(\d\d):(\d\d)$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};
/** The instant local midnight starts on `date` (YYYY-MM-DD) in `zone`. */
const midnight = (date: string, zone: string) => {
  const wall = Date.parse(`${date}T00:00:00Z`);
  return wall - offsetMs(wall - offsetMs(wall, zone), zone);
};
const addDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Today's events in `zone`, start order; declined and cancelled ones left out. An all-day event counts on its own dates. */
export async function calendarToday(ws: { listEvents(start: string, end: string, query?: string, max?: number, account?: string): Promise<NormalizedEvent[]> }, zone: string, now = Date.now()): Promise<{ timezone: string; events: TodayEvent[] }> {
  const today = renderInZone(new Date(now).toISOString(), zone).slice(0, 10);
  const [from, to] = [midnight(today, zone), midnight(addDay(today), zone)];
  const events = await ws.listEvents(new Date(from).toISOString(), new Date(to).toISOString(), undefined, 50, undefined);
  return {
    timezone: zone,
    events: events
      .filter((e) => e.status !== "cancelled" && !e.attendees.some((a) => a.self && a.response_status === "declined"))
      .filter((e) => (e.all_day ? e.start.slice(0, 10) <= today && today < e.end.slice(0, 10) : Date.parse(e.end) > from && Date.parse(e.start) < to))
      .map((e) => ({ id: e.id, start: e.start, end: e.end, title: e.title, all_day: e.all_day })),
  };
}
