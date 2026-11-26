// Reproduction: the only way a bug reaches the report. Each `bug` of clicks.json (the clicking pass's findings, with steps) is
// replayed twice, each time in a fresh browser context (signed in from --session when given), with a picture before and after
// its last step; one judging call per replay says whether the after picture shows the defect. A bug is verified only when both
// replays show it. `friction` items are replayed once, without a judge, to get their pictures, and go to friction.json: the
// design review's consolidation reads them as ease candidates. Nothing else writes `bugs`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { BrowserContext, Page as PwPage } from "playwright-core";
import { heightOf, initScript, launch, ready } from "./browser.ts";
import { type Mode, modeOf, pageOf } from "./guard.ts";
import { readSession } from "./login.ts";
import { ask, DEFAULT_MODEL, spend } from "./model.ts";
import { saveReport } from "./report.ts";
import type { Blocked, Bug, Click, Report, Step } from "./types.ts";

const STEP_MS = 5000;
const judgePrompt = readFileSync(new URL("./prompts/repro-judge.md", import.meta.url), "utf8").trim();
const fence = (s: string) => `<untrusted>\n${s.replace(/<\/?untrusted>/gi, "")}\n</untrusted>`;
const judgeSchema = { type: "object", additionalProperties: false, required: ["shows", "why"], properties: { shows: { type: "boolean" }, why: { type: "string" } } };

export type ReproOptions = { out: string; model?: string; session?: string; mode: Mode; maxUsd?: number; base?: string; key?: string };
type Replay = { ok: true; before: string; after: string; changed: { text: boolean; url: boolean }; writes: number; refused: number } | { ok: false; why: string };

const SECRET = /pass|secret|token|otp|totp|pin\b/i;
/** A step as text for the report; what is typed into a secret-looking field is never written. */
export function stepText(s: Step): string {
  if ("open" in s) return `open ${s.open}`;
  if ("click" in s) return `click ${s.click}`;
  if ("fill" in s) return `fill ${s.fill[0]} = ${SECRET.test(s.fill[0]) ? "***" : s.fill[1]}`;
  if ("press" in s) return `press ${s.press}`;
  return `wait ${s.wait}`;
}
const targetOf = (s: Step): string => ("open" in s ? s.open : "click" in s ? s.click : "fill" in s ? s.fill[0] : "press" in s ? s.press : s.wait);
const validStep = (s: unknown): s is Step => {
  const o = s as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  const v = o[keys[0]];
  return keys[0] === "fill" ? Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string") : ["open", "click", "press", "wait"].includes(keys[0]) && typeof v === "string" && v.length > 0;
};

async function run(page: PwPage, base: string, s: Step): Promise<void> {
  if ("open" in s) {
    const url = new URL(s.open, base);
    if (url.origin !== new URL(base).origin) throw new Error(`open ${s.open}: not on the app under review`);
    if (page.url() === url.href) await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }); // the same address again is a reload
    else await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await ready(page);
  } else if (new URL(page.url()).origin !== new URL(base).origin) throw new Error(`${stepText(s)}: the page left the app under review (${new URL(page.url()).origin})`);
  else if ("click" in s) { await page.locator(s.click).first().click({ timeout: STEP_MS }); await ready(page, 2000); }
  else if ("fill" in s) await page.locator(s.fill[0]).first().fill(s.fill[1], { timeout: STEP_MS });
  else if ("press" in s) { await page.keyboard.press(s.press); await ready(page, 2000); }
  else if (/^\d+$/.test(s.wait)) await new Promise((ok) => setTimeout(ok, Math.min(Number(s.wait), STEP_MS)));
  else await page.locator(s.wait).first().waitFor({ timeout: STEP_MS });
}

/** The steps in a fresh context; pictures of the page just before and just after the last step. */
/** `sockets`: the guard's refused WebSockets so far (read mode stubs them: no request a page event would show). */
async function replay(newContext: () => Promise<BrowserContext>, base: string, c: Click, out: string, tag: string, sockets: () => Blocked[]): Promise<Replay> {
  const ctx = await newContext();
  try {
    const page = await ctx.newPage();
    const steps = c.steps as Step[], last = steps.length - 1;
    const text = () => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    let before = "", textBefore = "", urlBefore = "", writes = 0, refused = 0, socketsBefore = 0;
    page.on("request", (r) => { if (before && !["GET", "HEAD", "OPTIONS"].includes(r.method())) writes++; }); // sent by the last step (a guard may then refuse it)
    // A request of the last step the live-app guard refused: what the page then shows is the guard's doing, not the app's.
    page.on("requestfailed", (r) => { if (before && /BLOCKED_BY_CLIENT/.test(r.failure()?.errorText ?? "")) refused++; });
    for (const [i, s] of steps.entries()) {
      if (i === last) { socketsBefore = sockets().length; before = `repro/${tag}-before.png`; await page.screenshot({ path: join(out, before) }); textBefore = await text(); urlBefore = page.url(); }
      await run(page, base, s);
    }
    // Evidence is of the app only: a last step that left it (a click or redirect to another origin) is no replay.
    if (new URL(page.url()).origin !== new URL(base).origin) throw new Error(`the last step left the app under review (${new URL(page.url()).origin})`);
    refused += sockets().slice(socketsBefore).filter((b) => b.page === pageOf(urlBefore) || b.page === pageOf(page.url())).length;
    const after = `repro/${tag}-after.png`;
    await page.screenshot({ path: join(out, after) });
    return { ok: true, before, after, changed: { text: (await text()) !== textBefore, url: page.url() !== urlBefore }, writes, refused };
  } catch (e) { return { ok: false, why: (e as Error).message.split("\n")[0] }; }
  finally { await ctx.close().catch(() => {}); }
}

async function judge(c: Click, r: Extract<Replay, { ok: true }>, out: string, o: ReproOptions): Promise<boolean> {
  const a = await ask({
    model: o.model ?? DEFAULT_MODEL, system: judgePrompt, base: o.base, key: o.key,
    images: [join(out, r.before), join(out, r.after)],
    text: [
      `Image 1 is the page just before the last step, image 2 just after it. The page is at ${c.width}px wide.`,
      `The reported defect:\n${fence(`${c.title}\nSaw: ${c.saw}\nExpected: ${c.expected}`)}`,
      `The steps:\n${fence((c.steps as Step[]).map(stepText).join("\n"))}`,
      `Measured across the last step: the page's text ${r.changed.text ? "changed" : "did not change"}; the address ${r.changed.url ? "changed" : "did not change"}; the page sent ${r.writes} write request${r.writes === 1 ? "" : "s"} (a live-app guard may have refused them).`,
    ].join("\n\n"),
    over: () => o.maxUsd !== undefined && spend.usd >= o.maxUsd,
    schema: judgeSchema, validate: (x) => { if (typeof (x as { shows?: unknown })?.shows !== "boolean") throw new Error('"shows" must be true or false'); },
  }) as { shows: boolean };
  return a.shows;
}

export type ReproResult = { bugs: Bug[]; friction: number; dropped: string[] };

/** Replays clicks.json (`clicksFile`) against `base`; writes the verified bugs into <out>/report.json and the friction items into <out>/friction.json. */
export async function repro(base: string, clicksFile: string, o: ReproOptions): Promise<ReproResult> {
  const list = JSON.parse(readFileSync(clicksFile, "utf8")) as unknown;
  if (!Array.isArray(list) || list.some((c) => (c as Click)?.kind !== "bug" && (c as Click)?.kind !== "friction")) throw new Error("candidates have no steps: replay needs clicks.json");
  const clicks = list as Click[];
  if (!existsSync(join(o.out, "report.json"))) throw new Error(`${o.out}/report.json is missing: capture the app first, then replay into the same folder`);
  const dropped: string[] = [];
  const todo = clicks.filter((c) => {
    const ok = Array.isArray(c.steps) && c.steps.length > 0 && c.steps.every(validStep) && Number.isInteger(c.width) && typeof c.title === "string" && typeof c.page === "string";
    if (!ok) dropped.push(`${c.title ?? "(untitled)"}: no usable steps`);
    return ok;
  });
  const batch = Date.now().toString(36); // each run's pictures have their own folder: an earlier bug's evidence is never overwritten
  mkdirSync(join(o.out, "repro", batch), { recursive: true });
  spend.usd = 0; spend.calls = 0;
  const over = () => o.maxUsd !== undefined && spend.usd >= o.maxUsd;
  // The guard signs every fresh context in with the session (guard.ts seed), as it does for capture.
  const l = await launch({ mode: o.mode, session: o.session ? readSession(o.session).state : null });
  const bugs: Bug[] = [], friction: unknown[] = [];
  let blocked: Blocked[] = [];
  try {
    const frozenAt = new Date().toISOString();
    const fresh = (c: Click) => async () => {
      const ctx = await l.browser.newContext({ viewport: { width: c.width, height: heightOf(c.width) }, deviceScaleFactor: 1 });
      await ctx.addInitScript(initScript(frozenAt));
      return ctx;
    };
    let n = 0;
    const queue = todo.map((c) => ({ c, id: `c${++n}` }));
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { c, id } = item;
        if (over()) { dropped.push(`${c.title}: the --max-usd budget was reached`); continue; }
        const steps = c.steps as Step[], last = steps[steps.length - 1];
        const runs: Extract<Replay, { ok: true }>[] = [];
        let verified = true;
        for (const k of c.kind === "bug" ? [1, 2] : [1]) {
          const r = await replay(fresh(c), base, c, o.out, `${batch}/${id}-r${k}`, () => l.blocked().filter((b) => b.method === "WS"));
          if (!r.ok) { dropped.push(`${c.title}: replay ${k} failed: ${r.why}`); verified = false; break; }
          runs.push(r);
          if (c.kind === "bug" && r.refused) { dropped.push(`${c.title}: not testable in ${o.mode} mode (the live-app guard refused its last step's request)`); verified = false; break; }
          if (c.kind === "bug") {
            if (over()) { dropped.push(`${c.title}: the --max-usd budget was reached`); verified = false; break; }
            try { if (!(await judge(c, r, o.out, o))) { dropped.push(`${c.title}: replay ${k} did not show it`); verified = false; break; } }
            catch (e) { dropped.push(`${c.title}: judging failed: ${(e as Error).message.split("\n")[0]}`); verified = false; break; }
          }
        }
        if (!verified || !runs.length) continue;
        const captures = runs.flatMap((r) => [r.before, r.after]);
        if (c.kind === "friction") {
          friction.push({
            category: "ease", where: { page: c.page, width: c.width, theme: "light", region: c.title },
            weak: `${c.saw} (steps: ${steps.map(stepText).join("; ")})`, change: `Make it do what a person expects: ${c.expected}`,
            why: "A person working this flow meets it as friction while clicking through the app.", best: `The best products show the expected result at once: ${c.expected}`, captures,
          });
        } else {
          bugs.push({ page: c.page, width: c.width, theme: "light", title: c.title, evidence: `${c.saw} (expected: ${c.expected})`, captures, verified: true, repro: steps.map(stepText), kind: "bug", selector: targetOf(last) });
        }
      }
    };
    await Promise.all([worker(), worker()]);
  } finally { blocked = l.blocked(); await l.close(); }

  const r = JSON.parse(readFileSync(join(o.out, "report.json"), "utf8")) as Report;
  const mine = new Set(todo.map((c) => `${c.page}|${c.title}`)); // every finding retried here: a bug that no longer reproduces leaves the report
  r.bugs = [...r.bugs.filter((b) => !mine.has(`${b.page}|${b.title}`)), ...bugs];
  r.cost_usd = Math.round((r.cost_usd + spend.usd) * 1e4) / 1e4;
  r.notes = [...r.notes, ...dropped.map((d) => `clicking pass, not reported: ${d}`)];
  // What the guard refused while replaying: listed with the capture's own under "Blocked requests".
  r.blocked = [...(r.blocked ?? []), ...blocked];
  saveReport(o.out, r);
  writeFileSync(join(o.out, "friction.json"), JSON.stringify(friction, null, 2));
  return { bugs, friction: friction.length, dropped };
}

/** `ui-review repro <clicks.json> --out <dir> [--url <app url>] [--session state.json] [--mode read|test-write|any] [--model id] [--max-usd n]` */
export async function reproCommand(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, url: { type: "string" }, session: { type: "string" }, mode: { type: "string" }, model: { type: "string" }, "max-usd": { type: "string" } } });
  if (!positionals[0] || !v.out) { console.error("usage: ui-review repro <clicks.json> --out <dir> [--url <app url>] [--session state.json] [--mode read|test-write|any] [--model id] [--max-usd n]"); return 2; }
  const report = existsSync(join(v.out, "report.json")) ? (JSON.parse(readFileSync(join(v.out, "report.json"), "utf8")) as Report) : null;
  const url = v.url ?? report?.target;
  if (!url) { console.error("ui-review repro: --url is required when --out has no report.json"); return 2; }
  // The mode as capture reads it: --mode, else any for a local build and read for everything else.
  const mode = modeOf(v.mode, url);
  if (!mode) { console.error("ui-review repro: --mode is read, test-write or any"); return 2; }
  try {
    const r = await repro(url, positionals[0], { out: v.out, session: v.session, mode, model: v.model, maxUsd: v["max-usd"] ? Number(v["max-usd"]) : undefined });
    console.log(`${r.bugs.length} verified bugs, ${r.friction} friction items, ${r.dropped.length} not reported${r.dropped.length ? `:\n${r.dropped.map((d) => `  - ${d}`).join("\n")}` : ""}`);
    return 0;
  } catch (e) {
    console.error(`ui-review repro: ${(e as Error).message}`);
    return (e as Error).message.startsWith("candidates have no steps") ? 2 : 1;
  }
}
