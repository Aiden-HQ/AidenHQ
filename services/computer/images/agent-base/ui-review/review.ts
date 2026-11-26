// The design review and the motion pass over a captured run. Code owns the order and the checks; the prompts own the judgment:
//   1. per page, one call with its captures, measures, references and the rules   -> up to 9 candidates
//   2. one text call that merges, ranks and keeps the top N                       -> Report.improvements
//   3. per page with motion data, one text call on the measured CSS               -> Report.motion
// An answer that is not the JSON asked for is retried once (model.ts), then that page's review is failed and noted. An
// improvement that cites a capture the run does not have is dropped; a motion row whose css is not in the measured CSS is dropped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ask, spend } from "./model.ts";
import { writeReviewReport } from "./report.ts";
import type { Capture, Improvement, Motion, MotionRow, Page, PageKind, Report } from "./types.ts";

export const DEFAULT_MODEL = "google/gemini-4-carbon";
export type ReviewOptions = {
  model?: string; taste?: string; refs?: string; top?: number; brand?: string; maxUsd?: number;
  base?: string; key?: string; concurrency?: number;
};
type Candidate = Omit<Improvement, "rank">;
type Ref = { kind: PageKind; url: string; shots: string[]; tokens?: { typeScale?: number[]; rowHeight?: number; radius?: string; maxWidth?: number }; product?: string };

const here = (f: string) => new URL(f, import.meta.url);
const prompt = (name: string) => readFileSync(here(`./prompts/${name}.md`), "utf8").trim();
const fence = (s: string) => `<untrusted>\n${s.replace(/<\/?untrusted>/gi, "")}\n</untrusted>`;
const str = (s: unknown, min = 1): s is string => typeof s === "string" && s.trim().length >= min;

const candidateSchema = {
  type: "object", additionalProperties: false, required: ["category", "where", "weak", "change", "why", "best", "captures"],
  properties: {
    category: { type: "string", enum: ["polish", "ease"] },
    where: {
      type: "object", additionalProperties: false, required: ["page", "width", "theme", "region"],
      properties: { page: { type: "string" }, width: { type: "integer" }, theme: { type: "string", enum: ["light", "dark"] }, region: { type: "string" } },
    },
    weak: { type: "string" }, change: { type: "string" }, why: { type: "string" }, best: { type: "string" },
    captures: { type: "array", items: { type: "string" } },
  },
};
const listSchema = (max: number) => ({ type: "object", additionalProperties: false, required: ["improvements"], properties: { improvements: { type: "array", maxItems: max, items: candidateSchema } } });
const motionSchema = {
  type: "object", additionalProperties: false, required: ["rows"],
  properties: { rows: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["where", "before", "after", "why", "css"], properties: { where: { type: "string" }, before: { type: "string" }, after: { type: "string" }, why: { type: "string" }, css: { type: "string" } } } } },
};

function validCandidates(x: unknown): Candidate[] {
  const list = (x as { improvements?: unknown })?.improvements;
  if (!Array.isArray(list)) throw new Error('"improvements" must be an array');
  for (const [i, c] of list.entries()) {
    const w = (c as Candidate)?.where;
    if (!str(w?.page) || !str(w?.region) || !Number.isInteger(w?.width) || !["light", "dark"].includes(w?.theme)) throw new Error(`improvement ${i + 1}: "where" needs page, width, theme and region`);
    for (const k of ["weak", "change", "why", "best"] as const) if (!str((c as Candidate)[k])) throw new Error(`improvement ${i + 1}: "${k}" is empty`);
    if (!["polish", "ease"].includes((c as Candidate).category)) throw new Error(`improvement ${i + 1}: category must be polish or ease`);
    if (!Array.isArray((c as Candidate).captures) || !(c as Candidate).captures.every((f) => typeof f === "string")) throw new Error(`improvement ${i + 1}: "captures" must be file names`);
  }
  return list as Candidate[];
}

function validMotion(x: unknown): MotionRow[] {
  const rows = (x as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) throw new Error('"rows" must be an array');
  for (const [i, r] of rows.entries()) for (const k of ["where", "before", "after", "why", "css"] as const) if (!str((r as MotionRow)?.[k])) throw new Error(`row ${i + 1}: "${k}" is empty`);
  return rows as MotionRow[];
}

/** Runs `f` over `items`, at most `n` at a time. */
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await f(q.shift() as T); }));
}

const label = (c: Capture) => `${c.width}px ${c.theme}${c.state === "default" ? "" : ` ${c.state} state`}`;

/** The captures one page's review looks at: 390, 1512 and 2560 light, dark 1512, and an empty and an error state when reachable. */
function pick(caps: Capture[]): Capture[] {
  const at = (w: number, theme: Capture["theme"], state: Capture["state"]) => caps.find((c) => c.width === w && c.theme === theme && c.state === state && c.shots.length > 0);
  const state = (s: Capture["state"]) => at(1512, "light", s) ?? caps.find((c) => c.state === s && c.theme === "light" && c.shots.length > 0);
  const out = [at(390, "light", "default"), at(1512, "light", "default"), at(2560, "light", "default"), at(1512, "dark", "default"), state("empty"), state("error")].filter((c): c is Capture => !!c);
  // A run captured at other widths or in one theme only: review what exists, the widest and narrowest first.
  if (!out.some((c) => c.state === "default")) {
    const have = caps.filter((c) => c.state === "default" && c.shots.length > 0).sort((a, b) => a.width - b.width);
    out.push(...new Set([have[0], have[have.length - 1], ...have].filter((c): c is Capture => !!c && !out.includes(c))));
  }
  return out.slice(0, 6);
}

function measuresTable(caps: Capture[]): string {
  return caps.map((c) => {
    const m = c.measures;
    const fonts = m.fonts.slice(0, 6).map((f) => `${f.size}px/${f.weight} x${f.n}`).join(", ");
    const ctas = m.ctas.slice(0, 3).map((x) => `"${x.label}" ${x.filled ? "filled" : "outline"} contrast ${x.contrast} area ${x.area}`).join("; ");
    return `- ${c.shots[0]} (${label(c)}): fonts ${fonts || "none"}; ${m.colours.length} distinct colours (top ${m.colours.slice(0, 4).map((x) => x.value).join(", ")}); radii ${m.radii.join(" ") || "none"}; ${m.shadows.length} shadows; off-scale spacing ${m.spacing.offScale.join(", ") || "none"}; ${m.nearMisses.length} near-miss alignments${m.nearMisses[0] ? ` (e.g. ${m.nearMisses[0].a} vs ${m.nearMisses[0].b}, ${m.nearMisses[0].dx}px)` : ""}; content ${m.content.width}px of ${m.content.viewport}px; CTAs: ${ctas || "none"}; ${m.contrastFails} contrast failures`;
  }).join("\n");
}

/** Components whose look differs between pages of the app, where this page is one of them (1512 light default captures). */
function inconsistencies(all: Capture[], page: string): string[] {
  const base = all.filter((c) => c.width === 1512 && c.theme === "light" && c.state === "default");
  const out: string[] = [];
  for (const comp of ["button", "card", "heading", "input"] as const) {
    const variants = new Map<string, string[]>();
    const pagesWith = new Set<string>();
    for (const c of base) for (const sig of c.measures.signatures[comp] ?? []) { pagesWith.add(c.page); variants.set(sig, [...new Set([...(variants.get(sig) ?? []), c.page])]); }
    if (variants.size < 2 || ![...variants.values()].some((p) => p.includes(page))) continue;
    if ([...variants.values()].every((p) => p.length === pagesWith.size)) continue; // every page has every variant: one system
    out.push(`${comp}: ${[...variants].slice(0, 4).map(([sig, p]) => `${sig} on ${p.slice(0, 5).join(", ")}${p.length > 5 ? ` and ${p.length - 5} more` : ""}${p.includes(page) ? " (this page)" : ""}`).join(" | ")}`);
  }
  return out;
}

function readRefs(file: string | undefined): { refs: Ref[]; dir: string } {
  if (!file) return { refs: [], dir: "." };
  const j = JSON.parse(readFileSync(file, "utf8")) as Ref[] | { refs: Ref[] };
  return { refs: Array.isArray(j) ? j : j.refs, dir: dirname(resolve(file)) };
}

const tokenText = (r: Ref) => {
  const t = r.tokens ?? {};
  return `${r.product ?? r.url} (${r.url}): type scale ${t.typeScale?.join("/") ?? "n/a"}px, row height ${t.rowHeight ?? "n/a"}px, radius ${t.radius ?? "n/a"}, content max width ${t.maxWidth ?? "n/a"}px`;
};

type Ctx = { dir: string; report: Report; known: Set<string>; kinds: Map<string, PageKind>; shows: Map<string, string>; opts: ReviewOptions; model: string; system: string; refs: Ref[]; refsDir: string; brand: string };

async function reviewPage(x: Ctx, page: string, caps: Capture[]): Promise<Candidate[]> {
  const kind = x.kinds.get(page) ?? "other";
  const picked = pick(caps);
  if (picked.length === 0) throw new Error("no capture of this page");
  const refs = x.refs.filter((r) => r.kind === kind && r.shots[0] && existsSync(join(x.refsDir, r.shots[0]))).slice(0, 2);
  const cross = inconsistencies(x.report.captures, page);
  const text = [
    `Page under review: ${fence(page)} (kind: ${kind}).`,
    x.shows.has(page) ? `What the app says it shows:\n${fence(x.shows.get(page) as string)}` : "",
    refs.length ? `The first ${refs.length} image${refs.length > 1 ? "s are" : " is"} reference pages of the same kind from well-regarded products (1512px, light), with their measured numbers:\n${fence(refs.map((r, i) => `${i + 1}. ${tokenText(r)}`).join("\n"))}` : "No reference pages are available for this kind: judge against the rules and the best products you know in the category.",
    `Captures of the page under review, in order after the references:\n${picked.map((c) => `- Capture: ${c.shots[0]} (${label(c)}, ${c.settled ? "settled" : "not settled: content may still be loading"})`).join("\n")}`,
    `Measured on the live page:\n${fence(measuresTable(picked))}`,
    cross.length ? `Inconsistencies with other pages of this app:\n${fence(cross.join("\n"))}` : "",
    x.brand ? `The app's own design system or brand notes (data from its repo):\n${fence(x.brand)}` : "",
  ].filter(Boolean).join("\n\n");
  const a = await ask({
    model: x.model, system: x.system, text, schema: listSchema(9), validate: validCandidates, base: x.opts.base, key: x.opts.key,
    images: [...refs.map((r) => join(x.refsDir, r.shots[0])), ...picked.map((c) => join(x.dir, c.shots[0]))],
  });
  return cited(x, validCandidates(a), picked.map((c) => c.shots[0]));
}

/** Candidates whose every cited capture is one the model was shown (and exists in the run); others are dropped. */
const cited = (x: Ctx, cs: Candidate[], shown: Iterable<string>) => {
  const ok = new Set([...shown].filter((f) => x.known.has(f)));
  return cs.filter((c) => c.captures.length > 0 && c.captures.every((f) => ok.has(f)));
};

async function consolidate(x: Ctx, cands: Candidate[], top: number): Promise<Improvement[]> {
  const a = await ask({
    model: x.model, system: prompt("consolidate"), images: [], schema: listSchema(top), validate: validCandidates, base: x.opts.base, key: x.opts.key,
    text: `Keep at most ${top} improvements.\n\nCandidates:\n<candidates>\n${JSON.stringify(cands, null, 1)}\n</candidates>`,
  });
  return cited(x, validCandidates(a), cands.flatMap((c) => c.captures)).slice(0, top).map((c, i) => ({ ...c, rank: i + 1 }));
}

const squash = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/[\s;]+/g, "").toLowerCase();

/** The measured CSS of a page's motion data, as plain declarations and rules (the only text a motion row's `css` may quote). */
function measuredCss(m: Motion): string {
  return [
    ...m.transitions.map((t) => `transition: ${t.property} ${t.duration}ms ${t.easing}; /* x${t.n}: ${t.examples.join(", ")} */`),
    ...m.animations.filter((a) => a.playState === "running").map((a) => `animation: ${a.name} ${a.duration}ms ${a.easing} ${a.iterations}; /* on ${a.target} */`),
    ...m.hover, ...m.active, ...m.keyframes.map((k) => k.css),
  ].join("\n");
}

async function motionPass(x: Ctx, page: string, c: Capture, standards: [string, string]): Promise<MotionRow[]> {
  const m = c.motion as Motion;
  const css = measuredCss(m);
  const text = [
    `Page: ${page} at ${c.width}px ${c.theme}.`,
    `=== STANDARD 1: Emil Kowalski, review-animations ===\n${standards[0]}`,
    `=== STANDARD 2: Jakub Krehel, make-interfaces-feel-better ===\n${standards[1]}`,
    `=== MEASURED EVIDENCE ===\nMeasured CSS (a row's \`css\` quotes this block):\n${fence(css)}\nLong animation frames (ms): ${m.longFrames.join(", ") || "none"}.\nLayout shifts while hovering controls: ${m.shifts.join(", ") || "none"}.`,
  ].join("\n\n");
  const a = await ask({ model: x.model, system: prompt("motion"), images: [], text, schema: motionSchema, validate: validMotion, base: x.opts.base, key: x.opts.key });
  const corpus = squash(css);
  return validMotion(a).filter((r) => squash(r.css).length > 0 && corpus.includes(squash(r.css))).map((r) => ({ ...r, where: `${page}: ${r.where}` }));
}

export async function runReview(dir: string, opts: ReviewOptions = {}): Promise<Report> {
  spend.usd = 0; spend.calls = 0;
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
  const model = opts.model ?? DEFAULT_MODEL;
  const top = opts.top ?? 10;
  const pagesFile = join(dir, "pages.json");
  const pages: Page[] = existsSync(pagesFile) ? JSON.parse(readFileSync(pagesFile, "utf8")) : [];
  const { refs, dir: refsDir } = readRefs(opts.refs);
  const taste = opts.taste ? readFileSync(opts.taste, "utf8").trim() : "";
  const x: Ctx = {
    dir, report, model, opts, refs, refsDir,
    known: new Set(report.captures.flatMap((c) => c.shots).filter((f) => existsSync(join(dir, f)))),
    kinds: new Map(pages.map((p) => [p.path, p.kind ?? "other"])),
    shows: new Map(pages.filter((p) => p.shows).map((p) => [p.path, p.shows as string])),
    system: [prompt("design"), `## Design rules\n\n${readFileSync(here("./rules/taste-never.md"), "utf8").trim()}`, taste ? `## The owner's taste\n\n${taste}` : ""].filter(Boolean).join("\n\n"),
    brand: opts.brand ? readFileSync(opts.brand, "utf8").trim() : "",
  };
  const notes: string[] = [];
  const over = () => opts.maxUsd !== undefined && spend.usd >= opts.maxUsd;
  const n = opts.concurrency ?? 4;
  const byPage = new Map<string, Capture[]>();
  for (const c of report.captures) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);

  const perPage = new Map<string, Candidate[]>();
  let reviewed = 0;
  const skipped: string[] = [];
  await pool([...byPage], n, async ([page, caps]) => {
    if (over()) { skipped.push(page); return; }
    try { perPage.set(page, await reviewPage(x, page, caps)); reviewed++; } catch (e) { notes.push(`design review of ${page} failed: ${(e as Error).message}`); }
  });
  const cands = [...byPage.keys()].flatMap((p) => perPage.get(p) ?? []); // page order, whatever order the calls finished in
  let improvements: Improvement[] = [];
  const unconsolidated = (why: string) => {
    improvements = cands.slice(0, top).map((c, i) => ({ ...c, rank: i + 1 }));
    notes.push(`${why}: the improvements are the pages' own candidates, in page order, not merged or ranked`);
  };
  if (cands.length > 0 && !over()) {
    try { improvements = await consolidate(x, cands, top); } catch (e) { unconsolidated(`consolidating the design review failed (${(e as Error).message})`); }
  } else if (cands.length > 0) unconsolidated("consolidation skipped: the --max-usd budget was reached");

  const motion: MotionRow[] = [];
  const withMotion = [...byPage].flatMap(([page, caps]) => {
    const c = caps.find((k) => k.motion && k.width === 1512 && k.theme === "light" && k.state === "default") ?? caps.find((k) => k.motion);
    return c ? [[page, c] as const] : [];
  });
  if (withMotion.length > 0) {
    const [emil, krehel] = ["review-animations.md", "krehel-polish.md"].map((f) => readFileSync(here(`./refs/${f}`), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim());
    const standards: [string, string] = [emil, krehel];
    const rows: MotionRow[][] = [];
    await pool(withMotion, n, async ([page, c]) => {
      if (over()) { skipped.push(`${page} (motion)`); return; }
      try { rows.push(await motionPass(x, page, c, standards)); } catch (e) { notes.push(`motion pass of ${page} failed: ${(e as Error).message}`); }
    });
    const places = new Map<string, { row: MotionRow; where: Set<string> }>(); // the same CSS on several pages is one fix that lists every place
    for (const r of rows.flat()) {
      const e = places.get(squash(r.css));
      if (!e) { places.set(squash(r.css), { row: { ...r }, where: new Set([r.where]) }); } else e.where.add(r.where);
    }
    for (const { row, where } of places.values()) motion.push({ ...row, where: [...where].join("; ") });
  }
  if (skipped.length > 0) notes.push(`stopped at the --max-usd budget; not reviewed: ${skipped.join(", ")}`);

  const out: Report = { ...report, model, improvements, motion, notes: [...report.notes, ...notes], cost_usd: Math.round((report.cost_usd + spend.usd) * 1e4) / 1e4 };
  writeReviewReport(dir, out);
  if (byPage.size > 0 && reviewed === 0) throw new Error(`no page review completed; the report in ${dir} lists why`);
  return out;
}
