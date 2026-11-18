import { describe, expect, it } from "vitest";
import type { GoogleClient } from "../src/google.js";
import { docIdFrom, docsBodyToMarkdown, normalizeEvent, Workspace } from "../src/workspace.js";

describe("google-workspace-mcp", () => {
  it("normalizes a recurring event occurrence for ops-mcp", () => {
    const e = normalizeEvent({
      id: "abc_20261004T120000Z",
      recurringEventId: "abc",
      summary: "OMS <> Nimbus Integration",
      start: { dateTime: "2026-10-04T14:00:00+02:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-10-04T14:30:00+02:00", timeZone: "Europe/Madrid" },
      attendees: [
        { email: "alice@x.com", displayName: "Alice" },
        { email: "room@resource.calendar.google.com", resource: true },
        { email: "me@x.com", self: true, responseStatus: "accepted" },
      ],
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      attachments: [{ fileId: "f1", title: "Transcript", fileUrl: "https://docs.google.com/document/d/f1" }],
    });
    expect(e).toMatchObject({
      id: "abc_20261004T120000Z",
      series_id: "abc",
      all_day: false,
      meet_link: "https://meet.google.com/abc-defg-hij",
      attachments: [{ file_id: "f1", title: "Transcript", url: "https://docs.google.com/document/d/f1" }],
    });
    expect(e.attendees).toHaveLength(2);
  });

  // Google returns `dateTime` in the calendar's default zone (here Asia/Kolkata, +05:30) while
  // `timeZone` carries the event's own zone; the offset we emit must follow the zone we label.
  const fixture = (id: string, zone: string | undefined, start: string, end: string) => ({
    id,
    recurringEventId: "series1",
    summary: "Fixture meeting",
    start: { dateTime: start, ...(zone ? { timeZone: zone } : {}) },
    end: { dateTime: end, ...(zone ? { timeZone: zone } : {}) },
  });

  it.each([
    ["America/Los_Angeles", "2026-11-16T23:30:00+05:30", "2026-11-17T00:30:00+05:30", "2026-11-16T10:00:00-08:00", "2026-11-16T11:00:00-08:00"],
    ["Europe/London", "2026-11-16T19:30:00+05:30", "2026-11-16T20:00:00+05:30", "2026-11-16T14:00:00+00:00", "2026-11-16T14:30:00+00:00"],
    ["Indian/Mauritius", "2026-11-16T18:30:00+05:30", "2026-11-16T19:30:00+05:30", "2026-11-16T17:00:00+04:00", "2026-11-16T18:00:00+04:00"],
    ["Asia/Kolkata", "2026-11-16T09:00:00+05:30", "2026-11-16T09:30:00+05:30", "2026-11-16T09:00:00+05:30", "2026-11-16T09:30:00+05:30"],
  ])("renders a %s event in its own zone with a matching offset, keeping the instant", (zone, apiStart, apiEnd, start, end) => {
    const e = normalizeEvent(fixture("abc_20261116T093000Z", zone, apiStart, apiEnd));
    expect(e.timezone).toBe(zone);
    expect(e.start).toBe(start);
    expect(e.end).toBe(end);
    expect(Date.parse(e.start)).toBe(Date.parse(apiStart));
    expect(Date.parse(e.end)).toBe(Date.parse(apiEnd));
  });

  it("keeps the offset in step with the zone across a DST change", () => {
    const summer = normalizeEvent(fixture("summer", "Europe/London", "2026-07-01T15:00:00+05:30", "2026-07-01T15:30:00+05:30"));
    const winter = normalizeEvent(fixture("winter", "Europe/London", "2026-12-01T15:00:00+05:30", "2026-12-01T15:30:00+05:30"));
    expect(summer.start).toBe("2026-07-01T10:30:00+01:00");
    expect(winter.start).toBe("2026-12-01T09:30:00+00:00");
  });

  it("renders start and end in the start's zone, keeping the instant even if end's zone differs", () => {
    const e = normalizeEvent({
      id: "mixed",
      start: { dateTime: "2026-11-16T18:30:00+05:30", timeZone: "Indian/Mauritius" },
      end: { dateTime: "2026-11-16T15:00:00Z", timeZone: "Europe/London" },
    });
    expect(e.timezone).toBe("Indian/Mauritius");
    expect(e.start).toBe("2026-11-16T17:00:00+04:00");
    expect(e.end).toBe("2026-11-16T19:00:00+04:00");
    expect(Date.parse(e.end)).toBe(Date.parse("2026-11-16T15:00:00Z"));
  });

  it("labels an event with no zone UTC and still keeps the instant", () => {
    const e = normalizeEvent(fixture("zoneless", undefined, "2026-11-16T18:30:00+05:30", "2026-11-16T19:30:00+05:30"));
    expect(e.timezone).toBe("UTC");
    expect(e.start).toBe("2026-11-16T13:00:00+00:00");
    expect(Date.parse(e.start)).toBe(Date.parse("2026-11-16T18:30:00+05:30"));
  });

  it("keeps an all-day event's date unshifted and still flags it all_day", () => {
    const e = normalizeEvent({ id: "holiday", summary: "Holiday", start: { date: "2026-11-16" }, end: { date: "2026-11-17" } });
    expect(e.all_day).toBe(true);
    expect(e.start).toBe("2026-11-16T00:00:00Z");
    expect(e.end).toBe("2026-11-17T00:00:00Z");
  });

  it("parses doc URLs with tabs and renders Docs bodies as markdown", () => {
    expect(docIdFrom("https://docs.google.com/document/d/1XoSua5F_x-Y/edit?tab=t.0")).toEqual({ id: "1XoSua5F_x-Y", tab: "t.0" });
    expect(docIdFrom("1XoSua5F")).toEqual({ id: "1XoSua5F", tab: undefined });
    const md = docsBodyToMarkdown([
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_2" }, elements: [{ textRun: { content: "Agenda 2026-10-05\n" } }] } },
      { paragraph: { bullet: { nestingLevel: 0 }, elements: [{ textRun: { content: "Mainnet checks\n" } }] } },
      { paragraph: { bullet: { nestingLevel: 1 }, elements: [{ textRun: { content: "Carlos\n" } }] } },
      { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "Owner\n" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "Item\n" } }] } }] }] }] } },
    ]);
    expect(md).toBe("## Agenda 2026-10-05\n- Mainnet checks\n  - Carlos\n| Owner | Item |");
  });

  it("lists, searches and fetches events through the same formatter", async () => {
    // What the Calendar API returns: dateTime in the calendar's zone (+05:30), timeZone the event's.
    const apiEvents = [
      { id: "la_20261116T180000Z", recurringEventId: "la", summary: "LA sync", start: { dateTime: "2026-11-16T23:30:00+05:30", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-11-17T00:30:00+05:30", timeZone: "America/Los_Angeles" } },
      { id: "mauritius_1", summary: "Mauritius review", start: { dateTime: "2026-11-16T18:30:00+05:30", timeZone: "Indian/Mauritius" }, end: { dateTime: "2026-11-16T19:30:00+05:30", timeZone: "Indian/Mauritius" } },
    ];
    const client = {
      async get(url: string) {
        if (url.includes("/events/")) return apiEvents[0];
        return { items: apiEvents };
      },
    } as unknown as GoogleClient;
    const ws = new Workspace(client, "primary");

    const listed = await ws.listEvents("2026-11-16T00:00:00Z", "2026-11-17T00:00:00Z");
    expect(listed.map((e) => [e.id, e.start, e.timezone])).toEqual([
      ["la_20261116T180000Z", "2026-11-16T10:00:00-08:00", "America/Los_Angeles"],
      ["mauritius_1", "2026-11-16T17:00:00+04:00", "Indian/Mauritius"],
    ]);
    const searched = await ws.listEvents("2026-11-16T00:00:00Z", "2026-11-17T00:00:00Z", "sync");
    expect(searched[0]).toMatchObject({ start: "2026-11-16T10:00:00-08:00", timezone: "America/Los_Angeles" });
    const one = await ws.getEvent("la_20261116T180000Z");
    expect(one).toMatchObject({ id: "la_20261116T180000Z", series_id: "la", start: "2026-11-16T10:00:00-08:00", timezone: "America/Los_Angeles" });
    expect(Date.parse(one.start)).toBe(Date.parse("2026-11-16T18:00:00Z"));
  });

});
