import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { configTools } from "../service/src/config-tool.ts";
import { suggest, teamDomainOf } from "../service/src/prefill.ts";
import { DEFAULTS, KEYS, problem, problems, readSettings } from "../service/src/settings.ts";
import { pageHtml } from "../service/src/mcp.ts";

const root = join(import.meta.dirname, "..");
const YAML = createRequire(join(root, "../../scripts/package.json"))("yaml") as { parse: (s: string) => any };
const owner = { agent: "", roles: [], kind: "owner" };
const agent = { agent: "a", roles: ["aria-admin"], kind: "run", assertion: "jwt" };
const state = () => { let s = {} as any; return { get: () => s, set: (n: any) => { s = n; } }; };
function tools(over: { settings?: any; filed?: any[]; st?: any } = {}) {
  const filed = over.filed ?? [];
  const t = configTools({
    settings: () => ({ ...DEFAULTS, ...over.settings }), state: over.st ?? state(), now: () => new Date("2026-11-28T10:00:00Z"),
    env: { timezone: "Europe/London", time_format: "12h", owner_email: "sam@acme.com" },
    file: async (c) => { filed.push(c); return { ok: true }; }, 
  });
  return Object.fromEntries(t.map((x) => [x.name, x]));
}

test("the module's defaults, the service's defaults and every setting the page edits agree", () => {
  const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));
  for (const k of KEYS) assert.deepEqual(def.settings[k].default, DEFAULTS[k], k);
  assert.deepEqual(Object.keys(def.settings).sort(), [...KEYS].sort());
  assert.deepEqual([...def.contributes["board.pages"][0].settings].sort(), [...KEYS].sort());
  assert.deepEqual(problems(DEFAULTS), {});
  assert.deepEqual(readSettings({}), DEFAULTS);
  assert.match(String(problem("aria_working_hours", { ...(DEFAULTS.aria_working_hours as object), mon: "18:00-09:00" })), /ends before/);
  assert.match(String(problem("aria_stretch_hours", 9)), /0 to 6/);
  assert.match(String(problem("aria_blocking_calendars", [])), /at least one/);
  assert.deepEqual(readSettings({ ARIA_BLOCKING_CALENDARS: "primary,team@acme.com", ARIA_STRETCH_HOURS: "3" }).aria_blocking_calendars, ["primary", "team@acme.com"]);
});

test("aria_config answers every key with its default, and aria_configure proposes for the owner, files for an agent", async () => {
  const t = tools();
  const c = (await t.aria_config!.run({}, owner)) as any;
  assert.deepEqual(Object.keys(c.settings).sort(), [...KEYS].sort());
  assert.equal(c.owner_team_domain, "acme.com");
  const r = (await t.aria_configure!.run({ changes: { aria_working_hours: { sat: "10:00-14:00" } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change.map((x: any) => [x.key, x.value.sat, x.value.mon]), [["aria_working_hours", "10:00-14:00", "09:00-18:00"]]);
  const filed: any[] = [];
  const f = tools({ filed });
  await f.aria_configure!.run({ changes: { aria_stretch_hours: 1 } }, agent);
  assert.equal(filed.length, 1);
  await f.aria_configure!.run({ changes: { aria_optimizer_prompt: "Tidy my week, at most 2 moves a night." } }, agent);
  await assert.rejects(f.aria_configure!.run({ changes: { aria_working_hours: { mon: "9am" } } }, agent), /wouldn't work/);
  assert.deepEqual((((await tools().aria_configure!.run({ changes: { aria_stretch_hours: null } }, owner)) as any)._aidenhq.settings_change), []);
});

test("a second agent change builds on the first one still waiting to apply, not on the startup settings", async () => {
  const filed: any[] = [];
  const t = tools({ filed });
  await t.aria_configure!.run({ changes: { aria_working_hours: { sat: "10:00-12:00" } } }, agent);
  await t.aria_configure!.run({ changes: { aria_working_hours: { sun: "10:00-12:00" } } }, agent);
  assert.deepEqual([filed[1][0].value.sat, filed[1][0].value.sun], ["10:00-12:00", "10:00-12:00"]);
  assert.equal(((await t.aria_config!.run({}, owner)) as any).settings.aria_working_hours.sat, "10:00-12:00");
});

test("prefill: four weeks of meetings give hours covering at least 90% of them", () => {
  const meetings: any[] = [];
  const at = (day: number, hm: string, min: number, who: string[] = []) => { const s = new Date(`2026-11-${String(day).padStart(2, "0")}T${hm}:00Z`); meetings.push({ start: s.toISOString(), end: new Date(s.getTime() + min * 60000).toISOString(), attendees: who }); };
  for (const wk of [2, 9, 16, 23]) for (let d = 0; d < 5; d++) {
    at(wk + d, "09:00", 30, ["sam@acme.com", "kim@acme.com"]); at(wk + d, "11:00", 30, ["sam@acme.com", "lee@acme.com"]); at(wk + d, "14:00", 45, ["sam@acme.com", "x@partner.example.com"]); at(wk + d, "16:00", 30);
  }
  at(2, "07:00", 30); at(23, "20:00", 60);
  meetings.push({ start: "2026-11-04T00:00:00Z", end: "2026-11-05T00:00:00Z", all_day: true }, { start: "2026-11-03T23:00:00Z", end: "2026-11-04T01:30:00Z" });
  const s = suggest(meetings, { timeZone: "Europe/London", calendars: ["primary", "primary"] });
  assert.ok(s.based_on.coverage >= 0.9, String(s.based_on.coverage));
  assert.deepEqual([s.working_hours.sat, s.working_hours.sun], ["off", "off"]);
  assert.equal(s.working_hours.wed, "09:00-16:30");
  assert.deepEqual(s.blocking_calendars, ["primary"]);
  assert.deepEqual(problems({ ...DEFAULTS, aria_working_hours: s.working_hours }), {});
  assert.equal(teamDomainOf("me@gmail.com"), undefined);
  assert.equal(teamDomainOf("me@acme.com"), "acme.com");
});

test("the nightly tidy-up is a declared, paused routine with the owner's prompt and no scheduler or cap of its own", () => {
  const def = YAML.parse(readFileSync(join(root, "module.yaml"), "utf8"));
  const r = def.routines["optimize-calendar"];
  assert.equal(r.status, "paused");
  assert.deepEqual(r.schedules.map((x: any) => x.cron), ["0 2 * * *"]);
  assert.match(r.description, /\$\{settings\.aria_optimizer_prompt\}/);
  assert.deepEqual(def.roles.requests, ["kernel.settings"]);
  assert.ok(!JSON.stringify(def.connections).includes("move_budget"));
  assert.equal(problem("aria_optimizer_prompt", "a\nb"), problem("aria_optimizer_prompt", "x".repeat(501)));
  assert.equal(problem("aria_optimizer_prompt", String(DEFAULTS.aria_optimizer_prompt)), undefined);
});

test("the page draws every section, and Google not connected is a hint, not an error", () => {
  const html = pageHtml(new URL("../service/src/", import.meta.url));
  for (const s of ["Status", "Your week", "Calendars", "In your words", "Nightly tidy-up", "Signature"]) assert.ok(html.includes(`"${s}"`), s);
  assert.ok(!html.includes("/*kit:css*/") && !html.includes("/*kit:js*/"));
  assert.ok(html.includes("Aria uses the Google connection under Settings, Connections"));
  assert.match(readFileSync(join(root, "agents/aria/AGENTS.md"), "utf8"), /Aria needs Google/);
});

test("nothing in the module is written for one owner", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === "node_modules" ? [] : walk(join(d, f))) : [join(d, f)]));
  for (const f of walk(root)) assert.doesNotMatch(readFileSync(f, "utf8"), new RegExp(["mu" + "dit", "du" + "bai", "poly" + "gon"].join("|"), "i"), f);
});
