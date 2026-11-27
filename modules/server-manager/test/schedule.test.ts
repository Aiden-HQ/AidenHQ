// The schedule (spec §12): due times in the instance's timezone with DST read by the wall clock, missed runs coalesced, a weekly pass
// and a check in one slot run once as the larger, and one durable record per slot so a restart cannot start the same slot twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueFor, localParts, realInstantFor, SlotStore } from "../service/src/schedule.ts";
import type { Machine } from "../service/src/config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "sm-slot-"));
const m = (over: Partial<Machine> = {}): Machine => ({ name: "vm-one", address: "vm-one", port: 22, user: "user", key: "vm-one-key", enabled: true, expected_fingerprint: "", security_minutes: 60, weekly_day: "mon", weekly_time: "03:00", reboot_policy: "auto", quiet_start: "03:00", quiet_end: "05:00", ...over });

test("a fresh install schedules nothing: no machine, no slot", () => {
  const store = new SlotStore(dir());
  assert.equal(dueFor(m({ enabled: false }), new Date("2026-11-27T03:05:00Z"), "UTC", store), undefined, "a disabled machine is never due");
});

test("an hourly check is due at its slot and only once: the durable record is what stops the second poll", () => {
  const store = new SlotStore(dir());
  const at = new Date("2026-11-27T10:30:00Z"); // a Thursday, 10:30 UTC; not the weekly Monday 03:00
  store.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  const due = dueFor(m(), at, "UTC", store);
  assert.deepEqual(due, { machine: "vm-one", kind: "security", slot: "2026-11-27@10:00" });
  assert.equal(store.start(due!, at), true);
  assert.equal(dueFor(m(), at, "UTC", store), undefined, "a started slot is never due twice");
  assert.equal(store.start(due!, at), false, "the store refuses a second start");
});

test("a service restart mid-slot cannot start the same slot again: the record is on disk, not in memory", () => {
  const d = dir();
  const at = new Date("2026-11-27T10:30:00Z");
  const first = new SlotStore(d);
  // Listed on the Monday after its weekly pass, so only the hourly check is pending.
  first.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  const again = new SlotStore(d);
  const due = dueFor(m(), at, "UTC", again)!;
  again.start(due, at);
  // A new process reads the same file: the slot is started, and unfinished (it never finished), never replayed.
  const third = new SlotStore(d);
  assert.equal(dueFor(m(), at, "UTC", third), undefined);
  assert.deepEqual(third.unfinished().map((r) => r.slot), [due.slot], "an interrupted slot is visible, and resolved from the host, not replayed");
  third.finish(due, true, "done");
  assert.deepEqual(new SlotStore(d).unfinished(), []);
});

test("missed runs coalesce: hours the service was down are one run, not one per hour", () => {
  const store = new SlotStore(dir());
  store.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  // Down from 06:00 to 11:20: the latest hourly slot is 11:00, and it is the one run.
  const due = dueFor(m(), new Date("2026-11-27T11:20:00Z"), "UTC", store);
  assert.deepEqual(due, { machine: "vm-one", kind: "security", slot: "2026-11-27@11:00" });
});

test("a weekly pass and a check in one slot are one run, as the larger (full)", () => {
  const store = new SlotStore(dir());
  store.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  // Monday 03:00 UTC: the weekly pass and the 03:00 hourly check fall in the same slot.
  const due = dueFor(m(), new Date("2026-11-30T03:05:00Z"), "UTC", store);
  assert.deepEqual(due, { machine: "vm-one", kind: "full", slot: "2026-11-30@03:00" }, "one run, as the full patch");
  assert.equal(store.start(due!, new Date("2026-11-30T03:05:00Z")), true);
  // The next check an hour later is the hourly one, not another weekly pass.
  assert.deepEqual(dueFor(m(), new Date("2026-11-30T04:05:00Z"), "UTC", store), { machine: "vm-one", kind: "security", slot: "2026-11-30@04:00" });
  // Same hour of the *next* day is its own slot: Monday's completed full pass must not swallow Tuesday's 03:00 check.
  assert.deepEqual(dueFor(m(), new Date("2026-12-01T03:05:00Z"), "UTC", store), { machine: "vm-one", kind: "security", slot: "2026-12-01@03:00" }, "the date is part of the slot, so a week-ago full pass covers no later check");
});

test("a full pass is not due again the same week, and a check at that hour next week is not swallowed", () => {
  const store = new SlotStore(dir());
  store.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  const monday = dueFor(m(), new Date("2026-11-30T03:05:00Z"), "UTC", store)!;
  assert.deepEqual(monday, { machine: "vm-one", kind: "full", slot: "2026-11-30@03:00" });
  store.start(monday, new Date("2026-11-30T03:05:00Z"));
  store.finish(monday, true, "done");
  // Tuesday through Sunday: hourly checks, never the Monday pass again.
  const tue = dueFor(m(), new Date("2026-12-01T09:30:00Z"), "UTC", store)!;
  assert.deepEqual(tue, { machine: "vm-one", kind: "security", slot: "2026-12-01@09:00" });
  store.start(tue, new Date("2026-12-01T09:30:00Z"));
  store.finish(tue, true, "done");
  // Next Monday: a fresh pass, because its slot key is its own date.
  const next = dueFor(m(), new Date("2026-12-07T03:05:00Z"), "UTC", store)!;
  assert.deepEqual(next, { machine: "vm-one", kind: "full", slot: "2026-12-07@03:00" });
  assert.equal(store.start(next, new Date("2026-12-07T03:05:00Z")), true);
  assert.deepEqual(store.unfinished().map((r) => `${r.kind}:${r.slot}`), ["full:2026-12-07@03:00"]);
});

test("DST skip: a run whose wall time is skipped runs at the first real time after it", () => {
  // America/New_York springs forward at 02:00 on 2026-03-08: 02:30 never happens. The first real instant after it is 03:00 EDT.
  const t = realInstantFor("2026-03-08", "02:30", "America/New_York", new Date("2026-03-08T00:00:00Z"));
  const p = localParts(t, "America/New_York");
  assert.equal(`${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`, "03:00", "the skipped minute is jumped over");
  assert.equal(p.date, "2026-03-08");
});

test("DST repeat: a run whose wall time happens twice runs once, on the first occurrence", () => {
  // America/New_York falls back at 02:00 on 2026-11-01: 01:30 happens twice. The first occurrence is EDT (UTC-4), 05:30Z.
  const t = realInstantFor("2026-11-01", "01:30", "America/New_York", new Date("2026-11-01T00:00:00Z"));
  assert.equal(t.toISOString(), "2026-11-01T05:30:00.000Z", "the first pass, not the second (06:30Z)");
  // The slot's key is its wall-clock spelling, so both passes are one key: a slot inside the repeated hour cannot run twice.
  const store = new SlotStore(dir());
  store.markSeen("vm-one", new Date("2026-10-20T00:00:00Z"));
  const first = dueFor(m({ weekly_day: "sun", weekly_time: "01:00" }), new Date("2026-11-01T05:30:00Z"), "America/New_York", store)!;
  assert.equal(first.kind, "full");
  store.start(first, new Date("2026-11-01T05:30:00Z"));
  assert.equal(dueFor(m({ weekly_day: "sun", weekly_time: "01:00" }), new Date("2026-11-01T06:30:00Z"), "America/New_York", store), undefined, "the second pass is the same slot");
});

test("a due time is the owner's wall clock: the same instant is a different slot in another zone", () => {
  const at = new Date("2026-11-27T22:30:00Z");
  const utc = new SlotStore(dir()), dubai = new SlotStore(dir());
  utc.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  dubai.markSeen("vm-one", new Date("2026-11-23T03:30:00Z"));
  assert.equal(dueFor(m(), at, "UTC", utc)!.slot, "2026-11-27@22:00");
  // 22:30 UTC is 02:30 in Dubai the next day.
  assert.equal(dueFor(m(), at, "Asia/Dubai", dubai)!.slot, "2026-11-28@02:00");
});

test("the durable records are pruned by age so the file stays small, and a done slot is never due again", () => {
  const d = dir();
  const store = new SlotStore(d);
  const at = new Date("2026-01-01T10:05:00Z");
  store.markSeen("vm-one", new Date("2025-12-01T00:00:00Z"));
  // The first Monday pass after the machine was listed is due; run it once so the rest of this test is the hourly check's own.
  const weekly = dueFor(m(), at, "UTC", store)!;
  store.start(weekly, at); store.finish(weekly, true, "", at);
  const due = dueFor(m(), at, "UTC", store)!;
  store.start(due, at);
  store.finish(due, true, "", at);
  store.prune(new Date("2026-02-01T00:00:00Z"));
  const reloaded = new SlotStore(d);
  assert.equal(reloaded.all().length, 0, "an old done slot is pruned");
  // A slot from yesterday is not replayed: the schedule reads only the latest due slot, never one per missed hour.
  assert.notEqual(dueFor(m(), at, "UTC", new SlotStore(dir()))!.slot, undefined);
});

test("a machine added mid-week is not overdue for a pass from before it was listed (quiet start)", () => {
  // A machine added on Wednesday has no Monday pass to catch up: its first scheduled run is its first interval after the add.
  const store = new SlotStore(dir());
  store.markSeen("vm-one", new Date("2026-11-25T09:00:00Z")); // a Wednesday
  const due = dueFor(m(), new Date("2026-11-27T10:30:00Z"), "UTC", store);
  assert.equal(due?.kind, "security", "the check, never a retroactive weekly pass");
});

test("§9 the first tick that sees a machine records it, so its first due slot is one interval after it was listed", () => {
  // What main.ts's tick does: markSeen on the machine it is about to ask about, from its own store, on the first minute it runs.
  const store = new SlotStore(dir());
  const added = new Date("2026-11-27T10:00:30Z"); // a Thursday, just after 10:00
  store.markSeen("vm-one", added);
  assert.equal(dueFor(m(), added, "UTC", store), undefined, "nothing is due at the moment it is added");
  // Two hours later, the latest hourly slot is 12:00; and no Monday pass from before it was listed is replayed.
  const due = dueFor(m(), new Date("2026-11-27T12:00:20Z"), "UTC", store);
  assert.deepEqual(due, { machine: "vm-one", kind: "security", slot: "2026-11-27@12:00" });
});
