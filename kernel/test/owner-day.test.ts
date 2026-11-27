// The owner's day: midnight in the owner's zone, across an offset (half hour), a spring-forward and a fall-back day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayStart, ownerDay, ownerMonth, zone } from "../sdk/src/owner-day.ts";

test("a day is the owner's calendar day, whole across DST", () => {
  const t = Date.parse("2026-11-27T20:30:00Z"); // 00:30 the 28th in Dubai, 02:00 the 28th in Kolkata, still the 27th in New York
  assert.equal(ownerDay(t, "UTC"), "2026-11-27");
  assert.equal(ownerDay(t, "Asia/Dubai"), "2026-11-28");
  assert.equal(ownerDay(t, "Asia/Kolkata"), "2026-11-28");
  assert.equal(ownerDay(t, "America/New_York"), "2026-11-27");
  assert.equal(ownerMonth(Date.parse("2026-11-30T21:00:00Z"), "Asia/Dubai"), "2026-12");
  assert.equal(ownerDay(t, "Not/AZone"), "2026-11-27");
  assert.equal(zone(undefined), "UTC");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  // Half-hour offset: Kolkata's day begins 18:30 UTC the day before.
  assert.equal(new Date(dayStart("2026-11-28", "Asia/Kolkata")).toISOString(), "2026-11-27T18:30:00.000Z");
  // London springs forward on 2026-03-29 (a 23-hour day) and falls back on 2026-10-25 (25 hours).
  const hours = (d: string) => (dayStart(addDays(d, 1), "Europe/London") - dayStart(d, "Europe/London")) / 36e5;
  assert.equal(hours("2026-03-29"), 23);
  assert.equal(hours("2026-10-25"), 25);
  assert.equal(hours("2026-06-01"), 24);
  assert.equal(new Date(dayStart("2026-06-01", "Europe/London")).toISOString(), "2026-05-31T23:00:00.000Z");
  // The instant a day begins is in that day, the instant before it is in the day before.
  for (const tz of ["America/New_York", "Pacific/Kiritimati", "Asia/Kathmandu", "Pacific/Pago_Pago"]) {
    const s = dayStart("2026-11-01", tz);
    assert.equal(ownerDay(s, tz), "2026-11-01");
    assert.equal(ownerDay(s - 1, tz), "2026-10-31");
  }
});
