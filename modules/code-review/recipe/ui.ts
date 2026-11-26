#!/usr/bin/env node
// The ui.scan option's capture step (check job `code-review-ui`, module.yaml): the repo's own app, started and captured with no
// model. Docs: docs/design/code-review.md "UI scan".
//
// This box runs the repo's code, so it holds no model token at all: the check declares no `model`, so the kernel gives it neither
// OPENROUTER_API_KEY nor OPENROUTER_BASE_URL (kernel/src/checkjobs.ts checkEnv "result"), and it runs no model, as the tools box
// (tools.ts). The box (the engineer image, which carries the `ui-review` engine of the agent-base image) holds the commit's tree
// (the workspace) and the spec at $AIDENHQ_SPEC: { repo, head, base (the head itself), run, option, model }. The steps:
//   1. The app: the dependencies installed with the lockfile's package manager, its `build` script when it declares one, then the
//      `start` script package.json declares, with
//      PORT=8080 HOST=127.0.0.1, waited for (180 s; a 5xx counts after a minute). No start script: the check fails (it never guesses).
//   2. `ui-review capture` (its pages: the repo's committed `.aidenhq-ui/pages.json` when there is one, else its own crawl) and
//      `ui-review routes` over the same pages, both from a folder outside the checkout. Exit 1 means blocking findings (the reports
//      say which), anything else but 0 a failed check.
//   With the option ui.scan-signed-in, both run signed in, with only the rungs that need no secret (the spec carries no login):
//   the repo's own test user when it commits one (`.aidenhq-ui/login.json`: { url, user, password }, a seed user of its local
//   build, through `ui-review login form`), else a sign-up at /signup or /register (`ui-review login signup`, mail through
//   Mailpit). The session stays outside the bundle; a run that can't sign in captures signed out and says so.
//   3. The bundle for the review step (recipe/ui-review.ts, the model box) at /aidenhq-out/keep: the capture's report.json, run.json and
//      queue.json, the route check's report.json and, per page, the shots the review reads (390, 1512 and 2560 light and 1512 dark,
//      each capture's first). Pages that don't fit the kernel's 64 MB input are left out from the end of the list, and the result says
//      so. The result is the coverage only (the tree Review's shape, no findings): every finding comes from the review step.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSmall, run, stopped } from "./proc.ts";
import { toolEnv } from "./tools.ts";
import { pack, type UiReport } from "./ui-review.ts";

/** The spec ($AIDENHQ_SPEC) of the `code-review-ui` check. */
export interface UiSpec { repo?: string; head: string; base: string; run?: string; option: string; model: string }
type Capture = UiReport["captures"][number];

const PORT = 8080, APP_WAIT_MS = 180_000;
/** The bundle's room: the kernel's input limit (INPUT_MAX, 64 MB) less a margin for the tar's headers and the text's compression. */
const BUNDLE_MAX = 63 << 20;

/** Starts the app (its own process group) and waits for its port: a start that exits first, or no answer in 180 s, fails the run. */
async function startApp([pm, ...via]: string[], ws: string, env: Record<string, string>) {
  const child = spawn(pm!, [...via, "start"], { cwd: ws, env: { ...env, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: "ignore", detached: true });
  let exited: number | null | undefined;
  child.on("close", (c) => { exited = c; });
  child.on("error", () => { exited = null; });
  const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  const until = Date.now() + APP_WAIT_MS;
  let answered: number | undefined;
  while (Date.now() < until) {
    if (exited !== undefined) throw new Error(`\`${pm} start\` ended (exit ${exited}) before the app answered on port ${PORT}`);
    // Up: an answer that isn't a server error, or still a 5xx a minute after its first answer (a broken home page is the capture's
    // finding, not a start that failed; a minute covers a dev server compiling on its first request).
    try {
      const status = (await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) })).status;
      answered ??= Date.now();
      if (status < 500 || Date.now() - answered >= 60_000) return stop;
    } catch { /* not up yet */ }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  stop();
  throw new Error(`the app didn't answer on port ${PORT} within ${APP_WAIT_MS / 1000} s`);
}

/** The shots the review reads of one page's captures (ui-review review.ts `pick`): 390, 1512 and 2560 light and 1512 dark, each its
 * first; a run without them, its narrowest and widest. */
export function shotsFor(caps: Capture[]): string[] {
  const first = (w: number, theme: string) => caps.find((c) => c.width === w && c.theme === theme && (c.state ?? "default") === "default")?.shots?.[0];
  const picked = [first(390, "light"), first(1512, "light"), first(2560, "light"), first(1512, "dark")].filter((s): s is string => !!s);
  if (picked.length) return picked;
  // As the engine's pick: the narrowest, the widest, then the others by width, at most six.
  const have = caps.filter((c) => (c.state ?? "default") === "default" && c.shots?.length).sort((a, z) => a.width - z.width);
  return [...new Set([have[0], have.at(-1), ...have].filter((c): c is Capture => !!c).map((c) => c.shots![0]!))].slice(0, 6);
}

/**
 * The bundle of the capture folder `ui`: its report (less the pages that don't fit), run.json, queue.json, the route check's report
 * and the shots the review reads, pages in the run's order until BUNDLE_MAX. `pages`: the pages bundled; `dropped`: those left out.
 */
export function bundle(ui: string, max = BUNDLE_MAX) {
  const report = JSON.parse(readFileSync(join(ui, "report.json"), "utf8")) as UiReport;
  const order = (JSON.parse(readFileSync(join(ui, "run.json"), "utf8")) as { pages?: { path: string }[] }).pages?.map((p) => p.path) ?? [];
  const byPage = new Map<string, Capture[]>();
  for (const c of report.captures) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
  const pages = [...new Set([...order.filter((p) => byPage.has(p)), ...byPage.keys()])];
  const text = ["run.json", "queue.json", "routes/report.json"].filter((f) => existsSync(join(ui, f)));
  let size = statSync(join(ui, "report.json")).size + text.reduce((n, f) => n + statSync(join(ui, f)).size, 0);
  const kept: string[] = [], shots: string[] = [];
  for (const p of pages) {
    const s = shotsFor(byPage.get(p)!).filter((f) => existsSync(join(ui, f)));
    const more = s.reduce((n, f) => n + statSync(join(ui, f)).size + 1024, 0);
    if (size + more > max) break;
    size += more; kept.push(p); shots.push(...s);
  }
  const dropped = pages.filter((p) => !kept.includes(p));
  // A page left out keeps its captures without their shots or motion (nothing for the model), so its rule hits still reach the
  // review step's findings.
  const trimmed = { ...report, captures: report.captures.map((c) => kept.includes(c.page) ? c : { ...c, shots: [], motion: undefined }), dropped };
  const gz = pack([["report.json", Buffer.from(JSON.stringify(trimmed))], ...text.map((f): [string, Buffer] => [f, readFileSync(join(ui, f))]), ...shots.map((f): [string, Buffer] => [f, readFileSync(join(ui, f))])]);
  return { gz, pages: kept, dropped };
}

/** The capture's result: the tree Review's shape with no findings, its coverage the pages listed and those bundled for the review. */
export function captureReport(o: { model: string; repo?: string; head?: string; listed: string[]; pages: string[]; dropped: string[] }) {
  const listed = [...new Set([...o.listed, ...o.pages])], excluded = listed.filter((p) => !o.pages.includes(p));
  const gaps = [
    ...(o.pages.length ? [] : ["no page was captured"]),
    ...(o.dropped.length ? [`${o.dropped.length} captured pages left out of the review to fit a check input (${o.dropped.slice(0, 3).join(", ")}${o.dropped.length > 3 ? ", …" : ""})`] : []),
    ...(excluded.length > o.dropped.length ? [`${excluded.length - o.dropped.length} pages not captured`] : []),
  ];
  return {
    version: 1, ...(o.repo !== undefined ? { repo: o.repo } : {}), ...(o.head !== undefined ? { head: o.head, base: o.head } : {}), target: "tree", engine: "ui-review", model: o.model, effort: "low", pr: 0, incremental_from: null, full: true, addressed: false,
    coverage: { reviewed: o.pages.slice(0, 500), excluded: excluded.slice(0, 500), incomplete: gaps.join("; ").slice(0, 500) || null, counts: { eligible: listed.length, reviewed: o.pages.length } },
    findings: [] as never[], fixed: [] as string[], withheld: { important: 0, nit: 0, pre_existing: 0 }, cost_usd: 0, stale_guidance: [] as string[], guidance: [] as string[],
  };
}

export async function capture({ spec, ws, out, env = process.env }: { spec: UiSpec; ws: string; out: string; env?: NodeJS.ProcessEnv }) {
  let scripts: Record<string, unknown> | undefined, packageManager: unknown;
  try { ({ scripts, packageManager } = JSON.parse(readSmall(join(ws, "package.json"), 1_000_000) ?? "{}") as { scripts?: Record<string, unknown>; packageManager?: unknown }); } catch { /* no start script */ }
  if (typeof scripts?.start !== "string" || !scripts.start.trim()) throw new Error('no start command: add a "start" script to package.json');
  // Yarn and pnpm through corepack, which takes the version package.json names (`packageManager`); a pnpm lockfile older than
  // version 9 with no such field gets pnpm 8, which reads it (a newer pnpm refuses it under --frozen-lockfile).
  const pnpmLock = /lockfileVersion:\s*['"]?(\d+)/.exec(readSmall(join(ws, "pnpm-lock.yaml"), 4096) ?? "")?.[1];
  const pnpm = typeof packageManager === "string" || !pnpmLock || Number(pnpmLock) >= 9 ? "pnpm" : "pnpm@8";
  const [pm, ...via] = existsSync(join(ws, "pnpm-lock.yaml")) ? ["corepack", pnpm] : existsSync(join(ws, "yarn.lock")) ? ["corepack", "yarn"] : ["npm"];
  const install = [...via, ...(pm === "npm" ? [existsSync(join(ws, "package-lock.json")) ? "ci" : "install"] : ["install", "--frozen-lockfile"])];
  const tmp = mkdtempSync(join(env.TMPDIR || "/tmp", "ui-scan-"));
  const ui = join(out, "ui"), url = `http://127.0.0.1:${PORT}`, pagesFile = join(ws, ".aidenhq-ui", "pages.json");
  // The box holds no token; the app and the engine get the tool allowlist's environment all the same, and the image's Chrome.
  const plainEnv = { ...toolEnv(env, tmp), ...(env.AGENT_BROWSER_EXECUTABLE_PATH ? { AGENT_BROWSER_EXECUTABLE_PATH: env.AGENT_BROWSER_EXECUTABLE_PATH } : {}) };
  const ok = (r: { code: number | null; stderr: string; timedOut: boolean; aborted?: string }, what: string, codes = [0, 1]) => {
    if (!codes.includes(r.code ?? -1)) throw new Error(`${what}: ${stopped(r)}${r.stderr.trim() ? `; ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)}` : ""}`);
  };

  ok(await run(pm!, install, { cwd: ws, env: plainEnv, minutes: 12 }), `\`${pm} ${install.join(" ")}\``, [0]);
  // A declared build runs first: `start` serves what it builds.
  if (typeof scripts.build === "string" && scripts.build.trim()) ok(await run(pm!, [...via, "run", "build"], { cwd: ws, env: plainEnv, minutes: 10 }), `\`${pm} run build\``, [0]);
  const stop = await startApp([pm!, ...via], ws, plainEnv);
  let signIn: string[] = [], unsigned: string | undefined;
  try {
    if (spec.option === "ui.scan-signed-in") ({ args: signIn, why: unsigned } = await signInFor(ws, url, tmp, plainEnv));
    // From a folder outside the checkout, so only the committed pages.json (or the crawl) decides the pages.
    ok(await run("ui-review", ["capture", url, "--out", ui, "--commit", spec.head, ...(existsSync(pagesFile) ? ["--pages-file", pagesFile] : []), ...signIn], { cwd: tmp, env: plainEnv, minutes: 25 }), "ui-review capture");
    ok(await run("ui-review", ["routes", url, "--out", join(ui, "routes"), "--pages-file", join(ui, "run.json"), ...signIn], { cwd: tmp, env: plainEnv, minutes: 8 }), "ui-review routes");
  } finally { stop(); }

  const b = bundle(ui);
  writeFileSync(join(out, "keep"), b.gz);
  const queue = JSON.parse(readFileSync(join(ui, "queue.json"), "utf8")) as { page: string }[];
  const r = captureReport({ model: spec.model, repo: spec.repo, head: spec.head, listed: queue.map((i) => i.page), pages: b.pages, dropped: b.dropped });
  if (unsigned) r.coverage.incomplete = [`captured signed out: ${unsigned}`, r.coverage.incomplete].filter(Boolean).join("; ").slice(0, 500);
  return r;
}

/**
 * The signed-in scan's session, from the rungs that need no secret: the repo's committed test user (`.aidenhq-ui/login.json`),
 * else a sign-up at /signup or /register. `args`: the capture's `--session`; `why`: the reason it captures signed out.
 */
async function signInFor(ws: string, url: string, tmp: string, env: Record<string, string>): Promise<{ args: string[]; why?: string }> {
  const state = join(tmp, "state.json"), tried: string[] = [];
  const seed = readSmall(join(ws, ".aidenhq-ui", "login.json"), 10_000);
  if (seed) {
    try {
      const u = JSON.parse(seed) as { url?: unknown; user?: unknown; password?: unknown };
      if (typeof u.url !== "string" || typeof u.user !== "string" || typeof u.password !== "string") throw new Error();
      const pw = join(tmp, "seed-password");
      writeFileSync(pw, u.password, { mode: 0o600 });
      const r = await run("ui-review", ["login", "form", "--url", new URL(u.url, url).href, "--user", u.user, "--password-file", pw, "--out", state], { cwd: tmp, env, minutes: 3 });
      if (r.code === 0) return { args: ["--session", state] };
      tried.push(`the repo's test user didn't sign in (${r.stderr.trim().split("\n").at(-1)?.slice(0, 120) ?? "no reason"})`);
    } catch { tried.push(".aidenhq-ui/login.json isn't { url, user, password }"); }
  }
  for (const path of ["/signup", "/register"]) {
    const r = await run("ui-review", ["login", "signup", "--url", new URL(path, url).href, "--out", state], { cwd: tmp, env, minutes: 3 });
    if (r.code === 0) return { args: ["--session", state] };
    tried.push(`${path}: ${r.stderr.trim().split("\n").at(-1)?.replace(/^ui-review login signup: /, "").slice(0, 120) ?? "no reason"}`);
  }
  return { args: [], why: tried.join("; ") };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const specFile = process.env.AIDENHQ_SPEC, resultFile = process.env.AIDENHQ_RESULT;
  try {
    const spec = JSON.parse(readFileSync(specFile!, "utf8")) as UiSpec;
    const out = dirname(specFile!);
    mkdirSync(join(out, "ui"), { recursive: true });
    const r = await capture({ spec, ws: process.cwd(), out });
    writeFileSync(resultFile!, JSON.stringify(r));
    console.error(`code-review-ui: ${r.coverage.counts.reviewed} of ${r.coverage.counts.eligible} pages bundled for the review${r.coverage.incomplete ? `; incomplete: ${r.coverage.incomplete}` : ""}`);
  } catch (e) {
    console.error(`code-review-ui: no result: ${String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300)}`);
    process.exit(1);
  }
  // The app's processes are gone (its group killed); nothing else may hold the box open.
  process.exit(0);
}
