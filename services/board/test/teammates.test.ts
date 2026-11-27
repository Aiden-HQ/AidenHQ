// A teammate's setup end to end (teammates.ts, welcome.ts): the hiring list, its start (its own and its hidden staff's routines
// resumed, never another teammate's; the trial run once), the trial's findings, each account's queue, and onboarding's finish.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountSession } from "../src/kernel-auth.js";
import type { Issue, Paperclip, Routine } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { createTeammates, type HireCatalogRow } from "../src/teammates.js";
import { welcomeRoutes } from "../src/welcome.js";
import { fakeStates, row } from "./fake-states.js";

const tm = (job: string) => ({ job, sample: "Ask me", staff: [], controls: [], face: null });
const compiled = {
  agents: {
    "open-loops": { name: "Tess", module: "open-loops", teammate: tm("Follow-up chaser") },
    "inbox-agent": { name: "Intake", module: "intake" },
    notes: { name: "Nora", module: "intake", teammate: tm("Note taker") },
    "chief-of-staff": { name: "Aiden", module: "chief-of-staff", teammate: tm("Chief of staff") },
  },
  routines: {
    "open-loops-sweep": { title: "Open loops sweep", agent: "open-loops", schedules: [{ cron: "0 9 * * *" }] },
    "inbox-scan": { title: "Inbox scan", agent: "inbox-agent", schedules: [{ cron: "*/30 * * * *" }] },
    "inbox-lookback": { title: "Inbox look-back", agent: "inbox-agent", trial: true },
    "notes-scan": { title: "Notes scan", agent: "notes", schedules: [{ cron: "0 * * * *" }] },
    "daily-brief": { title: "Daily brief", agent: "chief-of-staff", schedules: [{ cron: "0 7 * * *" }] },
  },
};
const t = (key: string, name: string, job: string, first: number | null = null) => ({ key, name, job, sample: "s", description: "d", department: "General", face: null, first });
const catalog: HireCatalogRow[] = [
  { name: "kernel", enabled: true, teammates: [] },
  { name: "chief-of-staff", enabled: true, agents: ["chief-of-staff"], routines: ["daily-brief"], teammates: [t("chief-of-staff", "Aiden", "Chief of staff")] },
  { name: "intake", enabled: true, agents: ["inbox-agent", "notes"], routines: ["inbox-scan", "inbox-lookback", "notes-scan"], teammates: [t("notes", "Nora", "Note taker")] },
  { name: "open-loops", enabled: true, requires: ["intake"], agents: ["open-loops"], routines: ["open-loops-sweep"], teammates: [t("open-loops", "Tess", "Follow-up chaser", 1)] },
  { name: "twin", marketplace: "acme", browse: true, enabled: false, agents: ["scout"], teammates: [t("scout", "Scout", "Weather watcher")] },
];
const ids: Record<string, string> = { "open-loops-sweep": "r1", "inbox-scan": "r2", "inbox-lookback": "r3", "notes-scan": "r4", "daily-brief": "r5" };
const grants = { agents: { "pc-tess": { key: "open-loops" }, "pc-intake": { key: "inbox-agent" }, "pc-arch": { key: "chief-of-staff", roles: [] } }, routine_keys: Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k])) };

const status: Record<string, string> = { r1: "paused", r2: "paused", r3: "active", r4: "paused", r5: "paused" };
const calls: string[] = [];
const filed: Issue[] = [];
const pc = {
  routine: async (id: string): Promise<Routine> => ({ id, title: id, status: status[id]!, triggers: [] }),
  request: async (method: string, path: string, body?: { status?: string }) => {
    calls.push(`${method} ${path}`);
    const id = /\/api\/routines\/(r\d)/.exec(path)?.[1];
    if (method === "PATCH" && id && body?.status) status[id] = body.status;
    if (method === "POST" && path.endsWith("/run")) return { status: "issue_created", linkedIssueId: "run-1" };
    return {};
  },
  tasksSince: async () => filed,
} as unknown as Paperclip;
const states = fakeStates([row("run-1", { kind: "done" })]);
const store = new Store(":memory:");
const who = (id: string, owner = true) => ({ account: { id, email: `${id}@example.com`, name: id === "owner" ? "Sam" : id, role: "admin", owner }, session: { id: "s", expiresAt: "" }, ready: true, token: "t" }) as AccountSession;
const hiring = createTeammates({ pc, store, states, sources: () => ({ compiled: compiled as never, catalog, grants }), flowStates: async () => [{ module: "intake", done: false }, { module: "chief-of-staff", done: true }] });
const call = (method: string, path: string, body?: unknown, as = who("owner")) => {
  const r = hiring.routes.find((x) => x.method === method && x.path.test(path))!;
  return r.handle(path.match(r.path)!, body, as, "localhost") as Promise<any>;
};

describe("teammates", () => {
  it("lists every catalog teammate with its ref, recommends the lowest `first`, and resumes and runs only what the teammate needs", async () => {
    const list = await call("GET", "/api/teammates");
    expect(list.rows.map((r: { ref: string }) => r.ref)).toEqual(["chief-of-staff:chief-of-staff", "intake:notes", "open-loops:open-loops", "twin@acme:scout"]);
    const tess = list.rows.find((r: { key: string }) => r.key === "open-loops");
    expect([tess.onTeam, tess.connections]).toEqual([true, ["intake"]]);
    expect(list.rows.find((r: { browse: boolean }) => r.browse).onTeam).toBe(false);
    expect(list.first).toBe("twin@acme:scout"); // the only one not on the team
    await expect(call("POST", `/api/teammates/${encodeURIComponent("open-loops:open-loops")}/start`, {}, who("pat", false))).rejects.toThrow(/only the owner/);

    const started = await call("POST", `/api/teammates/${encodeURIComponent("open-loops:open-loops")}/start`, {});
    expect(started.resumed.sort()).toEqual(["inbox-scan", "open-loops-sweep"]); // not notes-scan (another teammate's), not daily-brief
    expect(started.trials).toEqual(["inbox-lookback"]);
    expect(calls.filter((c) => c.endsWith("/run"))).toEqual(["POST /api/routines/r3/run"]);
    // Again: nothing new runs while the trial stands.
    expect((await call("POST", `/api/teammates/${encodeURIComponent("open-loops:open-loops")}/start`, {})).trials).toEqual([]);
    expect(calls.filter((c) => c.endsWith("/run")).length).toBe(1);

    // What the trial filed: a task Intake created since the trial started.
    filed.push({ id: "i-1", identifier: "WOR-9", title: "Waiting on Sam: the contract", status: "todo", createdByAgentId: "pc-intake", createdAt: new Date(Date.now() + 1000).toISOString(), labels: [{ id: "l", name: "waiting-on", color: "#000" }] } as Issue);
    const trial = await call("GET", `/api/teammates/${encodeURIComponent("open-loops:open-loops")}/trial`);
    expect(trial).toEqual({ state: "done", found: [{ identifier: "WOR-9", title: "Waiting on Sam: the contract", labels: ["waiting-on"] }] });
    await expect(call("GET", "/api/teammates/nobody%3Ax/trial")).rejects.toThrow(/no such teammate/);
  });

  it("keeps each account's queue, and finishing onboarding files one task for the chief of staff", async () => {
    const q = { first: "open-loops:open-loops", next: ["twin@acme:scout"], later: [] };
    await call("PUT", "/api/teammates/queue", q);
    expect(await call("GET", "/api/teammates/queue")).toEqual(q);
    expect(await call("GET", "/api/teammates/queue", undefined, who("pat"))).toEqual({ next: [], later: [] });
    await expect(call("PUT", "/api/teammates/queue", { next: ["Not A Ref"], later: [] })).rejects.toThrow(/refs/);
    expect((await hiring.homeStart("owner", true, undefined))?.nextUp?.ref).toBe("twin@acme:scout");
    expect(await hiring.homeStart("owner", false, undefined)).toBeUndefined();

    const accounts = { call: async () => ({ ready: true, waiting: false }) } as never;
    const routes = welcomeRoutes({ accounts, store, marker: join(mkdtempSync(join(tmpdir(), "welcome-")), "welcome-sent") });
    const finish = routes.find((r) => r.method === "POST")!;
    const get = routes.find((r) => r.method === "GET")!;
    expect(await get.handle([] as never, undefined, who("owner"), "")).toEqual({ finished: false, modelReady: true, recoveryKeyWaiting: false });
    expect(await finish.handle([] as never, {}, who("owner"), "")).toEqual({ ok: true });
    expect(await finish.handle([] as never, {}, who("owner"), "")).toEqual({ ok: true });
    expect(store.meta("welcome_finished")).toBeTruthy();
  });
});
