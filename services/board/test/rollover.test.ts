// The rollover's one job: Tomorrow joins Today on a new workday. A card a schedule owns (a snooze parks it where it is until its
// date) is that schedule's to move, never the rollover's: pulling it in early lands it a day before it was asked for.
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

describe("rollover", () => {
  it("rolls Tomorrow into Today once per new day, below what's already in Today", () => {
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0); // the first run only records the date
    s.setOrder("today", ["t1", "t2"]);
    s.setOrder("tomorrow", ["m1", "m2"]);
    s.setOrder("later", ["l1"]);
    expect(s.rollover("2026-10-07")).toBe(0);
    expect(s.rollover("2026-10-08")).toBe(2);
    expect(s.rollover("2026-10-08")).toBe(0);
    const p = s.placements();
    const today = [...p].filter(([, v]) => v.bucket === "today").sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k);
    expect(today).toEqual(["t1", "t2", "m1", "m2"]);
    expect(p.get("l1")?.bucket).toBe("later");
  });

  it("a card snoozed for tomorrow is not pulled into Today by an earlier day's rollover", () => {
    // Snooze parks a card for tomorrow in Tomorrow, with its move filed for tomorrow's date. A rollover on the day before must
    // leave it parked: its own move has not come due, so pulling it in now would land it a day early.
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0);
    s.setOrder("today", ["t1"]);
    s.setOrder("tomorrow", ["s1"]);
    s.schedule("s1", "2026-10-09", "today", "top", true);
    expect(s.rollover("2026-10-08")).toBe(0);
    expect(s.placements().get("s1")?.bucket).toBe("tomorrow");
    // On its own date, applySchedules moves it to Today in its place.
    expect(s.applySchedules("2026-10-09")).toEqual(["s1"]);
    expect(s.placements().get("s1")?.bucket).toBe("today");
  });

  it("a card with a pending schedule further out is parked until its date, not rolled over early", () => {
    // The same rule for a later date: the schedule owns the card's movement, and the rollover leaves it in Tomorrow.
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0);
    s.setOrder("tomorrow", ["l1"]);
    s.schedule("l1", "2026-10-20", "today", "top", true);
    expect(s.rollover("2026-10-08")).toBe(0);
    expect(s.placements().get("l1")?.bucket).toBe("tomorrow");
    expect(s.applySchedules("2026-10-20")).toEqual(["l1"]);
    expect(s.placements().get("l1")?.bucket).toBe("today");
  });

  it("a card already in Tomorrow with a move filed from there still rolls over normally", () => {
    // A future move filed without a park leaves the card where it sits. A card in Tomorrow with such a move is not being held
    // there by it: the normal rollover moves it on the next day like any other card.
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0);
    s.setOrder("tomorrow", ["b1", "b2"]);
    s.schedule("b1", "2026-12-20", "today", "top");
    expect(s.rollover("2026-10-08")).toBe(2);
    expect(s.placements().get("b1")?.bucket).toBe("today");
    expect(s.placements().get("b2")?.bucket).toBe("today");
    // Its own move still lands on its date (it is simply already there).
    expect(s.applySchedules("2026-12-20")).toEqual(["b1"]);
    expect(s.schedules().size).toBe(0);
  });
});
