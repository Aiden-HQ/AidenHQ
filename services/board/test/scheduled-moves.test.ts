import { describe, expect, it } from "vitest";
import type { Issue } from "../src/paperclip.js";
import { ScheduleSchema, scheduleMove } from "../src/scheduled-moves.js";
import { addDays } from "../src/dates.js";
import { Store, localDate } from "../src/store.js";

const TZ = "Europe/Madrid";
const issue = (): Issue => ({ id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "t", description: null, status: "todo", priority: "high", assigneeUserId: "u", assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], labelIds: [], createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" });

describe("scheduled moves", () => {
  it("moves the task on its date, on top, and only once", () => {
    const s = new Store(":memory:");
    s.move("a", "today");
    s.move("b", "later");
    s.schedule("b", "2026-10-15", "today", "top");
    expect(s.applySchedules("2026-10-14")).toEqual([]);
    expect(s.placements().get("b")?.bucket).toBe("later");
    expect(s.applySchedules("2026-10-15")).toEqual(["b"]);
    const p = s.placements();
    expect(p.get("b")!.bucket).toBe("today");
    expect(p.get("b")!.rank).toBeLessThan(p.get("a")!.rank);
    expect(s.schedules().size).toBe(0);
  });


  it("a move by hand replaces the scheduled one; ranking within the column doesn't", () => {
    const s = new Store(":memory:");
    s.move("b", "later");
    s.move("c", "later");
    s.schedule("b", "2026-10-15", "today");
    s.setOrder("later", ["c", "b"]);
    expect(s.schedules().has("b")).toBe(true);
    s.setOrder("tomorrow", ["b"]);
    expect(s.schedules().has("b")).toBe(false);
    s.schedule("c", "2026-10-15", "today");
    s.move("c", "backlog");
    expect(s.schedules().has("c")).toBe(false);
  });


  it("parks the task in a column until its date (Snooze)", () => {
    const s = new Store(":memory:");
    const later = addDays(localDate(TZ), 3);
    s.move(issue().id, "today");
    expect(scheduleMove(s, issue(), ScheduleSchema.parse({ date: later, park: "backlog" }), TZ)).toEqual({
      scheduled: { date: later, bucket: "today", position: "top" },
      movedNow: false,
    });
    expect(s.placements().get(issue().id)?.bucket).toBe("backlog");
    expect(s.schedules().get(issue().id)?.date).toBe(later);
    expect(s.applySchedules(later)).toEqual([issue().id]);
    expect(s.placements().get(issue().id)?.bucket).toBe("today");
    expect(() => ScheduleSchema.parse({ date: later, park: "nowhere" })).toThrow();
  });
});
