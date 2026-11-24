// The repo's own tooling (the `actions` setting) and zero-config discovery, read and run through GitHub (`gh`, the owner's calls
// through github's /internal/ship/gh).
//   Actions: per stage (conflict, behind, before_merge) a list of steps, each the repo's own slash command (posted as a comment) or
//   one of its workflows (dispatched on the PR's head branch). A step runs before ship's own step for that stage and only when the
//   round needs that stage, on an adopted PR. Ship then waits: a new head (the repo's bot pushed it), or the run concluding. A head a
//   step produced never runs the stage again, so ship's own step (the no-model repair, update-branch, the merge) follows there. A
//   step that fails or times out moves on to the next; past the last, ship's own step follows (before_merge: the PR holds).
//   Discovery: discover() on the target branch's own files, once per repo, read again when those files change (their blob shas).
import { discover, type Discovered } from "./discover.ts";
import type { PrView } from "./handoff.ts";
import type { ActionStep, STAGES } from "./settings.ts";

export type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
export type Stage = (typeof STAGES)[number];
/** The stage's run on the adoption: which step, at which head, since when, and how it ended. */
export interface ActionRun { stage: Stage; head: string; step: number; at: string; outcome?: "ok" | "failed"; why?: string; made?: string; steps?: string }

/** As long as ship's own repair job may run (module.yaml `ship-repair` timeout_min). */
export const STEP_WAIT_MS = 30 * 60_000;

/** The stage a round's decision needs, if any. */
export function stageOf(v: string, dirty?: boolean): Stage | undefined {
  return v === "repair" ? (dirty ? "conflict" : "behind") : v === "merge" || v === "enqueue" ? "before_merge" : undefined;
}

const label = (x: ActionStep) => ("comment" in x ? `posted \`${x.comment}\`` : `ran the \`${x.workflow}\` workflow`);

/**
 * Advances a stage's steps at this head. `start()` is asked before a step starts (false: the round cap is reached).
 *   started: a step was just started; waiting: one is in flight; ok / failed: the stage is over at this head (ship's own step
 *   follows; for before_merge a failure holds); skip: nothing to run here (this head is a step's own); capped: the round cap.
 */
export async function advance(gh: Gh, pr: PrView, stage: Stage, steps: ActionStep[], rec: ActionRun | undefined, start: () => boolean, now = Date.now()): Promise<{ go: "started" | "waiting" | "ok" | "failed" | "skip" | "capped"; rec?: ActionRun; did?: string }> {
  // A run of the same steps (a changed setting starts over).
  const sig = JSON.stringify(steps);
  const mine = rec?.stage === stage && rec.steps === sig ? rec : undefined;
  if (mine?.made === pr.head) return { go: "skip", rec };
  // The head moved while a conflict or behind step was in flight: the repo's bot pushed it, and ship's own step follows there (it
  // is ship's anyway, so a push by someone else loses nothing). Before a merge a new head proves nothing: the stage runs again.
  if (mine && mine.head !== pr.head && !mine.outcome && stage !== "before_merge") return { go: "skip", rec: { ...mine, made: pr.head } };
  if (mine && mine.head === pr.head) {
    if (mine.outcome) return { go: mine.outcome, rec };
    const s = steps[mine.step];
    const r = s && "workflow" in s ? await runOf(gh, pr, s.workflow, mine.at) : undefined;
    if (r?.status === "completed" && r.conclusion === "success") return { go: "ok", rec: { ...mine, outcome: "ok" }, did: `the repo's \`${(s as { workflow: string }).workflow}\` finished at \`${pr.head.slice(0, 12)}\`` };
    const failed = r?.status === "completed" ? `ended ${r.conclusion}` : now - Date.parse(mine.at) > STEP_WAIT_MS ? "timed out" : undefined;
    if (!failed) return { go: "waiting", rec };
    return next(gh, pr, stage, steps, mine.step + 1, start, now, `step ${mine.step + 1} ${failed}`);
  }
  return next(gh, pr, stage, steps, 0, start, now);
}

async function next(gh: Gh, pr: PrView, stage: Stage, steps: ActionStep[], from: number, start: () => boolean, now: number, why?: string): Promise<{ go: "started" | "failed" | "capped"; rec?: ActionRun; did?: string }> {
  for (let i = from; i < steps.length; i++) {
    const s = steps[i]!;
    // A workflow runs in the base repo: a fork's branch isn't there.
    if ("workflow" in s && pr.fork) { why = `\`${s.workflow}\` can't run on a fork's branch`; continue; }
    if (!start()) return { go: "capped" };
    const at = new Date(now).toISOString();
    try {
      if ("comment" in s) await must(gh, "POST", `/repos/${pr.repo}/issues/${pr.number}/comments`, { body: s.comment });
      else {
        const ref = String((await must(gh, "GET", `/repos/${pr.repo}/pulls/${pr.number}`)).head?.ref ?? "");
        await must(gh, "POST", `/repos/${pr.repo}/actions/workflows/${s.workflow}/dispatches`, { ref, ...(s.inputs ? { inputs: s.inputs } : {}) });
      }
      return { go: "started", rec: { stage, head: pr.head, step: i, at, steps: JSON.stringify(steps) }, did: `${label(s)} (${stage.replace("_", " ")}) at \`${pr.head.slice(0, 12)}\`` };
    } catch (e) {
      why = `${label(s)} failed: ${String((e as Error).message).slice(0, 200)}`;
    }
  }
  return { go: "failed", rec: { stage, head: pr.head, step: steps.length, at: new Date(now).toISOString(), steps: JSON.stringify(steps), outcome: "failed", ...(why ? { why } : {}) }, ...(why ? { did: `the repo's ${stage.replace("_", " ")} steps didn't settle it (${why})` } : {}) };
}

async function must(gh: Gh, method: string, path: string, body?: unknown) {
  const r = await gh(method, path, body);
  if (r.status >= 300) throw new Error(`GitHub ${method} ${path}: ${r.status} ${String(r.body?.message ?? "").slice(0, 200)}`);
  return r.body;
}

/** The workflow's dispatched run on the PR's head: the first one since the step started (GitHub gives no run id on dispatch). */
async function runOf(gh: Gh, pr: PrView, workflow: string, since: string) {
  const r = await gh("GET", `/repos/${pr.repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(since.slice(0, 19))}Z&per_page=20`);
  const runs = (r.status < 300 ? r.body?.workflow_runs ?? [] : []) as { status: string; conclusion: string | null; head_sha: string; created_at: string }[];
  return runs.filter((x) => x.head_sha === pr.head && x.created_at >= since.slice(0, 19)).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
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
  const tree = await must(gh, "GET", `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const files = ((tree.tree ?? []) as { path: string; type: string; sha: string }[]).filter((e) => e.type === "blob" && WANTED(e.path)).slice(0, 80);
  const fp = files.map((f) => `${f.path}:${f.sha}`).join("\n");
  if (hit && hit.fp === fp) { cache.set(k, { ...hit, at: now }); return hit.d; }
  const texts: Record<string, string> = {};
  for (const f of files) texts[f.path] = Buffer.from(String((await must(gh, "GET", `/repos/${repo}/git/blobs/${f.sha}`)).content ?? ""), "base64").toString("utf8");
  const d = discover(texts);
  cache.set(k, { fp, at: now, d });
  return d;
}

/** The report's lines proposing the repo's own commands as `actions` steps (never enabled by ship itself). */
export function suggestLines(d: Discovered | undefined, configured: Partial<Record<Stage, ActionStep[]>>): string[] {
  return (d?.suggest ?? []).filter((x) => !(configured[x.stage] ?? []).length).map((x) => `\`actions: { ${x.stage}: [${JSON.stringify(x.step)}] }\` (found in \`${x.from}\`)`);
}
