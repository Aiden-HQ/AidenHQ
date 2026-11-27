// calendar_today (the board's Home read): today in the owner's zone, called by the kernel's view route as the owner.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyCaller } from "../src/aidenhq-sdk/caller.js";
import { FixtureWorkspace } from "../src/fixtures.js";
import { calendarToday, eventUrl } from "../src/today.js";

it("an owner call (no agent) gets only today's events in the owner's zone", async () => {
  // The kernel's view route signs kind owner with empty agent and key (kernel/src/views.ts); the service accepts it.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "EdDSA", kid: "k" })}.${b64({ agent: "", key: "", name: "owner", roles: [], tool: "google_workspace.calendar_today", aud: "google", kind: "owner", exp: Math.floor(Date.now() / 1000) + 60 })}`;
  const jwt = `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
  const caller = await verifyCaller({ headers: { "x-aidenhq-caller": jwt } }, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k" }] }, "google");
  expect(caller).toMatchObject({ kind: "owner", agent: "", key: "" });

  const dir = mkdtempSync(join(tmpdir(), "gws-"));
  mkdirSync(join(dir, "calendar"));
  // Dubai is UTC+4: its 26 November runs 2026-11-25T20:00Z .. 2026-11-26T20:00Z.
  writeFileSync(join(dir, "calendar", "events.json"), JSON.stringify([
    { id: "yesterday", title: "Yesterday", start: "2026-11-25T18:00:00Z", end: "2026-11-25T19:00:00Z" },
    { id: "early", title: "Early today", start: "2026-11-25T21:00:00Z", end: "2026-11-25T22:00:00Z" },
    { id: "allday-old", title: "Yesterday all day", all_day: true, start: "2026-11-25T00:00:00Z", end: "2026-11-26T00:00:00Z" },
    { id: "allday", title: "Today all day", all_day: true, start: "2026-11-26T00:00:00Z", end: "2026-11-27T00:00:00Z" },
    { id: "declined", title: "Declined", start: "2026-11-26T08:00:00Z", end: "2026-11-26T09:00:00Z", attendees: [{ self: true, response_status: "declined" }] },
    { id: "tomorrow", title: "Tomorrow", start: "2026-11-26T21:00:00Z", end: "2026-11-26T22:00:00Z" },
  ]));
  const today = await calendarToday(new FixtureWorkspace(dir), "Asia/Dubai", Date.parse("2026-11-26T10:00:00Z"));
  expect(today.timezone).toBe("Asia/Dubai");
  expect(today.events.map((e) => e.id).sort()).toEqual(["allday", "early"]);
  expect(Object.keys(today.events[0]!).sort()).toEqual(["all_day", "end", "id", "start", "title"]);
});

it("an event links to its video call, else its calendar page, http(s) only", () => {
  expect(eventUrl({ meet_link: "https://meet.google.com/abc-defg-hij", html_link: "https://www.google.com/calendar/event?eid=1" })).toBe("https://meet.google.com/abc-defg-hij");
  expect(eventUrl({ location: "Room 4 or https://acme.zoom.us/j/123?pwd=x", html_link: "https://www.google.com/calendar/event?eid=1" })).toBe("https://acme.zoom.us/j/123?pwd=x");
  expect(eventUrl({ location: "https://example.com/not-a-call", html_link: "https://www.google.com/calendar/event?eid=1" })).toBe("https://www.google.com/calendar/event?eid=1");
  expect(eventUrl({ location: "Online (https://meet.google.com/abc-defg-hij?authuser=1).", html_link: "https://x.test/e" })).toBe("https://meet.google.com/abc-defg-hij?authuser=1");
  expect(eventUrl({ location: "https://acme.zoom.us/j/123?pwd=abc;Room 4", html_link: "https://x.test/e" })).toBe("https://acme.zoom.us/j/123?pwd=abc");
  expect(eventUrl({ meet_link: "https:///", html_link: "https://x.test/e" })).toBe("https://x.test/e");
  expect(eventUrl({ meet_link: "javascript:alert(1)", html_link: "ftp://x" })).toBeUndefined();
  expect(eventUrl({})).toBeUndefined();
});
