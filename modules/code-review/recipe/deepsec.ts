// deepsec (Vercel's scanner, Apache-2.0, installed pinned in the engineer image) as a review engine: it sets a repo up or scans it.
//
// Any file under `.deepsec/` at the commit (or the files of a pending setup branch, `setupFiles`) → scan: `scan`, then `process` and `revalidate`
// over the whole tree, or `process --diff <base>` for a change. No file under `.deepsec/` → `init` sets it up in the box (it writes the repo
// summary INFO.md, the config and the generated matchers) and scans; the files deepsec means to be committed come back as `setup`
// (the service files them as one reviewed setup PR; a file already committed is never part of it). Nothing else deepsec writes ever leaves the box.
//
// State: DEEPSEC_DATA_ROOT is a folder in the run's scratch (INFO.md and the finding records), so the repo's checkout takes no
// scan data; a committed INFO.md is copied in first. Model: deepsec's pi backend through our gateway's OpenAI-compatible route
// (a pi models.json in the run's own PI_CODING_AGENT_DIR), the run's capped token in OPENROUTER_API_KEY, the only variable it names.
// init runs on deepsec's `local` route because every other route links a Vercel project first; `local` configures no credential
// and pi reads its provider from that models.json. Spend: `init` gets --max-cost-usd = budget_usd; `process` has no such flag, so
// the run's token cap is the hard stop there (a run that hits it reports the budget ran out, and what was analysed so far).
// Install scripts never run (npm_config_ignore_scripts), and a committed `.deepsec/package.json` is never installed: a scan uses the image's deepsec.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, stopped } from "./proc.ts";

/** A finding in the finder JSON the recipe takes (the recipe adds each finding's option and lens). */
export interface DeepsecFinding { severity: "important" | "nit"; path: string; line: number; title: string; why: string; evidence: string; fix_brief: string }
export interface DeepsecInput {
  root: string; target: "tree" | "pr"; base?: string; model: string; effort?: string; budget_usd: number; scratch: string;
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

/** The files deepsec means to be committed: its config, matchers, package and lockfile, and the repo summary. Nothing else. */
const SETUP = /^\.deepsec\/(deepsec\.config\.ts|generated-matchers\.ts|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|data\/[A-Za-z0-9_.-]+\/INFO\.md)$/;
export const setupPath = (p: string) => SETUP.test(p);
/** CRITICAL, HIGH and HIGH_BUG are important; MEDIUM, BUG and LOW are nits. */
export const deepsecSeverity = (s: unknown): "important" | "nit" => (["CRITICAL", "HIGH", "HIGH_BUG"].includes(String(s)) ? "important" : "nit");
/** A verdict that says the finding isn't a live problem. */
const RESOLVED = ["fixed", "false-positive", "accepted-risk", "duplicate"];

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
      findings.push({ severity: deepsecSeverity(f.severity), path: r.filePath, line: Number.isInteger(f.lineNumbers?.[0]) ? f.lineNumbers![0]! : 1, title: String(f.title ?? ""), why: String(f.description ?? ""), evidence: "", fix_brief: String(f.recommendation ?? "") });
    }
  }
  return { findings, covered, pending };
}

export async function deepsec({ root, target, base, model, effort, budget_usd, scratch, setupFiles, id, minutes }: DeepsecInput): Promise<DeepsecOutput> {
  const tmp = mkdtempSync(join(scratch, "deepsec-"));
  const home = join(tmp, "home"), pi = join(tmp, "pi"), data = join(tmp, "data");
  for (const d of [home, pi, data]) mkdirSync(d);
  const m = String(model).replace(/^openrouter\//, "");
  // The pi provider: our gateway's OpenAI-compatible route, the key read from the one variable it names.
  writeFileSync(join(pi, "models.json"), JSON.stringify({ providers: { gateway: { baseUrl: String(process.env.OPENROUTER_BASE_URL || "").replace(/\/$/, ""), api: "openai-completions", apiKey: "OPENROUTER_API_KEY", models: [{ id: m }] } } }));
  writeFileSync(join(pi, "auth.json"), "{}");
  const env = {
    PATH: String(process.env.PATH), HOME: home, DEEPSEC_DATA_ROOT: data, PI_CODING_AGENT_DIR: pi, OPENROUTER_API_KEY: String(process.env.OPENROUTER_API_KEY ?? ""),
    npm_config_ignore_scripts: "true", npm_config_cache: join(tmp, "npm"), npm_config_update_notifier: "false", CI: "1",
  };
  const deadline = Date.now() + Number(minutes ?? 20) * 60_000;
  const left = () => Math.max(0.1, (deadline - Date.now()) / 60_000);
  const ws = join(root, ".deepsec");
  const models = ["--agent", "pi", "--model", `gateway/${m}`, ...(effort ? ["--thinking-level", effort] : [])];
  const gaps: string[] = [];
  const step = async (bin: string, args: string[], cwd: string, ok = [0]) => {
    const r = await run(bin, args, { cwd, env, minutes: left() });
    if (!ok.includes(r.code ?? -1)) { const tail = r.stderr.trim().split("\n").slice(-3).join(" ").slice(-300); return { r, cause: `deepsec ${args[0]}: ${stopped(r)}${tail ? ` (${tail})` : ""}` }; }
    return { r, cause: undefined };
  };

  // Write a pending setup branch's files in place (allowlisted paths only), so the checkout looks set up.
  for (const [path, text] of Object.entries(setupFiles ?? {})) {
    if (!setupPath(path)) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const dataIn = join(ws, "data");
  // Set up already: any committed file of deepsec's (never node_modules).
  let setUp = false;
  try { setUp = readdirSync(ws, { recursive: true }).some((f) => !String(f).split("/").includes("node_modules") && lstatSync(join(ws, String(f))).isFile()); } catch {}
  const dirs = existsSync(dataIn) ? readdirSync(dataIn, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  const pid = dirs.find((d) => existsSync(join(dataIn, d, "INFO.md"))) ?? dirs[0] ?? id ?? "repo";
  let setup: Record<string, string> | undefined;

  if (setUp) {
    // Set up already: scan. INFO.md (and a project config.json) come in from the commit; data lives in scratch.
    mkdirSync(join(data, pid), { recursive: true });
    for (const f of ["INFO.md", "config.json"]) if (existsSync(join(dataIn, pid, f))) cpSync(join(dataIn, pid, f), join(data, pid, f));
    // No install from the repo's `.deepsec/package.json` (the PR's, and the spec carries no lockfile): the image's pinned deepsec
    // runs, and its package is linked where the committed config's `import "deepsec/config"` resolves.
    const bin = "deepsec";
    try {
      const pkg = dirname(dirname(realpathSync(execFileSync("which", ["deepsec"], { env: { PATH: env.PATH }, encoding: "utf8" }).trim())));
      if (existsSync(join(pkg, "config.mjs")) && !existsSync(join(ws, "node_modules", "deepsec"))) { mkdirSync(join(ws, "node_modules"), { recursive: true }); symlinkSync(pkg, join(ws, "node_modules", "deepsec")); }
    } catch {}
    const s = await step(bin, ["scan", "--project-id", pid, "--root", root], ws);
    if (s.cause) throw new Error(s.cause);
    await analyse(bin);
  } else {
    // Not set up: init writes .deepsec/ and INFO.md and runs the baseline scan (on the `local` route, no Vercel link), then the same analysis.
    const i = await step("deepsec", ["init", ".deepsec", ".", "--id", pid, ...models, "--model-auth", "local", "--package-manager", "npm", "--headless", "--yes", "--through", "coverage",
      "--max-cost-usd", String(budget_usd), "--no-tui", "--output", "jsonl"], root);
    if (i.cause) throw new Error(i.cause);
    setup = {};
    for (const f of ["deepsec.config.ts", "generated-matchers.ts", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      const text = existsSync(join(ws, f)) ? readFileSync(join(ws, f), "utf8") : undefined;
      if (text !== undefined) setup[`.deepsec/${f}`] = text;
    }
    const info = join(data, pid, "INFO.md");
    if (!existsSync(info)) throw new Error("deepsec init wrote no INFO.md");
    setup[`.deepsec/data/${pid}/INFO.md`] = readFileSync(info, "utf8");
    // init ran only because no file of deepsec's was committed, so every file here was missing: none overwrites a committed one.
    const local = join(ws, "node_modules", ".bin", "deepsec");
    await analyse(existsSync(local) ? local : "deepsec");
  }

  /** The AI review: every pending candidate then revalidated (a tree), or the change's files (a PR). A failed step is a gap. */
  async function analyse(bin: string) {
    const common = ["--project-id", pid, "--root", root, ...models];
    // process --diff exits 1 when it found something; any other non-zero code is a failure.
    const p = await step(bin, target === "pr" ? ["process", ...common, "--diff", String(base)] : ["process", ...common], ws, target === "pr" ? [0, 1] : [0]);
    if (p.cause) gaps.push(p.cause);
    if (target === "tree" && !p.cause) {
      const v = await step(bin, ["revalidate", ...common], ws);
      if (v.cause) gaps.push(v.cause);
    }
  }

  const { findings, covered, pending } = readRecords(join(data, pid, "files"));
  if (gaps.length && !covered.length) throw new Error(gaps[0]);
  if (pending.length) gaps.push(`deepsec left ${pending.length} file${pending.length > 1 ? "s" : ""} unanalysed (${pending.slice(0, 3).join(", ")}${pending.length > 3 ? ", …" : ""})`);
  return { review: { findings, covered, ...(gaps.length ? { incomplete: gaps.join("; ") } : {}) }, ...(setup ? { setup } : {}) };
}
