// calendar_find_times, and the safer calendar writes (a recheck before create/move, a stable id for retried creates, If-Match on moves).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { MultiWorkspace } from "../src/accounts.js";
import { findTimes, type FindTimesArgs } from "../src/find-times.js";
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

  it("ranks slots inside every known attendee zone's hours first, never excluding the rest", () => {
    // New York is 9 hours behind Dubai in December: 09:00-18:00 there is 18:00-03:00 Dubai.
    const wide = base({ working_hours: week([["09:00", "21:00"]]), attendees: ["dana@example.com"], attendee_timezones: { "dana@example.com": "America/New_York" } });
    const slots = findTimes(wide, [], [], NOW);
    expect(hm(slots[0]!.start)).toBe("18:00");
    expect(slots.some((x) => hm(x.start) === "09:00")).toBe(true);
    const inHours = (iso: string) => hm(iso) >= "18:00";
    const flags = slots.map((x) => inHours(x.start));
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    // A zone for someone not in the meeting does not count.
    expect(findTimes({ ...wide, attendees: ["other@example.com"] }, [], [], NOW)[0]!.start).toContain("T09:00");
    expect(findTimes({ ...wide, attendees: ["DANA@example.com"] }, [], [], NOW)[0]!.start).toContain("T18:00");
    // Two zones: only slots inside both rank first (Dubai and New York share no common 9-18 hours, so none is).
    const both = findTimes(base({ working_hours: week([["09:00", "21:00"]]), attendees: ["a", "b"], attendee_timezones: { a: "America/New_York", b: "Asia/Dubai" }, attendee_hours: ["09:00", "18:00"] }), [], [], NOW);
    expect(hm(both[0]!.start)).toBe("09:00");
  });

  it("a missing or invalid attendee zone changes nothing: the ranking is the owner's alone", () => {
    const calls = { best: [["14:00", "16:00"]] } as FindTimesArgs["call_windows"];
    const plain = findTimes(base({ call_windows: calls }), [], [], NOW);
    expect(findTimes(base({ call_windows: calls, attendee_timezones: {} }), [], [], NOW)).toEqual(plain);
    expect(findTimes(base({ call_windows: calls, attendees: ["x@example.com", "y@example.com"], attendee_timezones: { "x@example.com": "Not/AZone", "y@example.com": "" } }), [], [], NOW)).toEqual(plain);
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
    const r = await new MultiWorkspace(creds(SCOPES), "primary", g.impl).findTimes(at({ attendees: ["col@work.com", "ext@other.org"], attendee_timezones: { "col@work.com": "Asia/Dubai" } }), NOW);
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
