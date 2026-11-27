// Recurring tasks: the owner's schedules are Paperclip routines. A task that repeats has one routine, "Repeats: <task>", with one cron
// trigger in the owner's timezone; Paperclip fires it and the Researcher does the run (skill recurring-reports). The board keeps only
// which routine belongs to which task, and the cadence the owner picked (to show it again), made through the kernel's control plane.
import type { Logger } from "pino";
import { z } from "zod";
import { BadRequest } from "./board.js";
import { WEEKDAYS } from "./dates.js";
import type { Issue, Label, Paperclip, Routine } from "./paperclip.js";
import type { Recurring, Store } from "./store.js";
import { type TimeFormat, hhmmWords } from "./clock.js";

export const RECURRING_LABEL = "recurring";
/** Title prefix of a board-made routine: setup (scripts/retire-agents.ts) leaves routines with it alone. */
export const ROUTINE_PREFIX = "Repeats: ";
const TRIGGER_LABEL = "repeats";
const CLOSED = new Set(["done", "cancelled"]);
const REPO = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const weekday = z.enum(WEEKDAYS);
const interval = z.number().int().min(1).max(12).default(1);

export const CadenceSchema = z.discriminatedUnion("kind", [
  /** Every `interval` weeks on a weekday. */
  z.object({ kind: z.literal("weekly"), weekday, interval }).strict(),
  /** Every `interval` months on a day of the month, or the last day. */
  z.object({ kind: z.literal("monthly_day"), day: z.union([z.number().int().min(1).max(31), z.literal("last")]), interval }).strict(),
  /** Every `interval` months on the nth (or last) weekday, e.g. the first Monday. */
  z.object({ kind: z.literal("monthly_weekday"), nth: z.union([z.number().int().min(1).max(4), z.literal("last")]), weekday, interval }).strict(),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

export const RecurringSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      cadence: CadenceSchema,
      time: z.string().regex(TIME, "time must be HH:MM (24-hour)").default("07:00"),
      repos: z.array(z.string().trim().regex(REPO, "repos are owner/name or GitHub URLs")).max(30).default([]),
    })
    .strict(),
  z.object({ action: z.enum(["pause", "resume", "stop", "run_now"]) }).strict(),
]);

// ------------------------------------------------------------------ cadence → cron

/** Months a rule runs in: every `interval` months from the anchor month (1-12). Only intervals that divide the year are a cron list. */
function months(interval: number, anchor: number): string {
  if (interval === 1) return "*";
  if (12 % interval !== 0) throw new BadRequest(`every ${interval} months can't be a Paperclip schedule (use 1, 2, 3, 4, 6 or 12)`);
  return Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => (((m - anchor) % interval) + interval) % interval === 0).join(",");
}

/**
 * The cron expression of a cadence at a local time. Paperclip's cron has lists, ranges and steps, and a day of month AND a
 * weekday must both match (so "the first Monday" is days 1-7 on a Monday), but no "last" and no every-other-week.
 * What it can't say is refused, with the reason.
 */
export function cronOf(c: Cadence, time: string, anchor: number): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const at = `${m} ${h}`;
  const dow = (w: (typeof WEEKDAYS)[number]) => (WEEKDAYS.indexOf(w) + 1) % 7; // cron's Sunday is 0
  if (c.kind === "weekly") {
    if (c.interval !== 1) throw new BadRequest("every other week (or every N weeks) can't be a Paperclip schedule: use a weekly or monthly cadence");
    return `${at} * * ${dow(c.weekday)}`;
  }
  if (c.kind === "monthly_day") {
    if (c.day === "last") throw new BadRequest("the last day of the month can't be a Paperclip schedule: pick a day from 1 to 28");
    if (c.day > 28) throw new BadRequest(`day ${c.day} would skip short months in a Paperclip schedule: pick a day from 1 to 28`);
    return `${at} ${c.day} ${months(c.interval, anchor)} *`;
  }
  if (c.nth === "last") throw new BadRequest("the last weekday of the month can't be a Paperclip schedule: pick the first to fourth");
  return `${at} ${(c.nth - 1) * 7 + 1}-${c.nth * 7} ${months(c.interval, anchor)} ${dow(c.weekday)}`;
}

// ------------------------------------------------------------------ words

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const NTH = ["first", "second", "third", "fourth"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Every Monday at 7:00 AM", "Every 3 months on the 1st at 7:00 AM", "Monthly on the first Monday at 7:00 AM". */
export function describeRule(c: Cadence, time: string, fmt: TimeFormat): string {
  const at = `at ${hhmmWords(time, fmt)}`;
  if (c.kind === "weekly") return c.interval === 1 ? `Every ${cap(c.weekday)} ${at}` : `Every ${c.interval} weeks on ${cap(c.weekday)} ${at}`;
  const every = c.interval === 1 ? "Monthly" : `Every ${c.interval} months`;
  if (c.kind === "monthly_day") return `${every} on the ${c.day === "last" ? "last day" : ordinal(c.day)} ${at}`;
  return `${every} on the ${c.nth === "last" ? "last" : NTH[c.nth - 1]} ${cap(c.weekday)} ${at}`;
}

// ------------------------------------------------------------------ view

export interface RecurringView {
  summary: string;
  cadence: Cadence;
  time: string;
  repos: string[];
  paused: boolean;
  /** At most the next run: Paperclip's own schedule knows no further. */
  nextRun: string | null;
  upcoming: string[];
}

const scheduleOf = (routine: Routine | undefined) => routine?.triggers?.find((t) => t.kind === "schedule" && t.label === TRIGGER_LABEL);

export function recurringView(r: Recurring, routine: Routine | undefined, fmt: TimeFormat): RecurringView {
  const paused = routine?.status === "paused";
  const nextRun = paused || routine?.status !== "active" ? null : scheduleOf(routine)?.nextRunAt ?? null;
  return { summary: describeRule(r.cadence, r.time, fmt), cadence: r.cadence, time: r.time, repos: r.repos, paused, nextRun, upcoming: nextRun ? [nextRun] : [] };
}

// ------------------------------------------------------------------ changes

export interface Ctx {
  me: string;
  labels: Label[];
  /** The Researcher: its routine runs the task. */
  assistant: string | undefined;
}

const normalizeRepo = (s: string) => {
  const m = REPO.exec(s.trim())!;
  return `${m[1]}/${m[2]}`.toLowerCase();
};

const withLabel = (issue: Issue, label: Label | undefined, on: boolean) => {
  const ids = issue.labelIds ?? (issue.labels ?? []).map((l) => l.id);
  if (!label) return undefined;
  const has = ids.includes(label.id);
  if (has === on) return undefined;
  return on ? [...ids, label.id] : ids.filter((id) => id !== label.id);
};

const monthOf = (now: Date, tz: string) => Number(new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "numeric" }).format(now));

/** What a run is told: the task, the rule and the repositories; the rest is in the Researcher's skill. */
function brief(issue: Issue, c: Cadence, time: string, repos: string[], tz: string): string {
  return [
    `Recurring task ${issue.identifier} is due: ${describeRule(c, time, "24h")} (${tz}). Run time: {{timestamp}}.`,
    `Its instructions are that task's description.${repos.length ? ` GitHub repositories: ${repos.join(", ")}.` : ""}`,
    `Follow skill recurring-reports. Then close this task with one line saying what you did.`,
  ].join("\n");
}

/** Make a task recurring, change its rule, pause, resume, stop, or run it now. */
export async function changeRecurring(pc: Paperclip, store: Store, ctx: Ctx, issue: Issue, input: z.infer<typeof RecurringSchema>, tz: string, fmt: TimeFormat, log: Logger): Promise<RecurringView | null> {
  const existing = store.recurring(issue.id);
  const label = ctx.labels.find((l) => l.name === RECURRING_LABEL);
  if (input.action === "set") {
    if (CLOSED.has(issue.status)) throw new BadRequest("this task is closed; reopen it first");
    if (issue.assigneeUserId !== ctx.me || issue.assigneeAgentId) throw new BadRequest("only your own tasks can be recurring (assign it to yourself first)");
    if (!ctx.assistant) throw new BadRequest("there is no Researcher to run it");
    // Same cadence and time: keep the anchor month, so an every-3-months rule doesn't shift.
    const same = existing && JSON.stringify(existing.cadence) === JSON.stringify(input.cadence) && existing.time === input.time;
    const anchor = same ? existing.anchor : monthOf(new Date(), tz);
    const cron = cronOf(input.cadence, input.time, anchor);
    const repos = [...new Set(input.repos.map(normalizeRepo))];
    const description = brief(issue, input.cadence, input.time, repos, tz);
    let routineId = existing?.routineId;
    if (routineId) {
      await pc.request("PATCH", `/api/routines/${routineId}`, { description, status: "active", assigneeAgentId: ctx.assistant });
      const trigger = scheduleOf(await pc.routine(routineId));
      if (!trigger?.id) throw new Error(`routine ${routineId} has no schedule`);
      await pc.request("PATCH", `/api/routine-triggers/${trigger.id}`, { cronExpression: cron, timezone: tz, enabled: true });
    } else {
      const created = await pc.request<Routine>("POST", `/api/companies/${pc.companyId}/routines`, {
        title: `${ROUTINE_PREFIX}${issue.identifier}`,
        description,
        assigneeAgentId: ctx.assistant,
        priority: issue.priority,
        status: "active",
        // One run at a time per task; a tick Paperclip lost still fires on the next one.
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "enqueue_missed_with_cap",
        variables: [],
        env: null,
      });
      routineId = created.id;
      try {
        await pc.request("POST", `/api/routines/${routineId}/triggers`, { kind: "schedule", label: TRIGGER_LABEL, cronExpression: cron, timezone: tz });
      } catch (err) {
        await pc.request("PATCH", `/api/routines/${routineId}`, { status: "archived" }).catch(() => {});
        throw err;
      }
    }
    store.setRecurring(issue.id, { routineId, cadence: input.cadence, time: input.time, anchor, repos });
    store.unschedule(issue.id);
    const labelIds = withLabel(issue, label, true);
    if (labelIds) await pc.updateIssue(issue.id, { labelIds });
    if (!label) log.warn("label \"recurring\" missing in Paperclip (run scripts/paperclip-setup.ts)");
    log.info({ issue: issue.identifier, rule: describeRule(input.cadence, input.time, "24h"), cron, repos: repos.length }, "recurring task set");
    return recurringView(store.recurring(issue.id)!, await pc.routine(routineId), fmt);
  }
  if (!existing) throw new BadRequest("this task isn't recurring");
  const routineId = existing.routineId;
  if (input.action === "stop") {
    // Paperclip has no routine delete: an archived routine never fires again.
    await pc.request("PATCH", `/api/routines/${routineId}`, { status: "archived" });
    store.stopRecurring(issue.id);
    store.move(issue.id, "triage", "top");
    const labelIds = withLabel(issue, label, false);
    if (labelIds) await pc.updateIssue(issue.id, { labelIds });
    log.info({ issue: issue.identifier }, "recurring task stopped");
    return null;
  }
  if (input.action === "pause") await pc.request("PATCH", `/api/routines/${routineId}`, { status: "paused" });
  if (input.action === "resume") {
    await pc.request("PATCH", `/api/routines/${routineId}`, { status: "active" });
    // Saving the schedule again moves its next run to the next tick from now, so a long pause doesn't replay every tick it missed.
    const trigger = scheduleOf(await pc.routine(routineId));
    if (trigger?.id) await pc.request("PATCH", `/api/routine-triggers/${trigger.id}`, { cronExpression: cronOf(existing.cadence, existing.time, existing.anchor), timezone: tz, enabled: true });
  }
  if (input.action === "run_now") {
    if (CLOSED.has(issue.status)) throw new BadRequest("this task is closed; reopen it first");
    if ((await pc.routine(routineId)).status === "paused") throw new BadRequest("this recurring task is paused; resume it first");
    await pc.request("POST", `/api/routines/${routineId}/run`, { source: "api" });
  }
  log.info({ issue: issue.identifier, action: input.action }, "recurring task changed");
  return recurringView(existing, await pc.routine(routineId), fmt);
}

// ------------------------------------------------------------------ lifecycle

/**
 * A repeating task that is closed, reassigned away from the owner or deleted stops repeating: its routine is archived and the board
 * forgets it. The one place that enforces it (main.ts runs it on a timer), whichever way the task changed.
 */
export async function reapRecurring(pc: Paperclip, store: Store, log: Logger): Promise<void> {
  const rows = [...store.allRecurring()];
  if (!rows.length) return;
  const me = await pc.me();
  for (const [issueId, r] of rows) {
    const issue = await pc.issue(issueId).catch((err: { status?: number }) => (err.status === 404 ? null : Promise.reject(err)));
    if (issue && !CLOSED.has(issue.status) && issue.assigneeUserId === me && !issue.assigneeAgentId) continue;
    await pc.request("PATCH", `/api/routines/${r.routineId}`, { status: "archived" });
    store.stopRecurring(issueId);
    log.info({ issue: issue?.identifier ?? issueId, status: issue?.status ?? "deleted" }, "recurring task ended with its task");
  }
}

// ------------------------------------------------------------------ one-time conversion

/**
 * Schedules from before routines (the board's own scheduler kept them in `recurring`): each becomes a routine through the same
 * path as "set", then the old tables go. A rule Paperclip's cron can't say is logged and dropped; a failure that may pass (Paperclip
 * unreachable) stops the conversion and the old rows stay for the next start.
 */
export async function convertLegacyRecurring(pc: Paperclip, store: Store, tz: string, log: Logger): Promise<void> {
  const rows = store.legacyRecurring();
  if (rows === undefined) return;
  if (rows.length) {
    const [me, labels, agents] = await Promise.all([pc.me(), pc.labels(), pc.agents()]);
    const ctx: Ctx = { me, labels, assistant: agents.find((a) => a.status !== "terminated" && a.metadata?.setupKey === "aidenhq:assistant")?.id };
    for (const r of rows) {
      const issue = await pc.issue(r.issueId).catch((err: { status?: number }) => (err.status === 404 ? undefined : Promise.reject(err)));
      if (!issue || CLOSED.has(issue.status)) continue;
      try {
        await changeRecurring(pc, store, ctx, issue, { action: "set", cadence: r.cadence, time: r.time, repos: r.repos }, tz, "24h", log);
        if (r.paused) await changeRecurring(pc, store, ctx, issue, { action: "pause" }, tz, "24h", log);
      } catch (err) {
        if (!(err instanceof BadRequest)) throw err;
        log.error({ issue: issue.identifier, err: err.message }, "recurring task not converted to a routine");
      }
    }
  }
  store.dropLegacyRecurring();
  log.info({ converted: rows.length }, "recurring tasks are routines now");
}
