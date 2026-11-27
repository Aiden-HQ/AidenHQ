// The repo's own tooling (the `actions` setting) and zero-config discovery, read and run through GitHub (`gh`, the owner's calls
// through github's /internal/ship/gh).
//   Actions: per stage (conflict, behind, before_merge) a list of steps, each one of the repo's workflows, dispatched on the PR's
//   base branch (the repo's own copy of the workflow: a PR can't change what runs with the repo's secrets, and a branch made before
//   the workflow took `workflow_dispatch` needn't have it) with the PR named by an input (`{pr}`), and `return_run_details` so
//   GitHub answers the run's id. A step runs before ship's own step for that stage and only
//   when the round needs that stage, on an adopted PR. Ship then reads that run: success ends the stage; any other conclusion, or no
//   end within STEP_WAIT_MS, moves on to the next step, and past the last ship's own step follows on the same pass (before_merge:
//   the PR holds). A new head (the repo's workflow pushed it) ends a conflict or behind stage too. A head a step produced never runs
//   the stage again, so ship's own step (the no-model repair, update-branch, the merge) follows there.
//   Discovery: discover() on the target branch's own files, once per repo, read again when those files change (their blob shas).
import { discover, type Discovered } from "./discover.ts";
import type { PrView } from "./handoff.ts";
import type { ActionStep, STAGES } from "./settings.ts";

export type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type Stage = (typeof STAGES)[number];
/** The stage's run on the adoption: which step, its workflow run, at which head, since when, and how it ended. */
export interface ActionRun { stage: Stage; head: string; step: number; at: string; run?: number; outcome?: "ok" | "failed"; why?: string; made?: string; steps?: string }

/** How long a dispatched run may take before ship moves on (as long as ship's own repair job may run: module.yaml `ship-repair`). */
export const STEP_WAIT_MS = 30 * 60_000;

/** The stage a round's decision needs, if any. */
export function stageOf(v: string, dirty?: boolean): Stage | undefined {
  return v === "repair" ? (dirty ? "conflict" : "behind") : v === "merge" || v === "enqueue" ? "before_merge" : undefined;
}

/** A step's inputs as dispatched: `{pr}` is the PR's number. */
export const inputsOf = (s: ActionStep, pr: Pick<PrView, "number">) => (s.inputs ? Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, v.replaceAll("{pr}", String(pr.number))])) : undefined);

/**
 * Advances a stage's steps at this head. `start()` is asked before a step starts (false: the round cap is reached).
 *   started: a step was just started; waiting: its run is in flight; ok / failed: the stage is over at this head (ship's own step
 *   follows; for before_merge a failure holds); skip: nothing to run here (this head is a step's own); capped: the round cap.
 */
export async function advance(gh: Gh, pr: PrView, stage: Stage, steps: ActionStep[], rec: ActionRun | undefined, start: () => boolean, now = Date.now()): Promise<{ go: "started" | "waiting" | "ok" | "failed" | "skip" | "capped"; rec?: ActionRun; did?: string }> {
  // A run of the same steps (a changed setting starts over).
  const sig = JSON.stringify(steps);
  const mine = rec?.stage === stage && rec.steps === sig ? rec : undefined;
  if (mine?.made === pr.head) return { go: "skip", rec };
  // The head moved while a conflict or behind step was in flight: the repo's workflow pushed it, and ship's own step follows there
  // (it is ship's anyway, so a push by someone else loses nothing). The run ends there, so a later head runs the stage again.
  // Before a merge a new head proves nothing: the stage runs again.
  if (mine && mine.head !== pr.head && !mine.outcome && stage !== "before_merge") return { go: "skip", rec: { ...mine, made: pr.head, outcome: "ok" } };
  if (mine && mine.head === pr.head) {
    if (mine.outcome) return { go: mine.outcome, rec };
    const s = steps[mine.step]!;
    // The run GitHub named when it was dispatched. A read that fails is asked again next pass, until the step's time is up.
    const r = mine.run ? await gh("GET", `/repos/${pr.repo}/actions/runs/${mine.run}`) : undefined;
    const run = r && r.status < 300 ? (r.body as { status?: string; conclusion?: string | null }) : undefined;
    if (run?.status === "completed" && run.conclusion === "success") return { go: "ok", rec: { ...mine, outcome: "ok" }, did: `the repo's \`${s.workflow}\` finished at \`${pr.head.slice(0, 12)}\`` };
    const failed = run?.status === "completed" ? `ended ${run.conclusion ?? "without a conclusion"}` : now - Date.parse(mine.at) > STEP_WAIT_MS ? "timed out" : undefined;
    if (!failed) return { go: "waiting", rec };
    return next(gh, pr, stage, steps, mine.step + 1, start, now, `\`${s.workflow}\` ${failed}`);
  }
  return next(gh, pr, stage, steps, 0, start, now);
}

async function next(gh: Gh, pr: PrView, stage: Stage, steps: ActionStep[], from: number, start: () => boolean, now: number, why?: string): Promise<{ go: "started" | "failed" | "capped"; rec?: ActionRun; did?: string }> {
  for (let i = from; i < steps.length; i++) {
    const s = steps[i]!;
    if (!start()) return { go: "capped" };
    const at = new Date(now).toISOString();
    try {
      const inputs = inputsOf(s, pr);
      // On the base branch, the PR named by its inputs. GitHub answers the run it started (200, `workflow_run_id`); an answer
      // without one is a step that can't be followed.
      const d = await must(gh, "POST", `/repos/${pr.repo}/actions/workflows/${s.workflow}/dispatches`, { ref: pr.base, ...(inputs ? { inputs } : {}), return_run_details: true });
      const run = Number(d?.workflow_run_id);
      if (!Number.isSafeInteger(run) || run <= 0) throw new Error("GitHub started it without naming its run");
      return { go: "started", rec: { stage, head: pr.head, step: i, at, run, steps: JSON.stringify(steps) }, did: `ran the \`${s.workflow}\` workflow (${stage.replace("_", " ")}) at \`${pr.head.slice(0, 12)}\`` };
    } catch (e) {
      why = `the \`${s.workflow}\` workflow failed: ${String((e as Error).message).slice(0, 200)}`;
    }
  }
  return { go: "failed", rec: { stage, head: pr.head, step: steps.length, at: new Date(now).toISOString(), steps: JSON.stringify(steps), outcome: "failed", ...(why ? { why } : {}) }, ...(why ? { did: `the repo's ${stage.replace("_", " ")} steps didn't settle it (${why})` } : {}) };
}

async function must(gh: Gh, method: string, path: string, body?: unknown) {
  const r = await gh(method, path, body);
  if (r.status >= 300) throw new Error(`GitHub ${method} ${path}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`);
  return r.body;
}

// ---- Discovery ----

/** The files discovery reads on the target branch: .gitattributes, the workflows, Makefiles, package.json and AGENTS.md near the top. */
const WANTED = (p: string) => {
  const depth = p.split("/").length - 1;
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (p.includes("node_modules/") || p.includes("vendor/")) return false;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return true;
  return depth <= 2 && (name === ".gitattributes" || /^(GNU)?[Mm]akefile$/.test(name) || name === "package.json" || (name === "AGENTS.md" && depth === 0));
};
const RECHECK_MS = 10 * 60_000;
const cache = new Map<string, { fp: string; at: number; d: Discovered }>();

/** discover() on `branch`'s own files, cached per repo and read again when those files change (checked at most every 10 minutes). */
export async function discovered(gh: Gh, repo: string, branch: string, now = Date.now()): Promise<Discovered> {
  const k = `${repo.toLowerCase()}@${branch}`;
  const hit = cache.get(k);
  if (hit && now - hit.at < RECHECK_MS) return hit.d;
  // The branch's tip by its ref (any branch name), then its tree by commit: a name never goes into the tree's path.
  const tip = String((await must(gh, "GET", `/repos/${repo}/git/ref/heads/${branch}`)).object?.sha ?? "");
  const tree = await must(gh, "GET", `/repos/${repo}/git/trees/${tip}?recursive=1`);
  const files = ((tree.tree ?? []) as { path: string; type: string; sha: string }[]).filter((e) => e.type === "blob" && WANTED(e.path)).slice(0, 80);
  const fp = files.map((f) => `${f.path}:${f.sha}`).join("\n");
  if (hit && hit.fp === fp) { cache.set(k, { ...hit, at: now }); return hit.d; }
  const texts: Record<string, string> = {};
  for (const f of files) texts[f.path] = Buffer.from(String((await must(gh, "GET", `/repos/${repo}/git/blobs/${f.sha}`)).content ?? ""), "base64").toString("utf8");
  const d = discover(texts);
  cache.set(k, { fp, at: now, d });
  return d;
}

/** The report's lines proposing the repo's own workflows as `actions` steps (never enabled by ship itself). */
export function suggestLines(d: Discovered | undefined, configured: Partial<Record<Stage, ActionStep[]>>): string[] {
  return (d?.suggest ?? []).filter((x) => !(configured[x.stage] ?? []).length).map((x) => `\`actions: { ${x.stage}: [${JSON.stringify(x.step)}] }\` (found in \`${x.from}\`)`);
}
