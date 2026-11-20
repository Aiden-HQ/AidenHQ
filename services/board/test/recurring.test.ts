import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Issue, Label, Paperclip, Routine } from "../src/paperclip.js";
import { changeRecurring, reapRecurring, convertLegacyRecurring, cronOf } from "../src/recurring.js";
import { Store } from "../src/store.js";

const TZ = "Asia/Dubai";
const log = pino({ level: "silent" });
const ME = "user-1";
const labels: Label[] = [{ id: "00000000-0000-0000-0000-00000000001b", name: "recurring", color: "#0d9488" }];
const ctx = { me: ME, labels, assistant: "agent-researcher" };
const def: Issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "Weekly team update", description: "Channels: #team.", status: "todo", priority: "high", assigneeUserId: ME, assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], labelIds: [], createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" };

/** Paperclip as far as routines go: the routines it holds, and every call made. */
function fakePaperclip() {
  const routines = new Map<string, Routine>();
  const calls: [string, string, Record<string, unknown>?][] = [];
  const pc = {
    companyId: "co",
    updateIssue: vi.fn(async () => def),
    routine: vi.fn(async (id: string) => routines.get(id)!),
    request: vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push([method, path, body]);
      if (method === "POST" && path.endsWith("/routines")) {
        const r: Routine = { id: `r-${routines.size + 1}`, title: String(body!.title), status: "active", triggers: [] };
        routines.set(r.id, r);
        return r;
      }
      const trigger = /^\/api\/routines\/([^/]+)\/triggers$/.exec(path);
      if (trigger) routines.get(trigger[1]!)!.triggers!.push({ id: "t-1", kind: "schedule", enabled: true, label: String(body!.label), cronExpression: String(body!.cronExpression), nextRunAt: "2026-10-12T03:00:00.000Z" });
      const patch = /^\/api\/routines\/([^/]+)$/.exec(path);
      if (method === "PATCH" && patch && body?.status) routines.get(patch[1]!)!.status = String(body.status);
      return {};
    }),
  };
  return { pc: pc as unknown as Paperclip & typeof pc, routines, calls };
}

describe("recurring tasks are Paperclip routines", () => {
  const monday = { action: "set" as const, cadence: { kind: "weekly" as const, weekday: "monday" as const, interval: 1 }, time: "07:00", repos: ["https://github.com/Acme/API"] };

  it("an every Monday task becomes one routine with one schedule, and stopping it archives the routine", async () => {
    const s = new Store(":memory:");
    const { pc, routines, calls } = fakePaperclip();
    const view = await changeRecurring(pc, s, ctx, def, monday, TZ, log);

    expect(routines.size).toBe(1);
    const [[id, routine]] = [...routines] as [[string, Routine]];
    expect(routine.title).toBe("Repeats: PEN-1");
    expect(routine.triggers).toHaveLength(1);
    const created = calls.find(([m, p]) => m === "POST" && p.endsWith("/routines"))![2]!;
    expect(created).toMatchObject({ assigneeAgentId: "agent-researcher", status: "active" });
    expect(String(created.description)).toContain("acme/api");
    expect(calls.find(([, p]) => p.endsWith("/triggers"))![2]).toMatchObject({ kind: "schedule", cronExpression: "0 7 * * 1", timezone: TZ });
    expect(view).toMatchObject({ summary: "Every Monday at 07:00", repos: ["acme/api"], paused: false, nextRun: "2026-10-12T03:00:00.000Z" });
    expect(s.recurring(def.id)?.routineId).toBe(id);

    // Setting it again changes the same routine; stopping archives it (Paperclip has no routine delete) and the board forgets it.
    await changeRecurring(pc, s, ctx, def, { ...monday, time: "08:30" }, TZ, log);
    expect(routines.size).toBe(1);
    expect(await changeRecurring(pc, s, ctx, def, { action: "stop" }, TZ, log)).toBeNull();
    expect(routines.get(id)!.status).toBe("archived");
    expect(s.recurring(def.id)).toBeUndefined();
  });

  it("closing, reassigning or deleting the task archives its routine", async () => {
    const s = new Store(":memory:");
    const { pc, routines } = fakePaperclip();
    Object.assign(pc, { me: async () => ME });
    await changeRecurring(pc, s, ctx, def, monday, TZ, log);
    Object.assign(pc, { issue: async () => def });
    await reapRecurring(pc, s, log);
    expect([...routines.values()][0]!.status).toBe("active");
    Object.assign(pc, { issue: async () => ({ ...def, status: "done" }) });
    await reapRecurring(pc, s, log);
    expect([...routines.values()][0]!.status).toBe("archived");
    expect(s.recurring(def.id)).toBeUndefined();
    await changeRecurring(pc, s, ctx, def, monday, TZ, log);
    Object.assign(pc, { issue: async () => Promise.reject(Object.assign(new Error("gone"), { status: 404 })) });
    await reapRecurring(pc, s, log);
    expect(s.recurring(def.id)).toBeUndefined();
  });

  it("says in cron what Paperclip's cron can say, and refuses the rest with the reason", () => {
    expect(cronOf({ kind: "monthly_weekday", nth: 1, weekday: "monday", interval: 1 }, "09:30", 10)).toBe("30 9 1-7 * 1");
    expect(cronOf({ kind: "monthly_day", day: 1, interval: 3 }, "07:00", 11)).toBe("0 7 1 2,5,8,11 *");
    expect(() => cronOf({ kind: "weekly", weekday: "friday", interval: 2 }, "07:00", 1)).toThrow(/every other week/);
    expect(() => cronOf({ kind: "monthly_day", day: "last", interval: 1 }, "07:00", 1)).toThrow(/last day/);
    expect(() => cronOf({ kind: "monthly_weekday", nth: "last", weekday: "monday", interval: 1 }, "07:00", 1)).toThrow(/last weekday/);
  });

  it("converts the board's old schedules once, and drops the old tables", async () => {
    const s = new Store(":memory:");
    (s as unknown as { db: { exec(q: string): void } }).db.exec(`CREATE TABLE recurring (issue_id TEXT PRIMARY KEY, rule TEXT, repos TEXT, next_run TEXT, manual_at TEXT, paused INTEGER, last_until TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE recurring_runs (issue_id TEXT);
      INSERT INTO recurring (issue_id, rule, repos, paused) VALUES ('${def.id}', '{"cadence":{"kind":"weekly","weekday":"monday","interval":1},"time":"07:00","anchor":"2026-10-12"}', '["acme/api"]', 1);`);
    const { pc, routines } = fakePaperclip();
    Object.assign(pc, { me: async () => ME, labels: async () => labels, agents: async () => [{ id: "agent-researcher", status: "idle", metadata: { setupKey: "aidenhq:assistant" } }], issue: async () => def });
    await convertLegacyRecurring(pc, s, TZ, log);
    expect([...routines.values()].map((r) => [r.title, r.status])).toEqual([["Repeats: PEN-1", "paused"]]);
    expect(s.recurring(def.id)?.repos).toEqual(["acme/api"]);
    expect(s.legacyRecurring()).toBeUndefined();
  });
});
