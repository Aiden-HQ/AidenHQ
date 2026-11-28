import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { configTools } from "../service/src/config-tool.ts";
import { budget } from "../service/src/optimizer-cap.ts";
import { suggest, teamDomainOf } from "../service/src/prefill.ts";
import { DEFAULTS, KEYS, problem, problems, readSettings } from "../service/src/settings.ts";
import { look } from "../service/src/tidy.ts";
import { pageHtml } from "../service/src/mcp.ts";

const root = join(import.meta.dirname, "..");
const YAML = createRequire(join(root, "../../scripts/package.json"))("yaml") as { parse: (s: string) => any };
const owner = { agent: "", roles: [], kind: "owner" };
const agent = { agent: "a", roles: ["aria-admin"], kind: "run", assertion: "jwt" };
const state = () => { let s = {} as any; return { get: () => s, set: (n: any) => { s = n; } }; };
function tools(over: { settings?: any; work?: any[]; filed?: any[]; st?: any } = {}) {
  const filed = over.filed ?? [];
  const t = configTools({
    settings: () => ({ ...DEFAULTS, ...over.settings }), state: over.st ?? state(), now: () => new Date("2026-11-28T10:00:00Z"),
    env: { timezone: "Europe/London", time_format: "12h", owner_email: "sam@acme.com" },
    file: async (c) => { filed.push(c); return { ok: true }; }, work: async () => over.work ?? [],
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
  assert.match(String(problem("aria_meetings", { ...(DEFAULTS.aria_meetings as object), max_per_day: 0 })), /1 to 50/);
  assert.equal(problem("aria_meetings", { ...(DEFAULTS.aria_meetings as object), buffer_min: null }), undefined);
});

test("aria_config answers every key with its default, and aria_configure proposes for the owner, files for an agent, and keeps the tidy-up's switch the owner's", async () => {
  const t = tools();
  const c = (await t.aria_config!.run({}, owner)) as any;
  assert.deepEqual(Object.keys(c.settings).sort(), [...KEYS].sort());
  assert.equal(c.owner_team_domain, "acme.com");
  const r = (await t.aria_configure!.run({ changes: { aria_meetings: { max_per_day: 6 } } }, owner)) as any;
  assert.deepEqual(r._aidenhq.settings_change.map((x: any) => [x.key, x.value.max_per_day, x.value.intro]), [["aria_meetings", 6, 30]]);
  const filed: any[] = [];
  const f = tools({ filed });
  await f.aria_configure!.run({ changes: { aria_following_up: { max_nudges: 1 } } }, agent);
  assert.equal(filed.length, 1);
  await assert.rejects(f.aria_configure!.run({ changes: { aria_optimizer: { on: true } } }, agent), /owner's/);
  assert.equal((((await f.aria_configure!.run({ changes: { aria_optimizer: { on: true } } }, owner)) as any)._aidenhq.settings_change[0]).value.on, true);
  await f.aria_configure!.run({ changes: { aria_optimizer: { max_moves: 2 } } }, agent);
  await assert.rejects(f.aria_configure!.run({ changes: { aria_working_hours: { mon: "9am" } } }, agent), /wouldn't work/);
  assert.deepEqual((((await f.aria_configure!.run({ changes: { aria_following_up: null } }, owner)) as any)._aidenhq.settings_change), []);
});

test("prefill: four weeks of meetings give hours covering at least 90% of them and the usual length", () => {
  const meetings: any[] = [];
  const at = (day: number, hm: string, min: number, who: string[] = []) => { const s = new Date(`2026-11-${String(day).padStart(2, "0")}T${hm}:00Z`); meetings.push({ start: s.toISOString(), end: new Date(s.getTime() + min * 60000).toISOString(), attendees: who }); };
  for (const wk of [2, 9, 16, 23]) for (let d = 0; d < 5; d++) {
    at(wk + d, "09:00", 30, ["sam@acme.com", "kim@acme.com"]); at(wk + d, "11:00", 30, ["sam@acme.com", "lee@acme.com"]); at(wk + d, "14:00", 45, ["sam@acme.com", "x@partner.example.com"]); at(wk + d, "16:00", 30);
  }
  at(2, "07:00", 30); at(23, "20:00", 60);
  const s = suggest(meetings, { timeZone: "Europe/London", ownerEmail: "sam@acme.com", calendars: ["primary", "primary"] });
  assert.ok(s.based_on.coverage >= 0.9, String(s.based_on.coverage));
  assert.deepEqual([s.working_hours.sat, s.working_hours.sun], ["off", "off"]);
  assert.equal(s.working_hours.wed, "09:00-16:30");
  assert.deepEqual(s.durations, { default: 30, one_on_one: 30, external: 45 });
  assert.deepEqual(s.blocking_calendars, ["primary"]);
  assert.equal(teamDomainOf("me@gmail.com"), undefined);
  assert.equal(teamDomainOf("me@acme.com"), "acme.com");
});

test("the nightly cap holds across retries: moves counted from the kernel's records, not from the run", async () => {
  const rec = (state: string, requester = "aria", kind = "conn.tool", created_at = "2026-11-28T02:05:00Z") => ({ kind, state, requester, created_at });
  const three = [rec("done"), rec("review"), rec("unknown"), rec("failed"), rec("rejected"), rec("done", "someone"), rec("done", "aria", "github.pr"), rec("done", "aria", "conn.tool", "2026-11-27T20:00:00Z")];
  assert.deepEqual(budget(three, "aria", "2026-11-28T02:00:00Z", 3), { used: 3, max_moves: 3, remaining: 0, ok: false });
  assert.equal(budget(three.slice(0, 2), "aria", "2026-11-28T02:00:00Z", 3).remaining, 1);
  const st = state(); st.set({ tidy: { armed: true, filed_at: "2026-11-28T02:00:00Z" } });
  const t = tools({ work: three, st, settings: { aria_optimizer: { ...(DEFAULTS.aria_optimizer as object), max_moves: 3 } } });
  assert.equal(((await t.aria_move_budget!.run({}, agent)) as any).ok, false);
});

test("the tidy-up arms when switched on, files once a night at its time, and never runs late or while off", () => {
  const z = "Europe/London", at = "02:00";
  let r = look(new Date("2026-11-28T14:00:00Z"), z, true, at, undefined);
  assert.equal(r.file, undefined); assert.equal(r.tidy.armed, true); assert.equal(r.tidy.date, "2026-11-28");
  assert.equal(look(new Date("2026-11-29T01:30:00Z"), z, true, at, r.tidy).file, undefined);
  const night = look(new Date("2026-11-29T02:10:00Z"), z, true, at, r.tidy);
  assert.equal(night.file, "2026-11-29");
  assert.equal(look(new Date("2026-11-29T02:11:00Z"), z, true, at, { ...r.tidy, date: "2026-11-29" }).file, undefined);
  assert.equal(look(new Date("2026-11-30T12:00:00Z"), z, true, at, { ...r.tidy, date: "2026-11-29" }).file, undefined);
  const off = look(new Date("2026-11-30T02:10:00Z"), z, false, at, r.tidy);
  assert.deepEqual([off.file, off.tidy.armed], [undefined, false]);
});

test("the page draws every section, and Google not connected is a hint, not an error", () => {
  const html = pageHtml(new URL("../service/src/", import.meta.url));
  for (const s of ["Status", "Your week", "Meetings", "People", "How I like my calendar", "Following up", "Nightly tidy-up", "Signature"]) assert.ok(html.includes(`"${s}"`), s);
  assert.ok(!html.includes("/*kit:css*/") && !html.includes("/*kit:js*/"));
  assert.ok(html.includes("Aria uses the Google connection under Settings, Connections"));
  assert.match(readFileSync(join(root, "agents/aria/AGENTS.md"), "utf8"), /Aria needs Google/);
});

test("nothing in the module is written for one owner", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === "node_modules" ? [] : walk(join(d, f))) : [join(d, f)]));
  for (const f of walk(root)) assert.doesNotMatch(readFileSync(f, "utf8"), new RegExp(["mu" + "dit", "du" + "bai", "poly" + "gon"].join("|"), "i"), f);
});
