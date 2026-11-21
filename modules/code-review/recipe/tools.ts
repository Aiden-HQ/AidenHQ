#!/usr/bin/env node
// The code review tools recipe (check job `code-review-tools`, kernel/src/checkjobs.ts): the selected tool options of the option
// catalog (catalog.ts) run over one commit's tree in a credential-free box, with no model and no token at all. Docs: docs/design/code-review.md.
//
// The box holds the commit's tree (the workspace), the PR base's tree at /aidenhq-out/base (a PR target only) and the spec at
// $AIDENHQ_SPEC: { repo, head, base (the PR's base, or the head itself for a whole-tree review), options (JSON: { <option id>:
// { lens, cmd, output, severity?, exits?, runs_code? } }, the tool entries of the catalog the service picked: catalog.ts toolSpec) }.
// The checkout is copied to $TMPDIR/work (regular files and folders only: no link a tool could read out of the tree through) and
// each tool runs there, one after the other (the ones that can run the repo's code, runs_code, last, so they can't touch the
// others' runs), through `sh -c` with an environment built from an allowlist (no key, no token, nothing of the kernel's), under a
// time limit of its own (TOOL_MINUTES) and the run's (TOTAL_MINUTES, below the check's 180: a tool past it doesn't start and
// counts as failed, so the run always ends with a result). Its stdout is its output (sarif.ts reads it as its option says).
//
// A tool counts as failed (listed under coverage.failed with the tail of its stderr, the run carrying on) when it times out, can't
// start, exits with a code not in its `exits` (default [0]: a scan error, even with a partial report), exits non-zero (a "found
// something" code) with no finding, or leaves output that isn't its format. A failed tool or a cut list of findings makes the
// review incomplete, never clean. Findings are placed at real lines (review.ts `place`), tagged with `option` and `lens`; on a PR
// target, one in a file the PR didn't change (its bytes the same as the base's) is pre_existing, never a new one. Every important
// one and at most MAX_PER_OPTION others are kept per option, the rest counted in coverage.dropped. The result is the review.ts
// result shape ($AIDENHQ_RESULT) with target "tree" (base is the head) or "pr", engine "tools" and no cost; exit 0.
import { spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LENSES, OUTPUTS } from "./catalog.ts";
import type { Lens, ToolSpec } from "./catalog.ts";
import { adapt, MAX_PER_OPTION } from "./sarif.ts";
import { bound, clean, place, scrub } from "./review.ts";

/** The tools job's spec ($AIDENHQ_SPEC): the commit, its base, and the selected tool entries as JSON text. */
export interface ToolsSpec { repo?: string; head: string; base: string; options: string }
export type Failed = { id: string; why: string };
const TAIL = 600;
const MAX_OUTPUT = 64 << 20;
/** One tool's time limit and the whole run's (minutes): the run's stays under the check's timeout_min (module.yaml, 180). */
export const TOOL_MINUTES = 20, TOTAL_MINUTES = 160;
// Key-shaped text out of everything a tool wrote (it lands in a report). No known secret: the box holds none (scrub's default is the model key, unset here).
const redact = (t: unknown) => scrub({ message: String(t ?? ""), read: true }, []).message;

/** The environment a tool gets: the allowlist below plus writable caches under HOME. Never the model token (OPENROUTER_*), the
 * spec, the result file or anything else the box's process holds. */
const KEEP = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "RUSTUP_HOME"];
export function toolEnv(from: NodeJS.ProcessEnv, tmp: string): Record<string, string> {
  const home = from.HOME || tmp;
  const env: Record<string, string> = {
    CI: "1", NO_COLOR: "1", HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: join(home, ".cache"), GOPATH: join(home, "go"), GOCACHE: join(home, ".cache", "go-build"), GOTOOLCHAIN: "local",
    npm_config_cache: join(home, ".npm"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
  };
  for (const k of KEEP) if (from[k] !== undefined) env[k] = from[k]!;
  return env;
}

type Ended = { exit: number | null; timedOut: boolean; error?: string; stdout: string; stderr: string };
/** `cmd` through `sh -c` in `cwd`, its stdout to a file under `tmp` (no memory bound on a huge scan), killed with its whole process
 * group at `ms`. It ends when the shell exits: whatever it left running (in another session, holding stderr) is killed or let be,
 * never waited for. */
function exec(cmd: string, cwd: string, env: Record<string, string>, tmp: string, ms: number): Promise<Ended> {
  return new Promise((resolve) => {
    const file = join(tmp, `stdout-${Math.random().toString(36).slice(2)}`);
    const fd = openSync(file, "w");
    let stderr = "", timedOut = false, error: string | undefined, done = false;
    const child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, "pipe"] });
    const group = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; group(); }, ms);
    child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-TAIL * 4); });
    const end = (exit: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSync(fd);
      group(); // anything the tool left running
      child.stderr!.destroy();
      const big = !error && statSync(file).size > MAX_OUTPUT;
      resolve({ exit, timedOut, ...(big ? { error: `its output is over ${MAX_OUTPUT >> 20} MB` } : error ? { error } : {}), stdout: big ? "" : readFileSync(file, "utf8"), stderr });
    };
    child.on("error", (e) => { error = e.message; end(null); });
    child.on("close", (code) => end(code));
    // The shell gone, its stderr's last lines get a moment; a process elsewhere holding the pipe doesn't hold the run.
    child.on("exit", (code) => { group(); setTimeout(() => end(code), 500).unref(); });
  });
}

/** Whether `path` is the same file in the head checkout `ws` as in the base tree `base` (a file the PR didn't change). */
function unchanged(ws: string, base: string, path: string) {
  try { return readFileSync(join(base, path)).equals(readFileSync(join(ws, path))); } catch { return false; }
}

export interface RunInput { spec: ToolsSpec; ws: string; out: string; env?: NodeJS.ProcessEnv; minutes?: number; totalMinutes?: number }
/** The review of the selected tools over the checkout `ws`; `out`: the box's out folder (a writable HOME lives in it, the base tree at out/base). */
export async function runTools({ spec, ws, out, env = process.env, minutes = TOOL_MINUTES, totalMinutes = TOTAL_MINUTES }: RunInput) {
  const deadline = Date.now() + totalMinutes * 60_000;
  const options = JSON.parse(spec.options) as ToolSpec;
  for (const [id, o] of Object.entries(options)) {
    if (!LENSES.includes(o?.lens) || !OUTPUTS.includes(o?.output) || o.output === "findings" || typeof o.cmd !== "string" || !o.cmd) throw new Error(`bad option ${id} in the spec`);
    if (o.exits !== undefined && (!Array.isArray(o.exits) || o.exits.some((c) => !Number.isInteger(c)))) throw new Error(`bad option ${id} in the spec: exits`);
  }
  mkdirSync(join(out, "home"), { recursive: true });
  const tmp = mkdtempSync(join(out, "home", "tools-"));
  const work = join(tmp, "work");
  // Tools may write beside the code (caches, reports): they get a copy, regular files and folders only.
  cpSync(ws, work, { recursive: true, filter: (src) => { const st = lstatSync(src); return st.isFile() || st.isDirectory(); } });
  const toolEnvVars = toolEnv(env, tmp);
  // A PR target: a finding in a file the PR left as the base has it is pre_existing. A tree target: every file is the review's.
  const base = join(out, "base"), pr = spec.base !== spec.head;
  if (pr && !existsSync(base)) throw new Error("no base tree for a PR target");

  const failed: Failed[] = [], dropped: Record<string, number> = {}, counts: Record<string, number> = {};
  const findings: (ReturnType<typeof place>[number] & { option: string; lens: Lens })[] = [];
  const order = Object.entries(options).sort(([, a], [, b]) => Number(!!a.runs_code) - Number(!!b.runs_code));
  for (const [id, o] of order) {
    const fail = (why: string, stderr = "") => { const tail = redact(stderr.trim()).slice(-TAIL); failed.push({ id, why: `${why}${tail ? `: ${tail}` : ""}`.slice(0, 700) }); };
    const left = Math.min(minutes * 60_000, deadline - Date.now());
    if (left < 1000) { fail(`not run: the run's ${totalMinutes} minutes were used up`); continue; }
    const r = await exec(o.cmd, work, toolEnvVars, tmp, left);
    if (r.timedOut) { fail(`timed out after ${Math.round(left / 60_000)} minutes`, r.stderr); continue; }
    if (r.error) { fail(r.error, r.stderr); continue; }
    if (!(o.exits ?? [0]).includes(r.exit!)) { fail(`exit ${r.exit}${r.stdout.trim() ? "" : " with no output"}`, r.stderr); continue; }
    let raw;
    try { raw = adapt(o, redact(r.stdout), work); } catch (e) { fail(`its output isn't ${o.output}: ${String((e as Error).message).slice(0, 150)}`, r.stderr); continue; }
    if (r.exit !== 0 && !raw.length) { fail(`exit ${r.exit} with no finding`, r.stderr); continue; }
    // Each at a real place; one per id. What can't be placed (no file, a line past its end) is dropped and counted.
    const cleaned = clean(raw.map((f) => ({ ...f, evidence: redact(f.evidence), why: redact(f.why) })), work);
    const marked = cleaned.map((f) => (pr && unchanged(ws, base, f.path) ? { ...f, severity: "pre_existing" as const } : f));
    const placed = place(marked, work, new Set(marked.filter((f) => f.severity !== "pre_existing").map((f) => f.path)));
    const byId = [...new Map(placed.map((f) => [f.id, f])).values()];
    // Every important finding is kept; nits and pre-existing ones are capped. Only the PR's own (new) ones cut count as a gap.
    const of = (s: string) => byId.filter((f) => f.severity === s);
    const imp = of("important"), nits = of("nit").slice(0, MAX_PER_OPTION), kept = [...imp, ...nits, ...of("pre_existing").slice(0, MAX_PER_OPTION)];
    counts[id] = kept.length;
    const lost = raw.length - cleaned.length + marked.filter((f) => f.severity !== "pre_existing").length - imp.length - nits.length;
    if (lost > 0) dropped[id] = lost;
    findings.push(...kept.map((f) => ({ ...f, option: id, lens: o.lens })));
  }

  const result = {
    version: 1, repo: spec.repo, target: spec.base === spec.head ? "tree" : "pr", base: spec.base, head: spec.head, engine: "tools", model: "", effort: "", incremental_from: null, full: true, addressed: false,
    coverage: { reviewed: [] as string[], excluded: [] as string[], incomplete: null as string | null, options: Object.keys(options).filter((id) => !failed.some((f) => f.id === id)), failed, dropped, counts },
    findings, fixed: [] as string[], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] as string[], guidance: [] as string[],
  };
  const gaps = [
    ...(failed.length ? [`${failed.length} tool${failed.length > 1 ? "s" : ""} failed (${failed.slice(0, 5).map((f) => f.id).join(", ")}${failed.length > 5 ? ", …" : ""})`] : []),
    ...(Object.keys(dropped).length ? [`findings cut or unplaceable: ${Object.entries(dropped).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(", ")}`] : []),
  ];
  result.coverage.incomplete = gaps.length ? gaps.join("; ") : null;
  // bound() says so itself when importants had to go; the others it leaves out are a gap of this run too.
  const fit = bound(result as any) as typeof result;
  const trimmed = fit.withheld.nit + fit.withheld.pre_existing;
  if (trimmed) fit.coverage.incomplete = [fit.coverage.incomplete, `${trimmed} other findings left out to fit the result`].filter(Boolean).join("; ").slice(0, 500);
  return fit;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const specFile = process.env.AIDENHQ_SPEC, resultFile = process.env.AIDENHQ_RESULT;
  try {
    const spec = JSON.parse(readFileSync(specFile!, "utf8"));
    const r = await runTools({ spec, ws: process.cwd(), out: dirname(specFile!) });
    writeFileSync(resultFile!, JSON.stringify(r));
    console.error(`code-review-tools: ${r.findings.length} findings from ${r.coverage.options.length} tools${r.coverage.failed.length ? `, ${r.coverage.failed.length} failed` : ""}`);
  } catch (e) {
    console.error(`code-review-tools: no result: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300)}`);
    process.exit(1);
  }
}
