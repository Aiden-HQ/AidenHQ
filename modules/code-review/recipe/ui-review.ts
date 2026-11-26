#!/usr/bin/env node
// The ui.scan option's model step (check job `code-review-ui-review`, module.yaml): the design review of the captures the token-free
// capture step (`code-review-ui`, recipe/ui.ts) left. Docs: docs/design/code-review.md "UI scan".
//
// The box holds the run's model token, the commit's tree (the workspace) and the spec at $AIDENHQ_SPEC: { repo, head, base (the head
// itself), run, option, model, ui } with `ui` the capture's bundle at /aidenhq-out/ui (a gzipped tar the service handed over from the
// capture check's kept file). Repo code never runs here: no install, no start, no repo config. The bundle was made in the box that
// ran the repo's code, so it is untrusted data: it is unpacked by this file's own reader (regular files only, an exact list of names,
// none outside the work folder), every shot the report names must be a plain file name, and `ui-review review` reads only that folder.
// The engine's report.json then becomes the shared Review (toReview): improvements as nits ranked by the engine, blocking rule
// findings and the route check's verified bugs as important, pages as coverage counts. No rendered fixes at scan depth.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { run, stopped } from "./proc.ts";
import { bound } from "./review.ts";
import { toolEnv } from "./tools.ts";

/** The spec ($AIDENHQ_SPEC) of the `code-review-ui-review` check (`ui`: the bundle's sha256; the file is at /aidenhq-out/ui). */
export interface UiReviewSpec { repo?: string; head: string; base: string; run?: string; option: string; model: string; ui?: string }
/** The part of the engine's report.json (ui-review's types.ts `Report`, version 2) this recipe reads. */
export interface UiReport {
  coverage?: { done: number; total: number; failed: number; deferred: number };
  captures: { page: string; width: number; theme: "light" | "dark"; state?: string; shots?: string[]; rules: { rule: string; blocking: boolean; text: string }[] }[];
  improvements: { rank: number; where: { page: string; width: number; theme: "light" | "dark"; region: string }; weak: string; change: string; why: string; best: string; captures: string[] }[];
  bugs: { page: string; width: number; theme: "light" | "dark"; title: string; evidence: string; captures: string[]; verified: boolean }[];
  cost_usd: number;
  notes?: string[];
  /** The capture step's pages left out of the bundle to fit a check input (recipe/ui.ts). */
  dropped?: string[];
}

/** The option's spend cap in dollars: catalog.json `run.max_cost_usd` (a check's spec carries four fields only, so the recipe holds it; keep the two equal). */
const MAX_USD = 10;
/** What the result keeps (it stays under the kernel's 256 KB): the top improvements, and at most this many rule and bug findings. */
const TOP = 10, MAX_RULES = 20;
const cut = (t: unknown, n: number) => String(t ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, n);

// The bundle: a gzipped ustar of regular files, named only as below (a shot is a plain file name, never a path).
const SHOT = /^[A-Za-z0-9_][\w.-]*\.png$/;
const BUNDLED = new Set(["report.json", "run.json", "queue.json", "routes/report.json"]);
const bundled = (name: string) => BUNDLED.has(name) || SHOT.test(name);
/** The most the bundle unpacks to (its packed size is at most the kernel's 64 MB input; the text in it compresses). */
const UNPACKED_MAX = 256 << 20;

/** The bundle of `files` (bundle name → bytes): a gzipped tar. */
export function pack(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of files) {
    if (!bundled(name) || Buffer.byteLength(name) > 100) throw new Error(`not a bundle file: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124); h.write("00000000000\0", 136);
    h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    h.write(`${h.reduce((n, b) => n + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** Unpacks the bundle into `dir` (a fresh folder): regular files with the bundle's names only; anything else fails it. */
export function unpack(gz: Buffer, dir: string) {
  const tar = gunzipSync(gz, { maxOutputLength: UNPACKED_MAX });
  const str = (a: number, b: number) => tar.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
  mkdirSync(join(dir, "routes"), { recursive: true });
  for (let at = 0; at + 512 <= tar.length;) {
    if (tar.subarray(at, at + 512).every((b) => b === 0)) return;
    const name = str(at, at + 100), size = parseInt(str(at + 124, at + 136).trim() || "x", 8), type = tar[at + 156];
    if ((type !== 0x30 && type !== 0) || str(at + 345, at + 500) || !bundled(name) || !Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length)
      throw new Error(`the capture's bundle holds an entry that isn't one of its files (${cut(name, 100)})`);
    writeFileSync(join(dir, name), tar.subarray(at + 512, at + 512 + size), { flag: "wx" });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("the capture's bundle is cut short");
}

/** The source file a change names (a path of the checkout in its words), else the page's path. */
function sourceOf(change: string, page: string, root?: string) {
  for (const m of change.matchAll(/[\w@.\-/]+\.(?:tsx|ts|jsx|js|vue|svelte|astro|css|scss|html)\b/g)) {
    const p = m[0].replace(/^\.\//, "");
    if (!root || (!p.startsWith("/") && !p.split("/").includes("..") && existsSync(join(root, p)))) return p;
  }
  return page;
}

/**
 * The engine's report as the shared Review (a tree's, version 1) the service validates. `listed`: every page the run was to capture
 * (the engine's queue); `routes`: the route check's report, whose blocking hits and verified bugs are findings too; `root`: the
 * checkout, to confirm a source file a change names (its existence only: read as data, never run).
 */
export function toReview(report: UiReport, o: { model: string; repo?: string; head?: string; listed?: string[]; routes?: UiReport; root?: string }) {
  // A page the model's review failed on or the spend cap skipped (the engine's notes say which) is not reviewed: a gap.
  const notes = Array.isArray(report.notes) ? report.notes.filter((n): n is string => typeof n === "string") : [];
  const unreviewed = new Set(notes.flatMap((n) => /^design review of (.+?) failed: /.exec(n)?.[1] ?? /^stopped at the --max-usd budget; not reviewed: (.+)$/.exec(n)?.[1]?.split(", ").filter((p) => !p.endsWith(" (motion)")) ?? []));
  const pages = [...new Set(report.captures.map((c) => c.page))];
  const captured = pages.filter((p) => !unreviewed.has(p)), skipped = pages.filter((p) => unreviewed.has(p));
  const listed = [...new Set([...(o.listed ?? []), ...pages])];
  const excluded = listed.filter((p) => !captured.includes(p));
  const dropped = (report.dropped ?? []).filter((p) => excluded.includes(p)), missed = excluded.filter((p) => !dropped.includes(p) && !skipped.includes(p));
  const some = (ps: string[]) => `${ps.slice(0, 3).join(", ")}${ps.length > 3 ? ", …" : ""}`;
  const at = (x: { page: string; width: number; theme: "light" | "dark" }, region: string, change = "", best = "") => ({ page: x.page, width: x.width, theme: x.theme, region, change, best });

  const improvements = [...report.improvements].sort((a, z) => a.rank - z.rank);
  const top = improvements.slice(0, TOP).map((i) => ({
    id: `ui-${i.rank}`, severity: "nit" as const, path: sourceOf(i.change, i.where.page, o.root), line: 0, title: cut(i.weak, 300), why: cut(i.why, 1500),
    evidence: cut(i.captures.join(", "), 600), fix_brief: cut(i.change, 1500), option: "ui.scan", lens: "ui", ui: at(i.where, cut(i.where.region, 200), cut(i.change, 1500), cut(i.best, 800)),
  }));

  // Blocking rule hits (the capture's and the route check's: page errors, axe, blank routes) and verified bugs are important; a
  // suspected (unverified) bug is a nit. One of each rule, page and text.
  const seen = new Map<string, number>();
  const rules: { severity: "important" | "nit"; title: string; why: string; evidence: string; ui: ReturnType<typeof at> }[] = [];
  // A bug seen both verified and not is the verified one.
  const add = (key: string, f: (typeof rules)[number]) => {
    const at = seen.get(key);
    if (at === undefined) { seen.set(key, rules.length); rules.push(f); } else if (f.severity === "important" && rules[at]!.severity === "nit") rules[at] = f;
  };
  for (const r of [report, ...(o.routes ? [o.routes] : [])]) {
    for (const c of r.captures) for (const h of c.rules) if (h.blocking) add(`${h.rule}|${c.page}|${h.text}`, { severity: "important", title: cut(h.rule, 200), why: cut(h.text, 1500), evidence: "", ui: at(c, cut(h.rule, 200)) });
    for (const b of r.bugs) add(`bug|${b.page}|${b.title}`, { severity: b.verified ? "important" : "nit", title: cut(b.title, 300), why: cut(b.evidence, 1500), evidence: cut(b.captures.join(", "), 600), ui: at(b, "bug") });
  }
  rules.sort((a, z) => Number(z.severity === "important") - Number(a.severity === "important"));
  const keptRules = rules.slice(0, MAX_RULES);
  const lostRules = rules.slice(MAX_RULES);
  const ruleFindings = keptRules.map((f, n) => ({ id: `ui-rule-${n + 1}`, severity: f.severity, path: f.ui.page, line: 0, title: f.title, why: f.why, evidence: f.evidence, fix_brief: "", option: "ui.scan", lens: "ui", ui: f.ui }));

  const cov = report.coverage;
  const gaps = [
    ...(pages.length ? [] : ["no page was captured"]),
    ...(skipped.length ? [`${skipped.length} captured pages not reviewed by the model (${some(skipped)})`] : []),
    ...(missed.length ? [`${missed.length} of ${listed.length} pages not captured (${some(missed)})`] : []),
    ...(dropped.length ? [`${dropped.length} of ${listed.length} pages captured but left out of the review to fit a check input (${some(dropped)})`] : []),
    ...(cov && (cov.failed || cov.deferred) ? [`${cov.failed} captures failed, ${cov.deferred} deferred`] : []),
    ...(lostRules.some((f) => f.severity === "important") ? [`${lostRules.filter((f) => f.severity === "important").length} blocking findings left out to fit the result`] : []),
  ];
  const result = {
    version: 1, ...(o.repo !== undefined ? { repo: o.repo } : {}), ...(o.head !== undefined ? { head: o.head, base: o.head } : {}), target: "tree", engine: "ui-review", model: o.model, effort: "low", pr: 0, incremental_from: null, full: true, addressed: false,
    coverage: { reviewed: captured, excluded, incomplete: gaps.join("; ").slice(0, 500) || null, counts: { eligible: listed.length, reviewed: captured.length } },
    findings: [...ruleFindings, ...top], fixed: [] as string[],
    withheld: { important: 0, nit: improvements.length - top.length + lostRules.filter((f) => f.severity === "nit").length, pre_existing: 0 },
    cost_usd: report.cost_usd, stale_guidance: [] as string[], guidance: [] as string[],
  };
  return bound(result as never) as unknown as typeof result;
}

/** The engine's pages as the queue lists them (queue.json: one item per page, width, theme and state), as page paths. */
function listedPages(dir: string): string[] {
  try {
    const q = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as unknown;
    return [...new Set((Array.isArray(q) ? q as { page?: unknown }[] : []).map((i) => i.page).filter((p): p is string => typeof p === "string"))];
  } catch { return []; }
}
const readReport = (file: string) => { try { return JSON.parse(readFileSync(file, "utf8")) as UiReport; } catch { return undefined; } };

/** Unpacks the bundle `ui` and reviews it with the model: the Review. */
export async function review({ spec, ui, ws, env = process.env }: { spec: UiReviewSpec; ui: string; ws: string; env?: NodeJS.ProcessEnv }) {
  const tmp = mkdtempSync(join(env.TMPDIR || "/tmp", "ui-review-"));
  const dir = join(tmp, "ui");
  unpack(readFileSync(ui), dir);
  const captured = readReport(join(dir, "report.json"));
  if (!captured || !Array.isArray(captured.captures)) throw new Error("the capture's bundle has no report.json");
  // `review` opens each capture's shots by name in its folder: a name that is not a plain file name is refused, never opened.
  if (captured.captures.some((c) => !Array.isArray(c.shots) || c.shots.some((s) => typeof s !== "string" || !SHOT.test(s)))) throw new Error("the capture's report names a shot that isn't a file of its bundle");
  // The engine gets the tool allowlist's environment and the run's model token, and works in the bundle's folder only.
  const modelEnv = { ...toolEnv(env, tmp), OPENROUTER_API_KEY: String(env.OPENROUTER_API_KEY ?? ""), OPENROUTER_BASE_URL: String(env.OPENROUTER_BASE_URL ?? "") };
  const r = await run("ui-review", ["review", dir, "--model", spec.model, "--max-usd", String(MAX_USD)], { cwd: dir, env: modelEnv, minutes: 18 });
  if (r.code !== 0) throw new Error(`ui-review review: ${stopped(r)}${r.stderr.trim() ? `; ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}` : ""}`);
  const report = readReport(join(dir, "report.json"));
  if (!report) throw new Error("ui-review review left no report.json");
  return toReview(report, { model: spec.model, repo: spec.repo, head: spec.head, listed: listedPages(dir), routes: readReport(join(dir, "routes", "report.json")), root: ws });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const specFile = process.env.AIDENHQ_SPEC, resultFile = process.env.AIDENHQ_RESULT;
  try {
    const spec = JSON.parse(readFileSync(specFile!, "utf8")) as UiReviewSpec;
    const r = await review({ spec, ui: join(specFile!, "..", "ui"), ws: process.cwd() });
    writeFileSync(resultFile!, JSON.stringify(r));
    console.error(`code-review-ui-review: ${r.findings.length} findings (${r.coverage.counts.reviewed} of ${r.coverage.counts.eligible} pages${r.coverage.incomplete ? `; incomplete: ${r.coverage.incomplete}` : ""})`);
  } catch (e) {
    console.error(`code-review-ui-review: no result: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300)}`);
    process.exit(1);
  }
}
