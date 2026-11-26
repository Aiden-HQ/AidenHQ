// The regression set of the UI review: five suites, run on request (never in CI) whenever a prompt, a default model or the
// engine changes. One JSON line per suite; exit 1 when a suite is below its bar.
//   node run.ts degraded|fixes|references|calibrate|corrections [--model m] [--rated file] [--cases dir]
//     [--work dir] [--capture-only] [--port n] [--targets file] [--refs file] [--fallback file]
// Captures go to --work (reused when the shots are already there), so they can be taken where Chrome is and the model calls
// made elsewhere with the key; --capture-only stops after the shots. The engine is /opt/aidenhq/ui-review and the starter
// /opt/aidenhq/app-starter (AIDENHQ_UI_REVIEW and AIDENHQ_APP_STARTER name a checkout's copies). Owner ratings and correction
// cases are scoring data: they are read here and never put in a prompt.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { degradations } from "./degrade.ts";
import { ENGINE, open, serveStarter, shutdown } from "./shots.ts";

const here = dirname(new URL(import.meta.url).pathname);
const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: { model: { type: "string" }, rated: { type: "string" }, cases: { type: "string" }, work: { type: "string" }, port: { type: "string" }, "capture-only": { type: "boolean" }, targets: { type: "string" }, refs: { type: "string" }, fallback: { type: "string" }, samples: { type: "string" } },
});
const suite = positionals[0];
const work = resolve(o.work ?? mkdtempSync(join(tmpdir(), "design-eval-")));
const eng = (f: string) => import(pathToFileURL(join(ENGINE, f)).href);
const { ask, spend } = await eng("model.ts");
const { fixCheck } = await eng("pairwise.ts");
const { DEFAULT_MODEL } = await eng("model.ts");
const model: string = o.model ?? DEFAULT_MODEL;

/** Starter pages every suite uses; the first four are the `degraded` set. */
const PAGES = ["/", "/teams", "/?item=search-v2", "/?status=late"];
/** Their page kinds (the review picks its reference pages by kind). */
const KINDS: Record<string, string> = { "/": "list", "/teams": "list", "/?item=search-v2": "detail", "/?status=late": "list" };
let starter: string | undefined;
const starterUrl = async () => (starter ??= await serveStarter(work, Number(o.port ?? 3600)));

const rng = (seed: number) => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); };
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await f(q.shift() as T); }));
}
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const out = (r: Record<string, unknown>) => { console.log(JSON.stringify({ ...r, model, usd: Math.round(spend.usd * 1e4) / 1e4 })); return r.pass === true; };

/** `ui-review <args>` of the engine's CLI. */
function cli(...args: string[]) {
  try { return execFileSync("node", [join(ENGINE, "main.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) {
    const err = e as { status?: number; stderr?: string };
    throw new Error(err.status === 2 ? `ui-review ${args[0]} is not available in this engine: ${err.stderr?.trim()}` : `ui-review ${args[0]} failed: ${err.stderr?.trim()}`);
  }
}

// ---- degraded: the reviewer picks the original over a subtly degraded copy and names the change ----------------------------
async function degraded() {
  const file = (p: number, k: string) => join(work, "degraded", `p${p}-${k}.png`);
  const all = PAGES.flatMap((_, p) => ["orig", ...degradations.map((d) => d.kind)].map((k) => file(p, k)));
  if (!all.every(existsSync)) {
    const base = await starterUrl();
    for (const [p, path] of PAGES.entries()) {
      const s = await open(base + path, { width: 1512 });
      await s.shot(file(p, "orig"));
      for (const d of degradations) {
        await s.page.reload({ waitUntil: "load" }); await s.page.evaluate(() => document.fonts.ready);
        await s.page.waitForTimeout(600);
        await s.page.evaluate(d.apply, 1000 + p);
        await s.page.waitForTimeout(200);
        await s.shot(file(p, d.kind));
      }
      await s.close();
    }
  }
  if (o["capture-only"]) return out({ suite: "degraded", pass: true, captured: all.length });
  const system = `${readFileSync(join(ENGINE, "prompts/pairwise.md"), "utf8").trim()}\n\nOne of the two versions had a small unintended change made to its styles. Decide which is better designed, and name the kind of change the worse one carries in "change" and where it shows in "where".`;
  const schema = { type: "object", additionalProperties: false, required: ["better", "change", "where"], properties: { better: { type: "string", enum: ["A", "B"] }, change: { type: "string", enum: ["spacing", "font-size", "colour", "alignment", "other"] }, where: { type: "string" } } };
  const jobs = PAGES.flatMap((_, p) => degradations.map((d, di) => ({ p, kind: d.kind, i: p * degradations.length + di })));
  let picked = 0, named = 0;
  const misses: string[] = [];
  await pool(jobs, 4, async (j) => {
    const originalIsA = j.i % 2 === 0; // alternate which position holds the original
    const [a, b] = originalIsA ? [file(j.p, "orig"), file(j.p, j.kind)] : [file(j.p, j.kind), file(j.p, "orig")];
    const r = await ask({ model, system, images: [a, b], schema, text: "Two versions of the same page at 1512px wide: image 1 is version A, image 2 is version B." }) as { better: string; change: string };
    const original = r.better === (originalIsA ? "A" : "B");
    if (original) picked++; else misses.push(`${PAGES[j.p]} ${j.kind}: picked the degraded copy`);
    if (r.change === j.kind) named++; else misses.push(`${PAGES[j.p]} ${j.kind}: named ${r.change}`);
  });
  return out({ suite: "degraded", pass: picked >= 15 && named >= 12, picked_original: `${picked}/${jobs.length}`, named_change: `${named}/${jobs.length}`, bars: "15/16 and 12/16", misses });
}

// ---- fixes: the pairwise check accepts good fixes and rejects bad ones ------------------------------------------------------
// Each case's patch.css makes the page worse. A good case is the patched page as BEFORE and the starter as AFTER (the fix
// removes the defect); a bad case is the starter as BEFORE and the patched page as AFTER (the "fix" adds it).
async function fixes() {
  const dir = o.cases ? resolve(o.cases) : join(here, "fixes");
  const cases = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .map((name) => ({ name, ...json(join(dir, name, "expect.json")) as { side: "before" | "after"; page: string; width: number; theme: "light" | "dark" }, css: readFileSync(join(dir, name, "patch.css"), "utf8") }));
  const shot = (c: { name: string }, k: string) => join(work, "fixes", c.name, `${k}.png`);
  for (const c of cases) {
    if (existsSync(shot(c, "orig")) && existsSync(shot(c, "patched"))) continue;
    const s = await open((await starterUrl()) + c.page, { width: c.width, theme: c.theme });
    await s.shot(shot(c, "orig"));
    // a constructed stylesheet: the starter's CSP refuses a <style> tag
    await s.page.evaluate((css: string) => { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; }, c.css);
    await s.page.waitForTimeout(500);
    await s.shot(shot(c, "patched"));
    await s.close();
  }
  if (o["capture-only"]) return out({ suite: "fixes", pass: true, captured: cases.length * 2 });
  const tally = { good: [0, 0], bad: [0, 0] }; // [accepted sample-orders, asked]
  const per: Record<string, string> = {};
  await pool(cases, 3, async (c) => {
    const [before, after] = c.side === "before" ? [shot(c, "patched"), shot(c, "orig")] : [shot(c, "orig"), shot(c, "patched")];
    const r = await fixCheck({ before, after, width: c.width, model }) as { wins: [number, number]; accepted: boolean };
    const t = tally[c.name.startsWith("good-") ? "good" : "bad"];
    t[0] += r.wins[0] + r.wins[1]; t[1] += 6;
    per[c.name] = `${r.wins[0]}/3 + ${r.wins[1]}/3${r.accepted ? " accepted" : " rejected"}`;
  });
  // The plan's bars are per 18 sample-orders (good >= 16, bad <= 1); the set asks 6 per case, so they are kept as ratios.
  const good = tally.good[0] / tally.good[1], bad = tally.bad[0] / tally.bad[1];
  return out({ suite: "fixes", pass: good >= 16 / 18 && bad <= 1 / 18, good_accepted: `${tally.good[0]}/${tally.good[1]}`, bad_accepted: `${tally.bad[0]}/${tally.bad[1]}`, bars: "good >= 16/18, bad <= 1/18 (as ratios)", per_case: per });
}

// ---- calibrate: the reviewer's order of rated products against the owner's ---------------------------------------------------
type Rated = { items: { id: string; kind: "site" | "app"; urls: string[]; score: number }[] };
const avgRanks = (x: number[]) => x.map((v) => { const lt = x.filter((y) => y < v).length, eq = x.filter((y) => y === v).length; return lt + (eq + 1) / 2; });
const pearson = (a: number[], b: number[]) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  const n = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  return n / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0));
};
const spearman = (a: number[], b: number[]) => pearson(avgRanks(a), avgRanks(b));

async function calibrate() {
  if (!o.rated) throw new Error("calibrate needs --rated <file> (rated.example.json shows the format)");
  const rated = json(o.rated) as Rated;
  for (const it of rated.items) if (it.urls.length > 2) throw new Error(`${it.id}: at most 2 pages per product`);
  const file = (id: string, n: number) => join(work, "calibrate", `${id}-${n}.png`);
  for (const it of rated.items) for (const [n, url] of it.urls.entries()) {
    if (existsSync(file(it.id, n))) continue;
    const s = await open(url, { width: 1512 });
    await s.shot(file(it.id, n));
    await s.close();
  }
  if (o["capture-only"]) return out({ suite: "calibrate", pass: true, captured: rated.items.reduce((s, i) => s + i.urls.length, 0) });
  const system = "You are a senior product designer. You are shown screenshots of several different web products, two pages each (one page for some). Rank the products from best designed to worst designed: visual polish, hierarchy, consistency and ease of use for a non-technical person. Judge only what the screenshots show. Answer with only the JSON the schema asks for.";
  const samples = Number(o.samples ?? 3);
  const sum = new Map(rated.items.map((i) => [i.id, 0]));
  for (let s = 0; s < samples; s++) {
    const rand = rng(77 + s);
    const order = rated.items.map((i) => i).sort(() => rand() - 0.5);
    const letter = (k: number) => String.fromCharCode(65 + k);
    const text = `Products, in the order of the images (${order.reduce((n, i) => n + i.urls.length, 0)} images):\n${order.map((it, k) => `- Product ${letter(k)}: ${it.urls.length} image${it.urls.length > 1 ? "s" : ""}`).join("\n")}`;
    const schema = { type: "object", additionalProperties: false, required: ["order"], properties: { order: { type: "array", items: { type: "string", enum: order.map((_, k) => letter(k)) } } } };
    const validate = (a: unknown) => { const l = (a as { order?: string[] })?.order ?? []; if (l.length !== order.length || new Set(l).size !== order.length) throw new Error(`"order" must list each of the ${order.length} products once`); };
    const r = await ask({ model, system, text, schema, validate, images: order.flatMap((it) => it.urls.map((_, n) => file(it.id, n))) }) as { order: string[] };
    r.order.forEach((l, pos) => { const id = order[l.charCodeAt(0) - 65].id; sum.set(id, (sum.get(id) as number) + pos + 1); });
  }
  const position = rated.items.map((i) => (sum.get(i.id) as number) / samples); // average place, 1 = best
  const rho = spearman(position.map((p) => -p), rated.items.map((i) => i.score));
  const sites = rated.items.flatMap((it, k) => it.kind === "site" ? [position[k]] : []);
  const appsBelow = rated.items.every((it, k) => it.kind !== "app" || sites.every((p) => position[k] > p));
  return out({ suite: "calibrate", pass: rho >= 0.6 && appsBelow, spearman_rho: Math.round(rho * 100) / 100, apps_below_every_site: appsBelow, bars: "rho >= 0.6 and the owner's apps below every site", order: rated.items.map((it, k) => [it.id, position[k]]).sort((a, b) => (a[1] as number) - (b[1] as number)).map(([id]) => id) });
}

// ---- references and corrections run the engine's own commands over a captured app ---------------------------------------------
type Report = { improvements: { where: { page: string; region: string }; weak: string; change: string; why: string; best: string }[]; cost_usd: number };
const concrete = /\d+(\.\d+)?\s*(px|rem|em|%|ms)|#[0-9a-f]{3,8}\b|\b\d{2,4}\b/i;

/** A page: its path, or `{ path, kind }` (a targets file may name the kind; the starter's pages have theirs in KINDS). */
type Target = string | { path: string; kind?: string };
function capture(url: string, pages: Target[], dir: string, width = 1512, theme = "light") {
  if (existsSync(join(dir, "report.json"))) return;
  mkdirSync(dir, { recursive: true });
  const list = pages.map((p) => typeof p === "string" ? { path: p, kind: KINDS[p] } : p).map((p) => ({ path: p.path, ...(p.kind ? { kind: p.kind } : {}) }));
  writeFileSync(join(dir, "pages-in.json"), JSON.stringify({ pages: list }));
  cli("capture", url, "--out", dir, "--pages-file", join(dir, "pages-in.json"), "--widths", String(width), "--themes", theme);
}

/** refs/fallback.json's page per kind as a references list on the served starter, written beside the work. */
async function fallbackList(file: string): Promise<string> {
  const base = await starterUrl();
  const map = json(file) as Record<string, string>;
  const out = join(work, "references", "fallback-refs.json");
  writeFileSync(out, JSON.stringify(Object.entries(map).filter(([k]) => k !== "_" && k !== "other").map(([kind, path]) => ({ kind, url: new URL(path, base).href, product: "app starter" }))));
  return out;
}

async function references() {
  const targets = o.targets ? json(o.targets) as { name: string; url: string; pages: Target[] }[] : null;
  const refsIn = { references: o.refs ?? join(ENGINE, "refs/references.json"), fallback: o.fallback ?? join(ENGINE, "refs/fallback.json") };
  const rated = o.rated ? (json(o.rated) as Rated).items : [];
  const list = targets ?? [{ name: "starter", url: "", pages: PAGES }];
  const variants: Record<string, { n: number; specific: number; tokens: number; perTarget: Record<string, number> }> = {};
  for (const t of list) {
    // The browser part (the app's captures and each variant's reference pages) is skipped when its files are in --work already,
    // so it can run where Chrome is and the reviews where the key is.
    const base = join(work, "references", t.name);
    if (!existsSync(join(base, "report.json"))) capture(t.url || await starterUrl(), t.pages, base);
    for (const [v, refs] of Object.entries(refsIn)) {
      const dir = join(work, "references", `${t.name}-${v}`);
      if (!existsSync(join(dir, "report.json"))) cpSync(base, dir, { recursive: true });
      // The fallback variant: the app starter's own page per kind (refs/fallback.json maps a kind to it) as the only references.
      if (!existsSync(join(dir, "refs", "refs.json"))) cli("refs", v === "fallback" ? await fallbackList(refs) : refs, "--out", join(dir, "refs"));
    }
    if (o["capture-only"]) continue;
    for (const v of Object.keys(refsIn)) {
      const dir = join(work, "references", `${t.name}-${v}`);
      cli("review", dir, "--model", model, "--refs", join(dir, "refs", "refs.json"), "--top", "10");
      const rep = json(join(dir, "report.json")) as Report;
      const tokens = (json(join(dir, "refs", "refs.json")) as { product?: string; tokens?: Record<string, unknown> }[]).flatMap((r) => [r.product, ...Object.values(r.tokens ?? {}).flat()].filter((x) => x !== undefined).map(String));
      const m = (variants[v] ??= { n: 0, specific: 0, tokens: 0, perTarget: {} });
      m.perTarget[t.name] = rep.improvements.length;
      spend.usd += rep.cost_usd;
      for (const i of rep.improvements) {
        m.n++;
        if (i.where.page && i.where.region && concrete.test(i.change)) m.specific++;
        if (tokens.some((k) => k.length > 1 && `${i.change} ${i.best}`.includes(k))) m.tokens++;
      }
    }
  }
  if (o["capture-only"]) return out({ suite: "references", pass: true, captured: list.length });
  const report = Object.fromEntries(Object.entries(variants).map(([v, m]) => {
    const names = Object.keys(m.perTarget).filter((n) => rated.some((r) => r.id === n));
    // The reviewer emits no scores: fewer improvements stand in for a better design when comparing with the owner's order.
    const rho = names.length >= 3 ? spearman(names.map((n) => -m.perTarget[n]), names.map((n) => rated.find((r) => r.id === n)!.score)) : null;
    return [v, { improvements: m.n, specificity: m.n ? Math.round((m.specific / m.n) * 100) / 100 : null, names_a_reference_token: m.n ? Math.round((m.tokens / m.n) * 100) / 100 : null, rank_agreement: rho === null ? null : Math.round(rho * 100) / 100 }];
  }));
  return out({ suite: "references", pass: true, bars: "none until the first run", ...report });
}

async function corrections() {
  if (!o.cases) throw new Error("corrections needs --cases <dir> (the instance's design/eval/corrections)");
  const dir = resolve(o.cases);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (files.length === 0) throw new Error(`no correction cases in ${dir}: record one per owner correction before this suite can mean anything`);
  type Case = { url: string; page: string; width: number; theme: "light" | "dark"; expect: { where: string; change: string } };
  const cases = files.map((f) => ({ f, ...json(join(dir, f)) as Case }));
  for (const c of cases) capture(c.url, [c.page], join(work, "corrections", c.f), c.width, c.theme);
  if (o["capture-only"]) return out({ suite: "corrections", pass: true, captured: cases.length });
  const missed: string[] = [];
  for (const c of cases) {
    const d = join(work, "corrections", c.f);
    cli("review", d, "--model", model, "--top", "10");
    const rep = json(join(d, "report.json")) as Report;
    spend.usd += rep.cost_usd;
    const hit = rep.improvements.some((i) => new RegExp(c.expect.where, "i").test(`${i.where.page} ${i.where.region}`) && new RegExp(c.expect.change, "i").test(`${i.change} ${i.weak} ${i.why}`));
    if (!hit) missed.push(c.f);
  }
  return out({ suite: "corrections", pass: missed.length === 0, found: `${cases.length - missed.length}/${cases.length}`, missed });
}

const suites: Record<string, () => Promise<boolean | Record<string, unknown>>> = { degraded, fixes, references, calibrate, corrections };
try {
  if (!suite || !(suite in suites)) { console.error("usage: node run.ts degraded|fixes|references|calibrate|corrections [--model m] [--rated file] [--cases dir] [--work dir] [--capture-only]"); process.exitCode = 2; }
  else if (!(await suites[suite]())) process.exitCode = 1;
} catch (e) {
  console.error(`design-eval ${suite}: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await shutdown();
}
