#!/usr/bin/env node
// The code review tools recipe (check job `code-review-tools`, kernel/src/checkjobs.ts): the selected tool options of the option
// catalog (catalog.ts) run over one commit's tree in a credential-free box, with no model and no token at all. Docs: docs/design/code-review.md.
//
// The box holds the commit's tree (the workspace) and the spec at $AIDENHQ_SPEC: { repo, head, base (the PR's base, or the head
// itself for a whole-tree review), options (JSON: { <option id>: { lens, cmd, output, severity? } }, the tool entries of the
// catalog the service picked) }. The checkout is copied to $TMPDIR/work and each tool runs there, one after the other, through
// `sh -c` with an environment built from an allowlist (no key, no token, nothing of the kernel's), under a time limit of its own
// (TOOLS_MINUTES, 20). Its stdout is its output (sarif.ts reads it as its option says).
//
// A tool counts as failed (listed under coverage.failed with the tail of its stderr, the run carrying on) when it times out, can't
// start, or leaves output that isn't its format or none where its format needs some. Its exit code alone says nothing: scanners
// exit non-zero when they find something. A failed tool or a cut list of findings makes the review incomplete, never clean.
// Findings are placed at real lines (review.ts `place`), tagged with `option` and `lens`, and every important one and at most MAX_PER_OPTION nits kept per
// option, the rest counted in coverage.dropped. The result is the review.ts result shape ($AIDENHQ_RESULT)
// with target "tree" (base is the head) or "pr", engine "tools" and no cost: the run always ends with a result, exit 0.
import { spawn } from "node:child_process";
import { closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
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
/** `cmd` through `sh -c` in `cwd`, its stdout to a file under `tmp` (no memory bound on a huge scan), killed with its whole process group at `ms`. */
function exec(cmd: string, cwd: string, env: Record<string, string>, tmp: string, ms: number): Promise<Ended> {
  return new Promise((resolve) => {
    const file = join(tmp, `stdout-${Math.random().toString(36).slice(2)}`);
    const fd = openSync(file, "w");
    let stderr = "", timedOut = false, error: string | undefined, done = false;
    const child = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, "pipe"] });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, ms);
    child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-TAIL * 4); });
    const end = (exit: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSync(fd);
      try { process.kill(-child.pid!, "SIGKILL"); } catch {} // anything the tool left running
      const big = !error && statSync(file).size > MAX_OUTPUT;
      resolve({ exit, timedOut, ...(big ? { error: `its output is over ${MAX_OUTPUT >> 20} MB` } : error ? { error } : {}), stdout: big ? "" : readFileSync(file, "utf8"), stderr });
    };
    child.on("error", (e) => { error = e.message; end(null); });
    child.on("close", (code) => end(code));
  });
}

/** Paths the repo's .gitattributes mark export-ignore: a snapshot (git archive) leaves them out, so no tool saw them: a coverage gap. */
export function exportIgnored(ws: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ws, dir), { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") walk(posix.join(dir, e.name));
      else if (e.isFile() && e.name === ".gitattributes") {
        for (const l of readFileSync(join(ws, dir, e.name), "utf8").split("\n")) {
          const [pat, ...attrs] = l.trim().split(/\s+/);
          if (pat && !pat.startsWith("#") && attrs.includes("export-ignore")) out.push(posix.join(dir, pat.replace(/^\//, "")));
        }
      }
    }
  };
  walk(".");
  return out;
}

export interface RunInput { spec: ToolsSpec; ws: string; out: string; env?: NodeJS.ProcessEnv; minutes?: number }
/** The review of the selected tools over the checkout `ws`; `out`: the box's out folder (a writable HOME lives in it). */
export async function runTools({ spec, ws, out, env = process.env, minutes = Number(process.env.TOOLS_MINUTES || 20) }: RunInput) {
  const options = JSON.parse(spec.options) as ToolSpec;
  for (const [id, o] of Object.entries(options)) {
    if (!LENSES.includes(o?.lens) || !OUTPUTS.includes(o?.output) || o.output === "findings" || typeof o.cmd !== "string" || !o.cmd) throw new Error(`bad option ${id} in the spec`);
  }
  mkdirSync(join(out, "home"), { recursive: true });
  const tmp = mkdtempSync(join(out, "home", "tools-"));
  const work = join(tmp, "work");
  // Tools may write beside the code (caches, reports): they get a copy, regular files and folders and links only.
  cpSync(ws, work, { recursive: true, verbatimSymlinks: true, filter: (src) => { const st = lstatSync(src); return st.isFile() || st.isDirectory() || st.isSymbolicLink(); } });
  const toolEnvVars = toolEnv(env, tmp);

  const failed: Failed[] = [], dropped: Record<string, number> = {}, counts: Record<string, number> = {};
  const findings: (ReturnType<typeof place>[number] & { option: string; lens: Lens })[] = [];
  for (const [id, o] of Object.entries(options)) {
    const fail = (why: string, stderr = "") => { const tail = redact(stderr.trim()).slice(-TAIL); failed.push({ id, why: `${why}${tail ? `: ${tail}` : ""}`.slice(0, 700) }); };
    const r = await exec(o.cmd, work, toolEnvVars, tmp, minutes * 60_000);
    if (r.timedOut) { fail(`timed out after ${minutes} minutes`, r.stderr); continue; }
    if (r.error) { fail(r.error, r.stderr); continue; }
    if (r.exit !== 0 && !r.stdout.trim()) { fail(`exit ${r.exit} with no output`, r.stderr); continue; }
    let raw;
    try { raw = adapt(o, redact(r.stdout), work); } catch (e) { fail(`its output isn't ${o.output}: ${String((e as Error).message).slice(0, 150)}`, r.stderr); continue; }
    // Each at a real place; one per id. What can't be placed (no file, a line past its end) is dropped and counted.
    const cleaned = clean(raw.map((f) => ({ ...f, evidence: redact(f.evidence), why: redact(f.why) })), work);
    const placed = place(cleaned, work, new Set(cleaned.map((f) => f.path)));
    const byId = [...new Map(placed.map((f) => [f.id, f])).values()];
    // Every important finding is kept; only nits are capped.
    const imp = byId.filter((f) => f.severity === "important"), nits = byId.filter((f) => f.severity !== "important").slice(0, MAX_PER_OPTION);
    const kept = [...imp, ...nits];
    counts[id] = kept.length;
    if (raw.length > kept.length) dropped[id] = raw.length - kept.length;
    findings.push(...kept.map((f) => ({ ...f, option: id, lens: o.lens })));
  }

  const result = {
    version: 1, repo: spec.repo, target: spec.base === spec.head ? "tree" : "pr", base: spec.base, head: spec.head, engine: "tools", model: "", effort: "", incremental_from: null, full: true, addressed: false,
    coverage: { reviewed: [] as string[], excluded: [] as string[], incomplete: null as string | null, options: Object.keys(options).filter((id) => !failed.some((f) => f.id === id)), failed, dropped, counts },
    findings, fixed: [] as string[], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] as string[], guidance: [] as string[],
  };
  const ignored = exportIgnored(ws);
  result.coverage.excluded = ignored.map((p) => `${p} (export-ignore)`);
  const gaps = [
    ...(ignored.length ? [`${ignored.length} path${ignored.length > 1 ? "s" : ""} marked export-ignore in .gitattributes, absent from the snapshot (${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ", …" : ""})`] : []),
    ...(failed.length ? [`${failed.length} tool${failed.length > 1 ? "s" : ""} failed (${failed.slice(0, 5).map((f) => f.id).join(", ")}${failed.length > 5 ? ", …" : ""})`] : []),
    ...(Object.keys(dropped).length ? [`findings cut or unplaceable: ${Object.entries(dropped).slice(0, 5).map(([k, n]) => `${k} ${n}`).join(", ")}`] : []),
  ];
  result.coverage.incomplete = gaps.length ? gaps.join("; ") : null;
  const fit = bound(result as any) as typeof result;
  const trimmed = fit.withheld.nit + fit.withheld.important + fit.withheld.pre_existing;
  if (trimmed) fit.coverage.incomplete = [fit.coverage.incomplete, `${trimmed} findings left out to fit the result`].filter(Boolean).join("; ").slice(0, 500);
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
