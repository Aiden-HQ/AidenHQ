// The apps platform's write kinds (executor.ts): plan checks the caller and pins what runs, raising a stateful deploy to the
// reviewer (a migration labelled as one); execute runs the record's args through the engine.
import { describe, expect, it } from "bun:test";
import { appsExecutor, touchesMigrations } from "../src/executor.js";
import { parseApp, type App } from "../src/registry.js";
import type { Platform } from "../src/platform.js";

const SHA = "a".repeat(40);
const diff = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+x\n`;
const apps: Record<string, App> = {
  web: parseApp({ name: "web", repo: "example-org/web", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api: { callers: ["keeper"], paths: ["/api/agent"] } }),
  narrow: parseApp({ name: "narrow", repo: "example-org/narrow", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api: { callers: [{ agent: "keeper", paths: ["GET /api/agent/intake", "POST /api/agent/intake/{reference}/decision"] }], paths: ["/api/agent/intake"] } }),
  "public-intake": parseApp({ name: "public-intake", repo: "example-org/public-intake", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api: { callers: [{ agent: "red-teamer", paths: ["/intake", "/intake/feedback"] }], paths: ["/api/agent"], member_paths: ["/intake", "/intake/feedback"] } }),
  db: parseApp({ name: "db", repo: "example-org/db", owner: "app-maintainer", description: "d", stateful: true }),
  // Restricted to the finance role: app_view refuses an agent without it, and so must a member app_api call.
  ledger: parseApp({ name: "ledger", repo: "example-org/ledger", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api: { callers: ["keeper"], paths: ["/api/agent"] }, access: { roles: ["finance"] } }),
};
const who = (key: string, roles: string[] = []) => ({ agent: `ag-${key}`, key, name: key, roles, kind: "run" });

function platform(o: { diff?: string; truncated?: boolean; running?: { sha?: string; healthy?: boolean } } = {}) {
  const calls: unknown[][] = [];
  const p = {
    cfg: { git: {} },
    find: (n: string) => apps[n] ?? (() => { throw new Error(`no app ${n}`); })(),
    store: { openIncident: () => undefined },
    cached: () => o.running ?? {},
    commit: async (_a: App, sha: string) => ({ sha: sha.padEnd(40, "a"), subject: "fix: thing‮", diff: o.diff ?? diff("src/a.ts"), truncated: o.truncated ?? false }),
    runPlan: async () => ({ sha: SHA, service: "app", command: "node seed.js" }),
    engine: { deploy: async (...a: unknown[]) => (calls.push(["deploy", ...a]), { sha: SHA, status: "healthy" }), run: async (...a: unknown[]) => (calls.push(["run", ...a]), { ok: true, timed_out: false, output: "3 rows" }) },
  };
  return { ex: appsExecutor(p as unknown as Platform), calls };
}
const plan = (ex: ReturnType<typeof appsExecutor>, kind: string, args: object, requester = who("app-maintainer")) => ex.plan({ kind: `apps-platform.${kind}`, args, requester, task: "t" });

describe("apps-platform write kinds", () => {
  it("only an app's owner (or the incident role during an incident) changes it; a run is its owner's alone", async () => {
    const { ex } = platform();
    await expect(plan(ex, "deploy", { name: "web", sha: "abc1234" }, who("chief-of-staff"))).rejects.toThrow(/can't change web: only its owner/);
    await expect(plan(ex, "restart", { name: "web" }, who("chief-of-staff", ["app-incidents"]))).rejects.toThrow(/can't change web/);
    await expect(plan(ex, "run", { name: "web", script: "seed" }, who("chief-of-staff"))).rejects.toThrow(/only web's owner/);
    await expect(ex.plan({ kind: "apps-platform.restart", args: { name: "web" }, requester: { ...who("x"), agent: "" }, task: "t" })).rejects.toThrow(/agent identity required/);
    expect(await plan(ex, "restart", { name: "web" })).toEqual({ args: { name: "web" } });
  });

  it("a deploy pins the full commit; a stateful one goes to the reviewer, a migration labelled as one, and is nothing to do when it already runs", async () => {
    const plain = await plan(platform().ex, "deploy", { name: "web", sha: "abc1234" });
    expect(plain).toMatchObject({ args: { name: "web", sha: "abc1234".padEnd(40, "a"), stateful: false }, targets: { commit: "abc1234".padEnd(40, "a") } });
    expect(plain.raise).toBeUndefined();
    const stateful = await plan(platform().ex, "deploy", { name: "db", sha: SHA });
    expect(stateful.raise).toMatchObject({ tier: 1, rule: "deploy-stateful" });
    // The author's commit message comes last, after its marker, printable (the reviewer reads it apart from the diff).
    expect(stateful.card!.details).toMatch(/\n\nCommit message \(written by the app's author\): fix: thing$/);
    expect((await plan(platform({ diff: diff("migrations/002.sql") }).ex, "deploy", { name: "db", sha: SHA })).raise).toMatchObject({ tier: 1, rule: "deploy-migration" });
    expect((await plan(platform({ running: { sha: SHA, healthy: true } }).ex, "deploy", { name: "db", sha: SHA })).satisfied?.evidence).toMatch(/db already runs aaaaaaaaaaaa and is healthy/);
    expect((await plan(platform({ diff: "" }).ex, "deploy", { name: "db", sha: SHA })).card!.details).toMatch(/none in the app's directory/);
    await expect(plan(platform({ diff: "", truncated: true }).ex, "deploy", { name: "db", sha: SHA })).rejects.toThrow(/too large \(or couldn't be read\) to review/);
    await expect(plan(platform().ex, "rollback", { name: "db" })).rejects.toThrow(/stateful: rollback needs the owner's approval/);
  });

  it("a migration is read from file headers only; a hunk line can't pose as one", () => {
    const d = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;
    expect(touchesMigrations(d("migrations/005.sql", "CREATE TABLE t (id int);"))).toBe(true);
    expect(touchesMigrations(d("db/schema.prisma", "model X {}"))).toBe(true);
    expect(touchesMigrations(d("src/app.ts", "// migrations later"))).toBe(false);
    expect(touchesMigrations(d("src/app.ts", "+++ b/migrations/1.sql"))).toBe(false);
  });

  it("a run pins the running commit and shows the script; an API write is the app's listed caller, under its paths", async () => {
    const { ex, calls } = platform();
    const r = await plan(ex, "run", { name: "web", script: "seed:backfill", reason: "fill‮ it", task: "ignored" });
    expect(r.args).toEqual({ name: "web", script: "seed:backfill", service: "app", sha: SHA });
    expect(r.card!.details).toContain("Script (from the app's package.json): node seed.js\nReason (written by the requesting agent): fill it");
    await expect(plan(ex, "api_write", { name: "web", method: "POST", path: "/api/agent/x" })).rejects.toThrow(/may not call web's API/);
    await expect(plan(ex, "api_write", { name: "web", method: "POST", path: "/admin" }, who("keeper"))).rejects.toThrow(/isn't under web's agent API paths/);
    expect((await plan(ex, "api_write", { name: "web", method: "POST", path: "/api/agent/x", body: { a: 1 } }, who("keeper"))).args).toEqual({ name: "web", caller: "keeper", method: "POST", path: "/api/agent/x", role: "admin", body: { a: 1 } });
    // A member request is the signed-in test-user identity on a public route; the caller gate still applies.
    expect((await plan(ex, "api_write", { name: "web", method: "POST", path: "/intake/feedback", role: "member", body: { text: "x" } }, who("keeper"))).args).toEqual({ name: "web", caller: "keeper", method: "POST", path: "/intake/feedback", role: "member", body: { text: "x" } });
    await expect(plan(ex, "api_write", { name: "web", method: "POST", path: "/intake/feedback", role: "member" }, who("intruder"))).rejects.toThrow(/may not call web's API/);
    // A restricted app: member is what app_view would do, so the app's read-access policy applies as well as the caller gate.
    await expect(plan(ex, "api_write", { name: "ledger", method: "POST", path: "/intake", role: "member" }, who("keeper"))).rejects.toThrow(/no access to ledger/);
    expect((await plan(ex, "api_write", { name: "ledger", method: "POST", path: "/intake", role: "member" }, who("keeper", ["finance"]))).args).toMatchObject({ role: "member" });
    // The admin API keeps its own scope: no finance role is needed under the app's api.paths.
    expect((await plan(ex, "api_write", { name: "ledger", method: "POST", path: "/api/agent/x" }, who("keeper"))).args).toMatchObject({ role: "admin" });
    // The kernel routes recorded arguments here, so an unknown role is refused rather than signed as admin.
    await expect(plan(ex, "api_write", { name: "web", method: "POST", path: "/api/agent/x", role: "Member" }, who("keeper"))).rejects.toThrow(/role must be admin or member/);
    await expect(plan(ex, "api_write", { name: "web", method: "POST", path: "/api/agent/x", role: "owner" }, who("keeper"))).rejects.toThrow(/role must be admin or member/);
    // A caller held to exact routes: the method is part of the check, so a write plan can't spend its read route.
    expect((await plan(ex, "api_write", { name: "narrow", method: "POST", path: "/api/agent/intake/AB12CD34/decision" }, who("keeper"))).args).toMatchObject({ caller: "keeper", method: "POST" });
    await expect(plan(ex, "api_write", { name: "narrow", method: "DELETE", path: "/api/agent/intake/AB12CD34/decision" }, who("keeper"))).rejects.toThrow(/isn't under narrow's agent API paths/);
    await expect(plan(ex, "api_write", { name: "narrow", method: "POST", path: "/api/agent/intake" }, who("keeper"))).rejects.toThrow(/isn't under narrow's agent API paths/);
    // A member request reaches the app's opted-in public intake only as a member; admin stays under api.paths.
    expect((await plan(ex, "api_write", { name: "public-intake", method: "POST", path: "/intake/feedback", role: "member" }, who("red-teamer"))).args).toMatchObject({ caller: "red-teamer", role: "member" });
    await expect(plan(ex, "api_write", { name: "public-intake", method: "POST", path: "/intake/feedback" }, who("red-teamer"))).rejects.toThrow(/isn't under/);
    await expect(plan(ex, "api_write", { name: "public-intake", method: "POST", path: "/intake/feedback", role: "member" }, who("intruder"))).rejects.toThrow(/may not call/);
    // execute runs exactly the record's args.
    expect(await ex.execute({ id: "k-0000000000000000", kind: "apps-platform.deploy", args: { name: "db", sha: SHA, stateful: true }, digest: "d", idempotency_key: "k-0000000000000000" })).toMatchObject({ ok: true });
    expect(calls[0]).toEqual(["deploy", apps.db, { sha: SHA, by: "approval k-0000000000000000", allowStateful: true }]);
    expect((await ex.execute({ id: "k-1", kind: "apps-platform.run", args: r.args, digest: "d", idempotency_key: "k-1" })).text).toMatch(/^Ran `npm run seed:backfill` in app web at aaaaaaaa\.[\s\S]*3 rows$/);
  });
});
