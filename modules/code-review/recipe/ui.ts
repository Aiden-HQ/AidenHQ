#!/usr/bin/env node
// The ui.scan recipe (check job `code-review-ui`, module.yaml): the catalog's UI design scan of a whole repo at a commit, with no agent.
// Docs: docs/design/code-review.md "UI scan".
//
// The box (the engineer image, which carries the `ui-review` engine of the agent-base image) holds the commit's tree (the workspace)
// and the spec at $AIDENHQ_SPEC: { repo, head, base (the head itself), run, option, model }. The steps:
//   1. `codex exec` (Sol, low) with the engine's `prompts/router-read.md` reads the repo, writes the command that starts the app on
//      127.0.0.1:8080 with its seed or demo data to `.aidenhq-ui/run.sh` and the pages to `.aidenhq-ui/pages.json`; run.sh is then
//      started and waited for (180 s).
//   2. `ui-review capture`, `ui-review routes` and `ui-review review <run dir>`: the engine's own commands, the engine's prompts and
//      rules (an unattended scan carries no owner taste). Exit 1 of the first two means blocking findings (the report says which),
//      exit 2 a failed check. Only the review step gets the model token; the app and the capture run with the tool allowlist's env.
//   3. The engine's report.json becomes the shared Review (toReview): improvements as nits ranked by the engine, blocking rule
//      findings as important, pages as coverage counts. No rendered fixes at scan depth; the report to Primer is text.
// The app is the repo's own code: it runs in this box only, as the other options that run code do (catalog `runs_code`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { codexConfig, codexEnv } from "./engines.ts";
import { readSmall, run, stopped } from "./proc.ts";
import { bound } from "./review.ts";
import { toolEnv } from "./tools.ts";

/** The spec ($AIDENHQ_SPEC) of the `code-review-ui` check. */
export interface UiSpec { repo?: string; head: string; base: string; run?: string; option: string; model: string }
/** The part of the engine's report.json (ui-review's types.ts `Report`, version 2) this recipe reads. */
export interface UiReport {
  coverage?: { done: number; total: number; failed: number; deferred: number };
  captures: { page: string; width: number; theme: "light" | "dark"; rules: { rule: string; blocking: boolean; text: string }[] }[];
  improvements: { rank: number; where: { page: string; width: number; theme: "light" | "dark"; region: string }; weak: string; change: string; why: string; best: string; captures: string[] }[];
  bugs: { page: string; width: number; theme: "light" | "dark"; title: string; evidence: string; captures: string[]; verified: boolean }[];
  cost_usd: number;
}

/** The option's spend cap in dollars: catalog.json `run.max_cost_usd` (a check's spec carries four fields only, so the recipe holds it; keep the two equal). */
const MAX_USD = 10;
/** What the result keeps (it stays under the kernel's 256 KB): the top improvements, and at most this many rule and bug findings. */
const TOP = 10, MAX_RULES = 20;
const PORT = 8080, APP_WAIT_MS = 180_000;
const ROUTER_PROMPT = "/opt/aidenhq/ui-review/prompts/router-read.md";
/** The router read's model and effort (Sol, low). */
const ROUTER_MODEL = "openai/gpt-6.2-sol", ROUTER_EFFORT = "low";
const cut = (t: unknown, n: number) => String(t ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, n);

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
 * checkout, to confirm a source file a change names.
 */
export function toReview(report: UiReport, o: { model: string; repo?: string; head?: string; listed?: string[]; routes?: UiReport; root?: string }) {
  const captured = [...new Set(report.captures.map((c) => c.page))];
  const listed = [...new Set([...(o.listed ?? []), ...captured])];
  const excluded = listed.filter((p) => !captured.includes(p));
  const at = (x: { page: string; width: number; theme: "light" | "dark" }, region: string, change = "", best = "") => ({ page: x.page, width: x.width, theme: x.theme, region, change, best });

  const improvements = [...report.improvements].sort((a, z) => a.rank - z.rank);
  const top = improvements.slice(0, TOP).map((i) => ({
    id: `ui-${i.rank}`, severity: "nit" as const, path: sourceOf(i.change, i.where.page, o.root), line: 0, title: cut(i.weak, 300), why: cut(i.why, 1500),
    evidence: cut(i.captures.join(", "), 600), fix_brief: cut(i.change, 1500), option: "ui.scan", lens: "ui", ui: at(i.where, cut(i.where.region, 200), cut(i.change, 1500), cut(i.best, 800)),
  }));

  // Blocking rule hits (the capture's and the route check's: page errors, axe, dead controls, blank routes) and verified bugs are
  // important; a suspected (unverified) bug is a nit. One of each rule, page and text.
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
    ...(captured.length ? [] : ["no page was captured"]),
    ...(excluded.length ? [`${excluded.length} of ${listed.length} pages not captured (${excluded.slice(0, 3).join(", ")}${excluded.length > 3 ? ", …" : ""})`] : []),
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
  return bound(result as never) as typeof result;
}

/** The engine's pages as the queue lists them (queue.json: one item per page, width, theme and state), as page paths. */
function listedPages(dir: string): string[] {
  try {
    const q = JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")) as unknown;
    const items = (Array.isArray(q) ? q : (q as { items?: unknown })?.items) as { page?: unknown }[] | undefined;
    return [...new Set((items ?? []).map((i) => i.page).filter((p): p is string => typeof p === "string"))];
  } catch { return []; }
}
const readReport = (dir: string) => { try { return JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as UiReport; } catch { return undefined; } };

/** Starts the app (`run.sh`, its own process group) and waits for its port: a script that exits first, or no answer in 180 s, fails the run. */
async function startApp(ws: string, env: Record<string, string>) {
  const child = spawn("sh", [join(ws, ".aidenhq-ui", "run.sh")], { cwd: ws, env, stdio: "ignore", detached: true });
  let exited: number | null | undefined;
  child.on("close", (c) => { exited = c; });
  child.on("error", () => { exited = null; });
  const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  const until = Date.now() + APP_WAIT_MS;
  while (Date.now() < until) {
    if (exited !== undefined) throw new Error(`the app's run.sh ended (exit ${exited}) before it answered on port ${PORT}`);
    try { await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) }); return stop; } catch { await new Promise((ok) => setTimeout(ok, 1000)); }
  }
  stop();
  throw new Error(`the app didn't answer on port ${PORT} within ${APP_WAIT_MS / 1000} s`);
}

export async function scan({ spec, ws, out, env = process.env }: { spec: UiSpec; ws: string; out: string; env?: NodeJS.ProcessEnv }) {
  const tmp = mkdtempSync(join(env.TMPDIR || "/tmp", "ui-scan-"));
  const work = join(ws, ".aidenhq-ui"), url = `http://127.0.0.1:${PORT}`, ui = join(out, "ui"), routes = join(out, "ui-routes");
  mkdirSync(work, { recursive: true });
  // The app and the capture get the tool allowlist (no token); only the review step and the router read hold the run's model token.
  const plainEnv = { ...toolEnv(env, tmp), ...(env.AGENT_BROWSER_EXECUTABLE_PATH ? { AGENT_BROWSER_EXECUTABLE_PATH: env.AGENT_BROWSER_EXECUTABLE_PATH } : {}) };
  const modelEnv = { ...plainEnv, OPENROUTER_API_KEY: String(env.OPENROUTER_API_KEY ?? ""), OPENROUTER_BASE_URL: String(env.OPENROUTER_BASE_URL ?? "") };
  const ok = (r: { code: number | null; stderr: string; timedOut: boolean; aborted?: string }, what: string, codes = [0, 1]) => {
    if (!codes.includes(r.code ?? -1)) throw new Error(`${what}: ${stopped(r)}${r.stderr.trim() ? `; ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}` : ""}`);
  };

  // 1. The router read: how to start the app, and its pages.
  const prompt = readSmall(ROUTER_PROMPT, 40_000);
  if (prompt === undefined) throw new Error(`the engine's router prompt is missing (${ROUTER_PROMPT})`);
  const home = join(tmp, "codex");
  mkdirSync(home);
  writeFileSync(join(home, "config.toml"), codexConfig({ model: ROUTER_MODEL, effort: ROUTER_EFFORT, url: String(env.OPENROUTER_BASE_URL ?? "").replace(/\/$/, ""), instructions: "", write: [work] }));
  const task = `${prompt}\n\nStart this app on 127.0.0.1:${PORT} with its seed or demo data; write the command to .aidenhq-ui/run.sh and the pages to .aidenhq-ui/pages.json.`;
  const read = await run("codex", ["exec", "--skip-git-repo-check", "--ignore-rules", "-o", join(tmp, "answer.txt"), task], { cwd: ws, env: codexEnv(home), minutes: 15 });
  ok(read, "the router read", [0]);
  for (const f of ["run.sh", "pages.json"]) if (!existsSync(join(work, f))) throw new Error(`the router read wrote no .aidenhq-ui/${f}`);

  const stop = await startApp(ws, plainEnv);
  try {
    // 2. Capture, the route check, the review. Exit 1: blocking findings (the reports say which); anything else is a failed check.
    ok(await run("ui-review", ["capture", url, "--map", ".aidenhq-ui/pages.json", "--out", ui], { cwd: ws, env: plainEnv, minutes: 25 }), "ui-review capture");
    ok(await run("ui-review", ["routes", url, "--out", routes], { cwd: ws, env: plainEnv, minutes: 6 }), "ui-review routes");
    ok(await run("ui-review", ["review", ui, "--model", spec.model, "--max-usd", String(MAX_USD)], { cwd: ws, env: modelEnv, minutes: 20 }), "ui-review review");
  } finally { stop(); }

  const report = readReport(ui);
  if (!report) throw new Error("ui-review left no report.json");
  return toReview(report, { model: spec.model, repo: spec.repo, head: spec.head, listed: listedPages(ui), routes: readReport(routes), root: ws });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const specFile = process.env.AIDENHQ_SPEC, resultFile = process.env.AIDENHQ_RESULT;
  try {
    const spec = JSON.parse(readFileSync(specFile!, "utf8")) as UiSpec;
    const r = await scan({ spec, ws: process.cwd(), out: dirname(specFile!) });
    writeFileSync(resultFile!, JSON.stringify(r));
    console.error(`code-review-ui: ${r.findings.length} findings (${r.coverage.counts.reviewed} of ${r.coverage.counts.eligible} pages${r.coverage.incomplete ? `; incomplete: ${r.coverage.incomplete}` : ""})`);
  } catch (e) {
    console.error(`code-review-ui: no result: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300)}`);
    process.exit(1);
  }
}
