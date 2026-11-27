// The schedule (spec §12): per-machine due slots in the instance's timezone, DST read by the wall clock, missed runs coalesced, a
// weekly pass and an hourly check in one slot run once as the larger (a full patch), and one durable record per slot so a service
// restart cannot start the same slot twice. Nothing here touches a host: it answers "what is due for this machine now", and the
// service records the slot before the run and marks it done after.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Machine } from "./config.ts";

/** One slot: the machine, what is due, and the wall-clock instant the slot is for (`YYYY-MM-DDTHH:MM` in the instance's zone). */
export interface Slot { machine: string; kind: "security" | "full"; slot: string }

/** The durable record of a slot: written before its run and marked done after, keyed `<machine>:<kind>:<slot>` (§12). */
interface SlotRow { key: string; machine: string; kind: string; slot: string; started_at: string; done_at?: string; ok?: boolean; detail?: string }

/**
 * The wall clock in a zone, as the parts a schedule compares: the local date, the weekday (0 Sun…6 Sat) and minutes of the day. A
 * DST-skipped local time simply does not exist, so the first real instant after it is the first `at` whose clock reads at or past
 * the due minute on that day — the caller walks minutes forward, which is what makes the skip rule (§12) fall out.
 */
export function localParts(at: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekday < 0 ? 0 : weekday, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** `mon`…`sun` as the index `localParts` uses. */
export const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const hhmm = (s: string) => { const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(s); if (!m) throw new Error(`not a time: ${s}`); return Number(m[1]) * 60 + Number(m[2]); };

/** The wall clock of an instant as `HH:MM` in the zone. */
const hm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The slots a machine's settings put at or before `at`: the latest hourly (or N-minutely) check of the local day, and the latest
 * weekly occurrence. A run missed while the service was down is these two, never one per missed hour (§12: missed runs coalesce).
 * `firstSeen`: a machine is quiet before the owner added it — a weekly occurrence older than that is not a missed pass.
 */
function dueSince(m: Machine, at: Date, timeZone: string, firstSeen?: Date): { security?: string; weekly?: string } {
  const now = localParts(at, timeZone);
  const out: { security?: string; weekly?: string } = {};
  const step = m.security_minutes;
  const lastCheck = Math.floor(now.minutes / step) * step;
  // Quiet start (§9): a machine's first scheduled check is the first interval strictly *after* it was listed. A machine added at
  // 10:00:30 is not due for the 10:00 slot that began before it existed; it is due at 11:00.
  const seen = firstSeen ? localParts(firstSeen, timeZone) : undefined;
  const listedBeforeThisSlot = !seen || seen.date < now.date || (seen.date === now.date && seen.minutes < lastCheck);
  if (listedBeforeThisSlot) out.security = `${now.date}@${hm(lastCheck)}`;
  const want = hhmm(m.weekly_time), day = DAY_INDEX[m.weekly_day] ?? 1;
  for (let back = 0; back < 8; back += 1) {
    const p = localParts(new Date(at.getTime() - back * 86_400_000), timeZone);
    if (p.weekday !== day) continue;
    if (back === 0 && p.minutes < want) continue;
    // The weekly pass is due only for a day the machine was already listed on: a machine added on Wednesday is not overdue for
    // Monday's pass (quiet start, §9).
    if (seen) {
      if (`${p.date}` < seen.date || (`${p.date}` === seen.date && want <= seen.minutes)) continue;
    }
    out.weekly = `${p.date}@${m.weekly_time}`;
    break;
  }
  return out;
}

/**
 * What a machine is due for now: nothing, or one slot. A weekly pass and a check that fall in the same wall-clock slot are one run
 * as `full` (§12): the weekly pass is the larger, and its read includes the check's. A slot already started is never due again,
 * however many polls run.
 */
export function dueFor(m: Machine, at: Date, timeZone: string, store: SlotStore): Slot | undefined {
  if (!m.enabled) return undefined;
  const d = dueSince(m, at, timeZone, store.seenAt(m.name));
  const weekly = d.weekly ? { kind: "full" as const, slot: d.weekly } : undefined;
  const check = d.security ? { kind: "security" as const, slot: d.security } : undefined;
  // The whole slot, date included: a weekly pass on Monday 03:00 and Tuesday's 03:00 check share a time of day but are different
  // slots, and comparing only the time would coalesce them into one (wrong) full run on Monday's date.
  const sameSlot = Boolean(weekly && check && weekly.slot === check.slot);
  // Same slot, both due: one run, the larger. The weekly pass's run includes the check's read, so the check never runs a second time
  // at that instant — not even after the pass itself is done.
  if (sameSlot) return store.has(m.name, "full", weekly.slot) ? undefined : { machine: m.name, kind: "full", slot: weekly.slot };
  if (weekly && !store.has(m.name, "full", weekly.slot)) return { machine: m.name, kind: "full", slot: weekly.slot };
  if (check && !store.has(m.name, "security", check.slot)) return { machine: m.name, kind: "security", slot: check.slot };
  return undefined;
}


/**
 * The durable slot records (§12): `<machine>:<kind>:<slot>`, written before the run starts and marked done after. A restart reads
 * the file and neither repeats a done slot nor forgets a started one (which is resolved from the host's own state before a retry:
 * `dpkg --audit`, the boot ID).
 */
export class SlotStore {
  private readonly file: string;
  private rows: Record<string, SlotRow>;
  private readonly first: Record<string, string> = {};
  private readonly seenFile: string;
  constructor(dir: string) {
    this.file = join(dir, "due-slots.json");
    this.seenFile = join(dir, "machines-seen.json");
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      this.rows = v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { this.rows = {}; }
    try {
      const v = JSON.parse(readFileSync(this.seenFile, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(this.first, v);
    } catch { /* no machine has been seen yet */ }
  }
  private saveSeen(): void {
    const tmp = `${this.seenFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.first, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.seenFile);
  }
  private key(machine: string, kind: string, slot: string) { return `${machine}:${kind}:${slot}`; }
  /**
   * When this machine was first listed (the first time a schedule tick saw it), so a weekly pass that predates the machine is not
   * read as missed. Written once, durably: a restart keeps the same answer.
   */
  seenAt(machine: string): Date | undefined {
    const r = this.first[this.key(machine, "", "")] ?? undefined;
    return r ? new Date(r) : undefined;
  }
  /** Records a machine's first sighting, unless it has one, and returns it. */
  markSeen(machine: string, at = new Date()): Date {
    const k = this.key(machine, "", "");
    if (!this.first[k]) { this.first[k] = at.toISOString(); this.saveSeen(); }
    return new Date(this.first[k]!);
  }
  /** Whether a slot has been started (done or not): a started slot is never started twice. */
  has(machine: string, kind: string, slot: string): boolean { return this.key(machine, kind, slot) in this.rows; }
  get(machine: string, kind: string, slot: string): SlotRow | undefined { return this.rows[this.key(machine, kind, slot)]; }
  all(): SlotRow[] { return Object.values(this.rows).sort((a, b) => a.key.localeCompare(b.key)); }
  /** Records a slot before its run; returns false when it was already started (the caller must not run it). */
  start(s: Slot, at = new Date()): boolean {
    const key = this.key(s.machine, s.kind, s.slot);
    if (key in this.rows) return false;
    this.rows[key] = { key, machine: s.machine, kind: s.kind, slot: s.slot, started_at: at.toISOString() };
    this.save();
    return true;
  }
  /** Marks a started slot done with the run's result. Unknown keys are recorded, so a crash between start and finish is visible. */
  finish(s: Slot, ok: boolean, detail = "", at = new Date()): void {
    const key = this.key(s.machine, s.kind, s.slot);
    const row = this.rows[key] ?? { key, machine: s.machine, kind: s.kind, slot: s.slot, started_at: at.toISOString() };
    this.rows[key] = { ...row, done_at: at.toISOString(), ok, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
    this.save();
  }
  /**
   * Forget a started slot that never ran: a filing that failed for a transient reason (the kernel was unreachable) leaves the slot
   * eligible, so the next tick files it, instead of the hour being lost as "done, failed".
   */
  release(s: Slot): void {
    const key = this.key(s.machine, s.kind, s.slot);
    if (!(key in this.rows)) return;
    delete this.rows[key];
    this.save();
  }
  /** A slot left started but never finished (a restart mid-run): resolved from the host's state, never replayed blind. */
  unfinished(): SlotRow[] { return this.all().filter((r) => !r.done_at); }
  /** Forget slots older than the window (the file stays small): a done slot from days ago cannot be polled again anyway. */
  prune(before: Date): void {
    let changed = false;
    for (const [k, r] of Object.entries(this.rows)) if (r.done_at && new Date(r.done_at) < before) { delete this.rows[k]; changed = true; }
    if (changed) this.save();
  }
  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.rows, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

