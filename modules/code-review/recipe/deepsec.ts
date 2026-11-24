// deepsec (Vercel's scanner, Apache-2.0, installed pinned in the engineer image) as a review engine: it sets a repo up or scans it.
//
// Anything under `.deepsec/` at the commit (links and node_modules included), or a pending setup branch's files (`setupFiles`) → scan:
// `scan`, then `process` and `revalidate` over the whole tree, or `process --diff <base>` for a change. Nothing under `.deepsec/` →
// `init` sets it up in the box (it writes the repo summary INFO.md, the config and the generated matchers) and scans (a tree: and
// processes, under its spend cap; then `revalidate`); the files deepsec
// means to be committed come back as `setup` (the service files them as one reviewed setup PR; a file already committed is never part
// of it). Nothing else deepsec writes ever leaves the box.
//
// Repo code never runs here, and the model token never reaches it. deepsec loads (as code) the first deepsec.config.* above its cwd,
// so every step but init runs from a workspace in the run's scratch with a config we write (the project and the `local` route, no
// imports): the repo's committed config and matchers are never loaded, and only its INFO.md (a regular file, never through a link) is
// read, as text. init runs in the checkout only when nothing of deepsec's is there, and refuses a repo-root deepsec.config.*. The
// binary is always the image's.
//
// State: DEEPSEC_DATA_ROOT is a folder in the run's scratch (INFO.md and the finding records), so the repo's checkout takes no
// scan data. Model: deepsec's pi backend through our gateway's OpenAI-compatible route (a pi models.json in the run's own
// PI_CODING_AGENT_DIR: provider `openrouter`, so pi counts the cost OpenRouter reports, which the gateway passes through; its key
// `$OPENROUTER_API_KEY`, pi's env interpolation: a bare name is sent as the key itself, which the gateway refused, 2026-11-23), the
// run's capped token in OPENROUTER_API_KEY. The `local` route configures no credential (every other route links a Vercel project
// first), and pi reads its provider from that models.json. Spend: the token is counted against the run's and the install's limits
// (the run's cost is the gateway's), and init gets deepsec's own cap, --max-cost-usd = max_cost_usd (the catalog option's
// `run.max_cost_usd`): on a tree init runs through `process`, so the cap bounds the AI investigation. deepsec 2.3.12's `process` and
// `revalidate` have no such flag, so a repo already set up is bounded by the gateway alone. A cap or limit reached reports it, and
// what was analysed so far. A failed step says why: deepsec's own last error (init's jsonl on stdout, else stderr), as data.
// Install scripts never run (npm_config_ignore_scripts).
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plain, readSmall, run, stopped } from "./proc.ts";

/** A finding in the finder JSON the recipe takes (the recipe adds each finding's option and lens). */
export interface DeepsecFinding { severity: "important" | "nit"; path: string; line: number; title: string; failure_scenario: string; why: string; evidence: string; fix_brief: string }
export interface DeepsecInput {
  /** base: what a change is diffed from (the last reviewed head on an incremental review); trusted: the merge base, where its
   * summary (INFO.md) is read from. */
  root: string; target: "tree" | "pr"; base?: string; trusted?: string; model: string; effort?: string; scratch: string;
  /** deepsec's own spend cap (init's --max-cost-usd); none: no flag. */
  max_cost_usd?: number;
  /** A pending setup branch's files (path to text): scan with them instead of setting up. */
  setupFiles?: Record<string, string>;
  /** The project id (default `repo`); an existing `.deepsec/data/<id>/` names its own. */
  id?: string; minutes?: string | number;
}
export interface DeepsecOutput {
  review: { findings: DeepsecFinding[]; /** the files deepsec analysed */ covered: string[]; incomplete?: string };
  /** Only after a setup (init ran): path (relative to the repo root) to text, the allowlisted files only. */
  setup?: Record<string, string>;
}

/** The files deepsec means to be committed: its .gitignore (keeps .env.local and scan output out), config, matchers, package and lockfile, and the repo summary. Nothing else (a
 * setup carries all but the lockfile). */
const SETUP = /^\.deepsec\/(\.gitignore|deepsec\.config\.ts|generated-matchers\.ts|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|data\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/INFO\.md)$/;
export const setupPath = (p: string) => SETUP.test(p);
const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** A regular file's text (at most 64 KB) at commit `rev` of the box's history, else undefined. */
function baseFile(root: string, rev: string, rel: string) {
  try {
    const mode = execFileSync("git", ["-C", root, "ls-tree", rev, "--", rel], { encoding: "utf8" }).split(/\s/)[0];
    return mode === "100644" || mode === "100755" ? execFileSync("git", ["-C", root, "cat-file", "blob", `${rev}:${rel}`], { encoding: "utf8", maxBuffer: 8 << 20 }).slice(0, 64_000) : undefined;
  } catch { return undefined; }
}
/** CRITICAL, HIGH and HIGH_BUG are important; MEDIUM, BUG and LOW are nits. */
export const deepsecSeverity = (s: unknown): "important" | "nit" => (["CRITICAL", "HIGH", "HIGH_BUG"].includes(String(s)) ? "important" : "nit");
/** A verdict that says the finding isn't a live problem. */
const RESOLVED = ["fixed", "false-positive", "accepted-risk", "duplicate"];

/** deepsec's jsonl events (init's --output jsonl, on stdout); other lines are skipped. */
const events = (stdout: string) => stdout.split("\n").flatMap((l) => { try { const j = l.startsWith("{") ? JSON.parse(l) : undefined; return j && typeof j === "object" ? [j] : []; } catch { return []; } });
/** deepsec's own words for a failed batch (`Batch 2/5 failed: <the error>`), in its jsonl progress or its human output alike. */
const BATCH = /Batch \d+\/\d+ failed: .*/;
/**
 * What deepsec said about its stop, one line, as data. init (jsonl): its last failure, limit or phase-error message; when that only
 * counts failed batches ("AI processing completed with N failed batch(es)"), the last batch's own error leads (a gateway 402).
 * The other steps (human output): stderr's last lines and the last failed batch's error on stdout, both (either may be the
 * reason: a warning on stderr, a 402 in a batch; each kept short so both fit the reason), else stdout's last lines.
 */
export function said(r: { stdout: string; stderr: string }) {
  const ev = events(r.stdout);
  const msg = ev.map((e) => (e.type === "failure" || e.type === "limit" ? e.message : e.type === "setup_event" && e.event?.type === "phase-error" ? e.event.message : undefined)).filter((m) => typeof m === "string" && m).at(-1);
  const lines = r.stdout.split("\n").map((l) => { try { const j = l.startsWith("{") ? JSON.parse(l) : undefined; return j ? String(j.event?.message ?? j.message ?? "") : l; } catch { return l; } });
  const batch = lines.map((l) => BATCH.exec(l.replace(/\x1b\[[0-9;]*m/g, ""))?.[0]).filter(Boolean).at(-1);
  const tail = (t: string) => t.trim().split("\n").slice(-3).join(" ");
  const text = msg !== undefined ? (batch && /failed batch/i.test(msg) ? `${batch} (${msg})` : msg) : [tail(r.stderr).slice(-95), batch?.slice(0, 95)].filter(Boolean).join(" | ") || tail(r.stdout.replace(/\x1b\[[0-9;]*m/g, ""));
  return String(text).replace(/[\x00-\x1f\x7f«»]+/g, " ").trim();
}

type Record_ = { filePath?: string; status?: string; findings?: { severity?: string; title?: string; description?: string; recommendation?: string; lineNumbers?: number[]; revalidation?: { verdict?: string } }[] };

/** deepsec's finding records under `data/<id>/files/` (one JSON per scanned file), as findings and the analysed files. */
export function readRecords(dir: string) {
  const findings: DeepsecFinding[] = [], covered: string[] = [], pending: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".json")); } catch {}
  for (const n of names) {
    let r: Record_;
    try { r = JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { continue; }
    if (typeof r.filePath !== "string") continue;
    (r.status === "analyzed" ? covered : pending).push(r.filePath);
    for (const f of r.findings ?? []) {
      if (RESOLVED.includes(String(f.revalidation?.verdict))) continue;
      findings.push({ severity: deepsecSeverity(f.severity), path: r.filePath, line: Number.isInteger(f.lineNumbers?.[0]) ? f.lineNumbers![0]! : 1, title: String(f.title ?? ""),
        // Its description is the exploit it revalidated: the failure scenario an important finding needs (review.ts).
        failure_scenario: String(f.description ?? ""), why: "", evidence: "", fix_brief: String(f.recommendation ?? "") });
    }
  }
  return { findings, covered, pending };
}

export async function deepsec({ root, target, base, trusted = base, model, effort, max_cost_usd, scratch, setupFiles, id, minutes }: DeepsecInput): Promise<DeepsecOutput> {
  const tmp = mkdtempSync(join(scratch, "deepsec-"));
  const home = join(tmp, "home"), pi = join(tmp, "pi"), data = join(tmp, "data");
  for (const d of [home, pi, data]) mkdirSync(d);
  const m = String(model).replace(/^openrouter\//, "");
  // The pi provider: our gateway's OpenAI-compatible route, named openrouter (pi then counts OpenRouter's reported cost, which the
  // cap needs), the key interpolated from the variable (`$NAME`; a bare name would be sent as the key itself).
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, ""), api: "openai-completions", apiKey: "$OPENROUTER_API_KEY", models: [{ id: m }] } } }));
  writeFileSync(join(pi, "auth.json"), "{}");
  const env = {
    PATH: String(process.env.PATH), HOME: home, DEEPSEC_DATA_ROOT: data, PI_CODING_AGENT_DIR: pi, OPENROUTER_API_KEY: String(process.env.OPENROUTER_API_KEY ?? ""),
    npm_config_ignore_scripts: "true", npm_config_cache: join(tmp, "npm"), npm_config_update_notifier: "false", CI: "1",
  };
  const deadline = Date.now() + Number(minutes ?? 20) * 60_000;
  const left = () => Math.max(0.1, (deadline - Date.now()) / 60_000);
  const ws = join(root, ".deepsec");
  const models = ["--agent", "pi", "--model", `openrouter/${m}`, ...(effort ? ["--thinking-level", effort] : [])];
  const gaps: string[] = [];
  const step = async (bin: string, args: string[], cwd: string, ok = [0]) => {
    const r = await run(bin, args, { cwd, env, minutes: left() });
    if (!ok.includes(r.code ?? -1)) {
      // Classed from the error itself, never a batch's counters (`Batch 402/500 failed: … (0 in flight, 3/500 done)`).
      const s = said(r), error = s.replace(/Batch \d+\/\d+ failed: /g, "").replace(/\(\d+ in flight, \d+\/\d+ done\)/g, "");
      return { r, cause: `deepsec ${args[0]}: ${stopped(r, error)}${s ? `; it said «${s.slice(0, 200)}»` : ""}` };
    }
    return { r, cause: undefined };
  };

  // Set up already: anything at all under .deepsec/ (by lstat: links and node_modules count), or a pending setup branch.
  const lst = lstatSync(ws, { throwIfNoEntry: false });
  let committed = !!lst && !lst.isDirectory();
  try { committed ||= !!lst?.isDirectory() && readdirSync(ws, { recursive: true }).some((f) => !lstatSync(join(ws, String(f))).isDirectory()); } catch {}
  const pending = Object.entries(setupFiles ?? {}).filter(([p, t]) => setupPath(p) && typeof t === "string");
  // The project id: a committed data/<id>/ with an INFO.md, else the pending setup's, else the given one.
  const ids = plain(root, ".deepsec/data") ? readdirSync(join(ws, "data")).filter((d) => ID.test(d) && plain(root, `.deepsec/data/${d}/INFO.md`)) : [];
  const pid = ids[0] ?? pending.map(([p]) => /^\.deepsec\/data\/([^/]+)\/INFO\.md$/.exec(p)?.[1]).find(Boolean) ?? (id && ID.test(id) ? id : "repo");
  // The workspace deepsec runs from: our own config, so nothing of the repo's is loaded as code.
  const w = join(tmp, "w");
  mkdirSync(w);
  writeFileSync(join(w, "deepsec.config.mjs"), `export default ${JSON.stringify({ ai: { mode: "local", provider: "local" }, projects: [{ id: pid, root }] })};\n`);
  let setup: Record<string, string> | undefined, processed = false;

  if (committed || pending.length) {
    // INFO.md in as data: the committed one (a regular file, never through a link; for a change, the merge base's: the PR's own
    // copy, in any of its revisions, is its author's text), else the pending setup's.
    const rel = `.deepsec/data/${pid}/INFO.md`;
    const committedInfo = target === "pr" ? baseFile(root, String(trusted), rel) : plain(root, rel) ? readSmall(join(ws, "data", pid, "INFO.md"), 64_000) : undefined;
    const info = committedInfo ?? pending.find(([p]) => p === rel)?.[1];
    mkdirSync(join(data, pid));
    if (info !== undefined) writeFileSync(join(data, pid, "INFO.md"), info);
    const s = await step("deepsec", ["scan", "--project-id", pid, "--root", root], w);
    if (s.cause) throw new Error(s.cause);
  } else {
    // Not set up: init writes .deepsec/ and INFO.md and runs the baseline scan (on the `local` route, no Vercel link). Its cwd is the
    // checkout, where deepsec would load a repo-root config as code: refused.
    const rootConfig = ["deepsec.config.ts", "deepsec.config.mjs", "deepsec.config.js", "deepsec.config.cjs"].find((f) => lstatSync(join(root, f), { throwIfNoEntry: false }));
    if (rootConfig) throw new Error(`the repo has a ${rootConfig} at its root, which deepsec would load as code; move it into .deepsec/`);
    // A tree: init runs on through the AI investigation (process), the part its cap bounds. A change: up to coverage, then process --diff.
    const i = await step("deepsec", ["init", ".deepsec", ".", "--id", pid, ...models, "--model-auth", "local", "--package-manager", "npm", "--headless", "--yes",
      "--through", target === "tree" ? "process" : "coverage", ...(max_cost_usd ? ["--max-cost-usd", String(max_cost_usd)] : []), "--no-tui", "--output", "jsonl"], root);
    // Its cap reached (exit 3, a COST_LIMIT_REACHED limit): set up, with what it analysed so far; a gap, and nothing more spent.
    const capped = i.r.code === 3 && events(i.r.stdout).some((e) => e.type === "limit" && e.code === "COST_LIMIT_REACHED");
    // Failed after it set up (INFO.md written) on a tree: its processing ran, so what it analysed is kept and the failure is a gap
    // (none analysed: the failure is the run's). Failed before that: nothing to keep.
    const setUp = readSmall(join(data, pid, "INFO.md"), 64_000) !== undefined;
    if (i.cause && !capped && !(target === "tree" && setUp)) throw new Error(i.cause);
    if (capped) gaps.push(`deepsec stopped at its $${max_cost_usd} spend cap`);
    else if (i.cause) gaps.push(i.cause);
    processed = target === "tree";
    // init ran only because nothing of deepsec's was committed, so every file here is new: none overwrites a committed one. Its
    // lockfile stays out (about 150 KB, too large for the result next to a tree's findings; our scans never install from it).
    setup = {};
    for (const f of [".gitignore", "deepsec.config.ts", "generated-matchers.ts", "package.json"]) {
      const text = plain(root, `.deepsec/${f}`) ? readSmall(join(ws, f), 4 << 20) : undefined;
      if (text !== undefined) setup[`.deepsec/${f}`] = text;
    }
    const info = readSmall(join(data, pid, "INFO.md"), 64_000);
    if (info === undefined) throw new Error("deepsec init wrote no INFO.md");
    setup[`.deepsec/data/${pid}/INFO.md`] = info;
  }
  if (!gaps.length) await analyse();

  /** The AI review: every pending candidate then revalidated (a tree), or the change's files (a PR). A failed step is a gap. */
  async function analyse() {
    const common = ["--project-id", pid, "--root", root, ...models];
    // process --diff exits 1 when it found something; any other non-zero code is a failure. A tree's init processed already.
    const p = processed ? { cause: undefined } : await step("deepsec", target === "pr" ? ["process", ...common, "--diff", String(base)] : ["process", ...common], w, target === "pr" ? [0, 1] : [0]);
    if (p.cause) gaps.push(p.cause);
    if (target === "tree" && !p.cause) {
      const v = await step("deepsec", ["revalidate", ...common], w);
      if (v.cause) gaps.push(v.cause);
    }
  }

  const records = readRecords(join(data, pid, "files"));
  const { findings, covered } = records;
  // A PR's process analyses only the change: the scan's other candidates stay pending and are no gap.
  const changed = target === "pr" ? new Set(execFileSync("git", ["-C", root, "-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", String(base), "HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean)) : undefined;
  const unanalysed = records.pending.filter((p) => !changed || changed.has(p));
  if (gaps.length && !covered.length) throw new Error(gaps[0]);
  if (unanalysed.length) gaps.push(`deepsec left ${unanalysed.length} file${unanalysed.length > 1 ? "s" : ""} unanalysed (${unanalysed.slice(0, 3).join(", ")}${unanalysed.length > 3 ? ", …" : ""})`);
  return { review: { findings, covered, ...(gaps.length ? { incomplete: gaps.join("; ") } : {}) }, ...(setup ? { setup } : {}) };
}
