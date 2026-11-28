// calendar_find_times, and the safer calendar writes (a recheck before create/move, a stable id for retried creates, If-Match on moves).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { MultiWorkspace } from "../src/accounts.js";
import { findTimes, type FindTimesArgs } from "../src/find-times.js";
import { renderInZone } from "../src/zones.js";
import { SCOPES } from "../src/google.js";

// An account signed in before free/busy was asked for.
const OLD_SCOPES = SCOPES.filter((x) => !x.includes("freebusy"));
import { EventChanged, EventConflict, eventIdFor, type GEvent } from "../src/workspace.js";

const week = (w: [string, string][]) => ({ mon: w, tue: w, wed: w, thu: w, fri: w, sat: w, sun: w });
const base = (over: Partial<FindTimesArgs> = {}): FindTimesArgs => ({
  duration_min: 30,
  window_start: "2026-12-02T00:00:00+04:00",
  window_end: "2026-12-03T00:00:00+04:00",
  working_hours: week([["09:00", "17:00"]]),
  buffer_min: 0,
  min_notice_hours: 0,
  stretch_hours: 0,
  timezone: "Asia/Dubai",
  ...over,
});
const meeting = (id: string, start: string, end: string, extra: Partial<GEvent> = {}): GEvent => ({ id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra });
const NOW = Date.parse("2026-12-01T00:00:00Z");
const hm = (iso: string) => iso.slice(11, 16);
const overlap = (s: { start: string; end: string }, a: string, b: string) => Date.parse(s.start) < Date.parse(b) && Date.parse(s.end) > Date.parse(a);

describe("findTimes", () => {
  it("skips busy blocks with the buffer, minimum notice and max_per_day", () => {
    const events = [meeting("sync", "2026-12-02T10:00:00+04:00", "2026-12-02T11:00:00+04:00")];
    const slots = findTimes(base({ buffer_min: 15 }), events, [], NOW);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => overlap(s, "2026-12-02T09:45:00+04:00", "2026-12-02T11:15:00+04:00"))).toBe(false);
    // Earliest notice: now is 09:30 in Dubai and one hour is needed.
    const late = findTimes(base({ min_notice_hours: 1 }), [], [], Date.parse("2026-12-02T05:30:00Z"));
    expect(late.every((s) => hm(s.start) >= "10:30")).toBe(true);
    expect(findTimes(base({ max_per_day: 1 }), events, [], NOW)).toEqual([]);
    expect(findTimes(base({ max_per_day: 2 }), events, [], NOW).length).toBeGreaterThan(0);
    // Their busy time blocks too.
    const theirs = findTimes(base(), [], [{ start: "2026-12-02T09:00:00+04:00", end: "2026-12-02T16:30:00+04:00" }], NOW);
    expect(theirs.map((s) => hm(s.start))).toEqual(["16:30"]);
  });

  it("ignores declined, free and cancelled events, and travel reservations", () => {
    const events = [
      meeting("declined", "2026-12-02T09:00:00+04:00", "2026-12-02T17:00:00+04:00", { attendees: [{ self: true, responseStatus: "declined" }] }),
      meeting("free", "2026-12-02T09:00:00+04:00", "2026-12-02T17:00:00+04:00", { transparency: "transparent" }),
      meeting("gone", "2026-12-02T09:00:00+04:00", "2026-12-02T17:00:00+04:00", { status: "cancelled" }),
      meeting("Hotel Aria", "2026-12-02T09:00:00+04:00", "2026-12-02T17:00:00+04:00", { eventType: "fromGmail" }),
    ];
    expect(findTimes(base(), events, [], NOW)[0]!.start).toContain("T09:00");
  });

  it("with no buffer, notice or daily cap given there are none", () => {
    const { buffer_min: _b, min_notice_hours: _n, ...bare } = base();
    const events = [meeting("a", "2026-12-02T10:00:00+04:00", "2026-12-02T11:00:00+04:00"), meeting("b", "2026-12-02T11:00:00+04:00", "2026-12-02T12:00:00+04:00")];
    // Back-to-back with a meeting, right now-ish: nothing is padded, nothing is too soon, a third meeting is allowed.
    const slots = findTimes(bare as FindTimesArgs, events, [], Date.parse("2026-12-02T05:00:00Z"));
    expect(slots).toEqual(findTimes({ ...bare, buffer_min: 0, min_notice_hours: 0, max_per_day: 99 } as FindTimesArgs, events, [], Date.parse("2026-12-02T05:00:00Z")));
    expect(slots.some((x) => hm(x.start) === "12:00")).toBe(true);
    expect(slots.some((x) => hm(x.start) === "09:30")).toBe(true);
  });

  // The band a slot sits in for someone in `zone`: 0 core, 1 stretch, 2 outside, from the wall clock of its start.
  const bandOf = (iso: string, zone: string, core: [string, string], stretch: [string, string]) => {
    const l = renderInZone(Date.parse(iso) ? new Date(Date.parse(iso)).toISOString() : iso, zone).slice(11, 16);
    return l >= core[0] && l < core[1] ? 0 : l >= stretch[0] && l < stretch[1] ? 1 : 2;
  };

  it("an unset attendee in Dubai while the owner is in London: 06:00-09:00 their time ranks below core and above outside", () => {
    // London is 4 hours behind Dubai in December. Owner 00:00-10:00 London = 04:00-14:00 Dubai.
    const args = base({ timezone: "Europe/London", window_start: "2026-12-02T00:00:00+00:00", window_end: "2026-12-03T00:00:00+00:00", working_hours: week([["00:00", "10:00"]]), attendees: ["dana@example.com"], attendees_local: { "dana@example.com": { timezone: "Asia/Dubai" } } });
    const slots = findTimes(args, [], [], NOW);
    const bands = slots.map((x) => bandOf(x.start, "Asia/Dubai", ["09:00", "18:00"], ["06:00", "22:00"]));
    expect(bands).toEqual([...bands].sort());
    expect(new Set(bands)).toEqual(new Set([0, 1, 2]));
    // Unknown or invalid zones are ignored: the ranking is the owner's alone (earliest first here).
    const plain = findTimes({ ...args, attendees_local: undefined }, [], [], NOW);
    expect(findTimes({ ...args, attendees_local: { "dana@example.com": { timezone: "Not/AZone" } } }, [], [], NOW)).toEqual(plain);
    expect(plain[0]!.start).toContain("T00:00");
  });

  it("counts a person once however often they are listed", () => {
    const a = base({ timezone: "Europe/London", window_start: "2026-12-02T00:00:00+00:00", window_end: "2026-12-03T00:00:00+00:00", working_hours: week([["00:00", "10:00"]]), attendees_local: { "dana@example.com": { timezone: "Asia/Dubai" } } });
    expect(findTimes({ ...a, attendees: ["dana@example.com", "DANA@example.com"] }, [], [], NOW)).toEqual(findTimes({ ...a, attendees: ["dana@example.com"] }, [], [], NOW));
  });

  it("an attendee with hours 10-16 and stretch_hours 2 stretches over 08-10 and 16-18", () => {
    const args = base({ stretch_hours: 2, working_hours: week([["06:00", "20:00"]]), attendees: ["dana@example.com"], attendees_local: { "DANA@example.com": { timezone: "Asia/Dubai", hours: ["10:00", "16:00"] } } });
    const slots = findTimes({ ...args, stretch_hours: 2, working_hours: week([["08:00", "18:00"]]) }, [], [], NOW);
    const hours = (xs: typeof slots) => xs.map((x) => hm(x.start));
    const bands = slots.map((x) => bandOf(x.start, "Asia/Dubai", ["10:00", "16:00"], ["08:00", "18:00"]));
    // Owner 08-18 with a 2 h stretch also offers 06-08 and 18-20, which are outside for the attendee.
    expect(bands).toEqual([...bands].sort());
    expect(hours(slots.slice(0, 12))).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"]);
    expect(new Set(hours(slots.filter((_x, i) => bands[i] === 1)))).toEqual(new Set(["08:00", "08:30", "09:00", "09:30", "16:00", "16:30", "17:00", "17:30"]));
  });

  it("an owner slot outside the owner's stretch is never returned", () => {
    const wide = { window_start: "2026-12-02T00:00:00+04:00", window_end: "2026-12-03T00:00:00+04:00" };
    const stretched = findTimes(base({ ...wide, stretch_hours: 2 }), [], [], NOW);
    expect(stretched.every((x) => hm(x.start) >= "07:00" && hm(x.end) <= "19:00")).toBe(true);
    expect(stretched.some((x) => hm(x.start) === "07:00")).toBe(true);
    // 07-09 ranks after the owner's core.
    expect(hm(stretched[0]!.start)).toBe("09:00");
    expect(stretched.findIndex((x) => hm(x.start) === "07:00")).toBeGreaterThan(stretched.findIndex((x) => hm(x.start) === "16:30"));
    const exact = findTimes(base({ ...wide }), [], [], NOW);
    expect(exact.every((x) => hm(x.start) >= "09:00" && hm(x.end) <= "17:00")).toBe(true);
  });

  it("needs a window with explicit offsets, not longer than 62 days", () => {
    expect(() => findTimes(base({ window_start: "2026-12-02T00:00:00" }), [], [], NOW)).toThrow(/offset/);
    expect(() => findTimes(base({ window_end: "2027-06-03T00:00:00+04:00" }), [], [], NOW)).toThrow(/62 days/);
  });

  it("an accepted meeting titled like a hotel still blocks; an all-day hold starts at midnight in the calendar's zone", () => {
    const hotel = meeting("Hotel contract review", "2026-12-02T09:00:00+04:00", "2026-12-02T17:00:00+04:00");
    expect(findTimes(base(), [hotel], [], NOW)).toEqual([]);
    const hold: GEvent = { id: "h", summary: "Offsite", start: { date: "2026-12-03" }, end: { date: "2026-12-04" } };
    // Dubai's 3 December opens at 20:00Z on the 2nd: 01:00 Dubai belongs to the hold, 23:00 on the 2nd does not.
    const slots = findTimes(base({ window_start: "2026-12-02T00:00:00+04:00", window_end: "2026-12-04T00:00:00+04:00", working_hours: week([["00:00", "24:00"]]) }), [hold], [], NOW, "Asia/Dubai");
    expect(slots.every((s) => Date.parse(s.end) <= Date.parse("2026-12-03T00:00:00+04:00"))).toBe(true);
  });

  it("keeps local wall time over a DST boundary", () => {
    // New York falls back on Sunday 2026-11-01: 09:00 is -04:00 before and -05:00 after.
    const args = base({ duration_min: 60, timezone: "America/New_York", window_start: "2026-10-30T00:00:00-04:00", window_end: "2026-11-03T00:00:00-05:00", working_hours: week([["09:00", "10:00"]]) });
    const slots = findTimes(args, [], [], Date.parse("2026-10-01T00:00:00Z"));
    expect(slots.map((s) => s.start)).toEqual(["2026-10-30T09:00:00-04:00", "2026-10-31T09:00:00-04:00", "2026-11-01T09:00:00-05:00", "2026-11-02T09:00:00-05:00"]);
  });

  it("an own working-location entry in another zone shifts that day's hours; someone else's does not", () => {
    const where = (id: string, extra: Partial<GEvent>): GEvent => ({ id, summary: "London", eventType: "workingLocation", start: { date: "2026-12-02", timeZone: "Europe/London" }, end: { date: "2026-12-03", timeZone: "Europe/London" }, ...extra });
    const own = findTimes(base({ working_hours: week([["09:00", "09:30"]]) }), [where("w", { organizer: { self: true } })], [], NOW);
    expect(own).toEqual([{ start: "2026-12-02T09:00:00+00:00", end: "2026-12-02T09:30:00+00:00", tier: "best", timezone: "Europe/London" }]);
    const theirs = findTimes(base({ working_hours: week([["09:00", "09:30"]]) }), [where("w", { organizer: { self: false } })], [], NOW);
    expect(theirs[0]).toMatchObject({ start: "2026-12-02T09:00:00+04:00", timezone: "Asia/Dubai" });
    // A flight the owner organised lands in Lisbon: from then on Lisbon's clock.
    const flight = meeting("Flight to Lisbon", "2026-12-01T20:00:00+04:00", "2026-12-02T03:00:00+04:00", { organizer: { self: true }, end: { dateTime: "2026-12-02T03:00:00+04:00", timeZone: "Europe/Lisbon" } });
    expect(findTimes(base({ working_hours: week([["09:00", "09:30"]]) }), [flight], [], NOW)[0]).toMatchObject({ timezone: "Europe/Lisbon", start: "2026-12-02T09:00:00+00:00" });
  });

  it("ranks best over ok over last resort, then back-to-back, then earliest", () => {
    const calls = { best: [["14:00", "16:00"]], ok: [["10:00", "12:00"]] } as FindTimesArgs["call_windows"];
    const slots = findTimes(base({ call_windows: calls }), [meeting("m", "2026-12-02T14:45:00+04:00", "2026-12-02T15:15:00+04:00")], [], NOW);
    expect(slots.map((s) => s.tier)).toEqual([...slots.map((s) => s.tier)].sort((a, b) => ["best", "ok", "last_resort"].indexOf(a) - ["best", "ok", "last_resort"].indexOf(b)));
    expect(slots[0]).toMatchObject({ tier: "best" });
    // 14:15 ends where the meeting starts: back-to-back beats the earlier 14:00.
    expect(hm(slots[0]!.start)).toBe("14:15");
    expect(hm(slots[1]!.start)).toBe("15:15");
    expect(slots.find((s) => s.tier === "ok")).toBeDefined();
    expect(slots.at(-1)!.tier).toBe("last_resort");
    // With no meeting nearby, earliest wins.
    expect(hm(findTimes(base({ call_windows: calls }), [], [], NOW)[0]!.start)).toBe("14:00");
  });
});

// ---------------------------------------------------------------- through the Google client

const EV = "/calendar/v3/calendars/primary/events";
function creds(scopes: string[]) {
  const p = join(mkdtempSync(join(tmpdir(), "gft-")), "creds.json");
  writeFileSync(p, JSON.stringify({ client_id: "cid", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "r1", scopes } } }));
  return p;
}
type Call = { method: string; url: URL; body?: Record<string, unknown>; ifMatch?: string };
/** Google answering `routes` ("METHOD path": a body, null for 204, a Response for any status, or a function); the others 404. */
function google(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "at", expires_in: 3600 });
    const method = init?.method ?? "GET";
    const ifMatch = (init?.headers as Record<string, string> | undefined)?.["if-match"];
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}), ...(ifMatch ? { ifMatch } : {}) });
    const r = routes[`${method} ${url.pathname}`];
    if (r === undefined) return new Response("no route", { status: 404 });
    const v = typeof r === "function" ? (r as () => unknown)() : r;
    return v instanceof Response ? v : v === null ? new Response(null, { status: 204 }) : Response.json(v);
  }) as typeof fetch;
  return { impl, calls };
}

const args = (over: Partial<FindTimesArgs> = {}) => base({ window_start: "2026-12-09T00:00:00+04:00", window_end: "2026-12-10T00:00:00+04:00", working_hours: week([["09:00", "10:00"]]), ...over });

describe("calendar_find_times attendees", () => {
  it("without the free/busy scope it answers from the owner's calendar and says not_granted", async () => {
    const g = google({ [`GET ${EV}`]: { items: [] } });
    const r = await new MultiWorkspace(creds(OLD_SCOPES), "primary", g.impl).findTimes(args({ attendees: ["dana@example.com"] }), NOW);
    expect(r.attendee_freebusy).toBe("not_granted");
    expect(r.attendees).toEqual([{ email: "dana@example.com", freebusy: "not_granted", timezone_known: false }]);
    expect(r.slots.length).toBeGreaterThan(0);
    expect(g.calls.some((c) => c.url.pathname.endsWith("/freeBusy"))).toBe(false);
  });

  it("with it, their busy time shapes the slots; a calendar Google hides is not_visible", async () => {
    const free = google({ [`GET ${EV}`]: { items: [] }, "POST /calendar/v3/freeBusy": { calendars: { "dana@example.com": { busy: [{ start: "2026-12-09T05:00:00Z", end: "2026-12-09T05:30:00Z" }] } } } });
    const ws = new MultiWorkspace(creds(SCOPES), "primary", free.impl);
    const used = await ws.findTimes(args({ attendees: ["dana@example.com"], duration_min: 30 }), NOW);
    expect(used.attendee_freebusy).toBe("used");
    expect(used.slots.map((s) => hm(s.start))).toEqual(["09:30"]);
    const hidden = google({ [`GET ${EV}`]: { items: [] }, "POST /calendar/v3/freeBusy": { calendars: { "eve@example.com": { errors: [{ reason: "notFound" }] } } } });
    expect((await new MultiWorkspace(creds(SCOPES), "primary", hidden.impl).findTimes(args({ attendees: ["eve@example.com"] }), NOW)).attendee_freebusy).toBe("not_visible");
  });
});

describe("people we cannot see never block the answer", () => {
  const FB = "POST /calendar/v3/freeBusy";
  const at = (over = {}) => args({ duration_min: 30, working_hours: week([["09:00", "10:00"]]), ...over });

  it("a colleague's busy time counts and an external calendar (notFound) is skipped", async () => {
    const g = google({ [`GET ${EV}`]: { items: [] }, [FB]: { calendars: { "col@work.com": { busy: [{ start: "2026-12-09T05:00:00Z", end: "2026-12-09T05:30:00Z" }] }, "ext@other.org": { errors: [{ domain: "global", reason: "notFound" }] } } } });
    const r = await new MultiWorkspace(creds(SCOPES), "primary", g.impl).findTimes(at({ attendees: ["col@work.com", "ext@other.org"], attendees_local: { "col@work.com": { timezone: "Asia/Dubai" } } }), NOW);
    expect(r.slots.map((x) => hm(x.start))).toEqual(["09:30"]);
    expect(r.attendees).toEqual([{ email: "col@work.com", freebusy: "used", timezone_known: true }, { email: "ext@other.org", freebusy: "not_visible", timezone_known: false }]);
    expect(r.attendee_freebusy).toBe("not_visible");
  });

  it("a free/busy request that fails outright still returns slots, every attendee not_visible", async () => {
    const g = google({ [`GET ${EV}`]: { items: [] }, [FB]: new Response("boom", { status: 500 }) });
    const r = await new MultiWorkspace(creds(SCOPES), "primary", g.impl).findTimes(at({ attendees: ["a@x.org", "b@y.org"] }), NOW);
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.attendees.map((x) => x.freebusy)).toEqual(["not_visible", "not_visible"]);
    // A 403 on the call is the same: skipped, not the owner's sign-in failing.
    const g2 = google({ [`GET ${EV}`]: { items: [] }, [FB]: new Response("forbidden", { status: 403 }) });
    expect((await new MultiWorkspace(creds(SCOPES), "primary", g2.impl).findTimes(at({ attendees: ["a@x.org"] }), NOW)).attendee_freebusy).toBe("not_visible");
  });
});

describe("safer calendar writes", () => {
  const input = { title: "Plan", start: "2026-12-09T09:00:00+04:00", end: "2026-12-09T09:30:00+04:00", request_key: "task-1:slot-1" };
  const id = eventIdFor("primary", input.request_key);
  const made = { id, etag: '"e1"', summary: "Plan", start: { dateTime: input.start }, end: { dateTime: input.end } };

  it("a create retried with the same key makes one event", async () => {
    const routes: Record<string, unknown> = { [`GET ${EV}`]: { items: [] }, [`POST ${EV}`]: () => ((routes[`GET ${EV}/${id}`] = made), made) };
    const g = google(routes);
    const ws = new MultiWorkspace(creds(SCOPES), "primary", g.impl);
    const first = await ws.createEvent(input, "none");
    const second = await ws.createEvent(input, "none");
    expect(first.id).toBe(id);
    expect(second.id).toBe(id);
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(g.calls.find((c) => c.method === "POST")!.body!.id).toBe(id);
    expect(/^[0-9a-v]{5,}$/.test(id)).toBe(true);
    // A concurrent retry that loses the race (Google answers 409) gets the event the winner made.
    const racing = google({ [`GET ${EV}`]: { items: [] }, [`POST ${EV}`]: new Response("exists", { status: 409 }), [`GET ${EV}/${id}`]: made });
    racing.calls.length = 0;
    expect((await new MultiWorkspace(creds(SCOPES), "primary", racing.impl).createEvent(input, "none")).id).toBe(id);
  });

  it("a time taken since the owner chose it is refused, not booked over, unless allowed", async () => {
    const taken = { id: "other", summary: "Board prep", start: { dateTime: "2026-12-09T09:15:00+04:00" }, end: { dateTime: "2026-12-09T10:00:00+04:00" } };
    const g = google({ [`GET ${EV}`]: { items: [taken] }, [`POST ${EV}`]: made });
    const ws = new MultiWorkspace(creds(SCOPES), "primary", g.impl);
    const err = await ws.createEvent(input, "none").catch((e) => e);
    expect(err).toBeInstanceOf(EventConflict);
    expect(String(err.message)).toContain("Board prep");
    expect(g.calls.some((c) => c.method === "POST")).toBe(false);
    expect((await ws.createEvent({ ...input, allow_conflict: true }, "none")).id).toBe(id);
    // A move checks the new time too, leaving the moved event itself out.
    const ev = { id: "ev1", etag: '"e1"', summary: "Sync", start: { dateTime: "2026-12-09T08:00:00+04:00" }, end: { dateTime: "2026-12-09T08:30:00+04:00" } };
    const mv = google({ [`GET ${EV}`]: { items: [taken, ev] }, [`GET ${EV}/ev1`]: ev, [`PATCH ${EV}/ev1`]: ev });
    const mws = new MultiWorkspace(creds(SCOPES), "primary", mv.impl);
    expect(await mws.updateEvent("ev1", { start: "2026-12-09T09:30:00+04:00", end: "2026-12-09T10:00:00+04:00" }, "none").catch((e) => e)).toBeInstanceOf(EventConflict);
    await mws.updateEvent("ev1", { start: "2026-12-09T08:00:00+04:00", end: "2026-12-09T08:30:00+04:00" }, "none");
    expect(mv.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("a move checks the whole interval and spares only its own occurrence, not its siblings", async () => {
    const mine = { id: "daily_20261209", recurringEventId: "daily", etag: '"e1"', summary: "Daily", start: { dateTime: "2026-12-09T08:00:00+04:00" }, end: { dateTime: "2026-12-09T08:30:00+04:00" } };
    const sibling = { id: "daily_20261210", recurringEventId: "daily", summary: "Daily", start: { dateTime: "2026-12-10T08:00:00+04:00" }, end: { dateTime: "2026-12-10T08:30:00+04:00" } };
    const next = { id: "n", summary: "Next", start: { dateTime: "2026-12-09T08:30:00+04:00" }, end: { dateTime: "2026-12-09T09:00:00+04:00" } };
    const g = google({ [`GET ${EV}`]: { items: [mine, sibling, next] }, [`GET ${EV}/daily_20261209`]: mine, [`PATCH ${EV}/daily_20261209`]: mine });
    const ws = new MultiWorkspace(creds(SCOPES), "primary", g.impl);
    // Only `end` changes: it runs into the next meeting.
    expect(await ws.updateEvent("daily_20261209", { end: "2026-12-09T08:45:00+04:00" }, "none").catch((e) => e)).toBeInstanceOf(EventConflict);
    // Onto the sibling occurrence: refused.
    expect(await ws.updateEvent("daily_20261209", { start: "2026-12-10T08:00:00+04:00", end: "2026-12-10T08:30:00+04:00" }, "none").catch((e) => e)).toBeInstanceOf(EventConflict);
  });

  it("a key whose booking was cancelled does not answer success", async () => {
    const dead = { id, status: "cancelled", summary: "Plan", start: { dateTime: input.start }, end: { dateTime: input.end } };
    const g = google({ [`GET ${EV}`]: { items: [] }, [`GET ${EV}/${id}`]: dead, [`POST ${EV}`]: new Response("exists", { status: 409 }) });
    await expect(new MultiWorkspace(creds(SCOPES), "primary", g.impl).createEvent(input, "none")).rejects.toThrow(/cancelled/);
  });

  it("a move whose etag changed is refused, and every move is If-Match", async () => {
    const ev = { id: "ev1", etag: '"e2"', summary: "Sync", start: { dateTime: "2026-12-09T08:00:00+04:00" }, end: { dateTime: "2026-12-09T08:30:00+04:00" } };
    const g = google({ [`GET ${EV}`]: { items: [] }, [`GET ${EV}/ev1`]: ev, [`PATCH ${EV}/ev1`]: ev });
    const ws = new MultiWorkspace(creds(SCOPES), "primary", g.impl);
    const move = { start: "2026-12-09T11:00:00+04:00", end: "2026-12-09T11:30:00+04:00" };
    expect(await ws.updateEvent("ev1", { ...move, etag: '"e1"' }, "none").catch((e) => e)).toBeInstanceOf(EventChanged);
    expect(g.calls.some((c) => c.method === "PATCH")).toBe(false);
    await ws.updateEvent("ev1", { ...move, etag: '"e2"' }, "none");
    expect(g.calls.find((c) => c.method === "PATCH")!.ifMatch).toBe('"e2"');
    // Google's own 412 (changed between our read and the write) is the same refusal.
    const raced = google({ [`GET ${EV}`]: { items: [] }, [`GET ${EV}/ev1`]: ev, [`PATCH ${EV}/ev1`]: new Response("precondition", { status: 412 }) });
    expect(await new MultiWorkspace(creds(SCOPES), "primary", raced.impl).updateEvent("ev1", move, "none").catch((e) => e)).toBeInstanceOf(EventChanged);
  });
});
