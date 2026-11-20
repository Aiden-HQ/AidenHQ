// The reviewer-eval gate on the code host (one-way phase 2, W2; from the runner's evalgate.ts): a product PR that brings the
// AI reviewer's own code merges only on a passing reviewer-eval receipt for its head. The eval itself is a kernel check job
// (POST /v1/checks, run "eval"): the kernel lays it out by the judging rules and applies the pass rule (at least 95% of the
// base's cases, every added case, no attack approved), and signs a receipt bound to the head, the
// judging commit and the policy hash. This side decides only who judges what, and verifies the receipt at the merge (POST
// /v1/receipts/verify): a check that is running waits, and so does a transient error (the kernel restarting, a GitHub or git
// blip: the merge queue asks again, bounded by its own eval wait); a check that ran and failed, or a receipt that doesn't hold, stops.
//
// What is judged, always a product commit (the reviewer is the product's modules/ai-reviewer and REVIEWER_CODE), by an
// earlier one:
// - a product PR that changes the reviewer's code: its head, judged by its base branch's tip (never a commit the PR picks, such
//   as an old merge base), receipt for its head and that tip. When the base moves without changing what judges (REVIEWER_TREE's
//   object ids, which hold everything the judged run takes from the judging commit: the base cases and the judge's files), the
//   eval already asked for the head stands (its receipt verified for its own judge); a change to that content runs it again;
// - the release train's bump of the instance's product pin (`bump`) whose reviewer content differs: the new commit, judged by
//   the pinned one, receipt for the new commit. A passing receipt for the same reviewer content (REVIEWER_TREE's object ids),
//   from any head, already covers it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The AI reviewer's own code, as product paths (the official modules sit under modules/ there). */
export const REVIEWER_CODE = [
  /^modules\/ai-reviewer\//,
  /^kernel\/sdk\/src\/(reviewer|pass-rule)\.ts$/,
  /^services\/shared\/review-files\.(mjs|ts)$/,
  /^modules\/github\/service\/src\/(plan\.mjs|merges\.ts|merge-gate\.mjs|evalgate\.ts)$/,
  /^modules\/platform\/(src\/check\.mjs|checks\/)/,
  /^modules\/github\/checks\//,
  /^modules\/(github|platform)\/module\.yaml$/,
  /^scripts\/modules\.mjs$/,
  /^kernel\/src\/checkbox\.ts$/,
  /^kernel\/src\/(tier|provenance|writes|records|reviews|review-loop|kinds|checkjobs|apply|apply-tier)\.ts$/,
  /^scripts\/compiler\/authority\.ts$/,
  // The panel-path registry: a change could take a path out of the panel.
  /^(paths\.yaml|scripts\/paths\.mjs|kernel\/src\/paths\.ts)$/,
];
export const touchesReviewer = (files: string[]) => files.some((f) => REVIEWER_CODE.some((r) => r.test(f)));
/** The reviewer's content in a product commit, by git object id: the same ids are the same reviewer, whatever commit holds them.
 *  It covers all a judging commit gives the eval (the recipe's `judged:` cases and files, all under modules/ai-reviewer). */
const REVIEWER_TREE = ["modules/ai-reviewer", "modules/github/service/src/plan.mjs", "modules/platform/src/check.mjs", "modules/github/checks", "modules/platform/checks", "modules/github/module.yaml", "modules/platform/module.yaml"];
/** The policy whose hash a receipt binds: its git tree id at the commit under test. */
const POLICY = "modules/ai-reviewer/service/security";

export type Gate = undefined | { wait: string } | { stop: string };
type Pr = { number: number; headRefOid: string; baseRefName: string };
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
/** How many times a check that couldn't run is asked for again before the merge stops. */
const ASKS = 3;

export function createEvalGate(d: {
  productRepo?: string;
  /** `ref` (a branch or a commit) of `repo`, fetched into the service's GitHub cache: its bare git dir and the commit. */
  fetch(repo: string, ref: string): Promise<{ dir: string; sha: string }>;
  /** git in that bare dir (SAFE_GIT_ARGS, no config but the service's). */
  git(dir: string, args: string[]): Promise<string>;
  /** The repo's default branch (GitHub). */
  defaultBranch(repo: string): Promise<string>;
  /** The kernel with the module's own token: the JSON answer, or a throw. */
  kernel(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  /** The service's data dir: the reviewer contents a passing receipt covers, and the checks asked for. */
  dir: string;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const log = d.log ?? (() => {});
  mkdirSync(d.dir, { recursive: true });
  const file = join(d.dir, "evals.json");
  const s: { reviewers: Record<string, { head: string; at: string }>; checks: Record<string, { id: string; asks: number; judge: string }> } = (() => { try { return { reviewers: {}, checks: {}, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { return { reviewers: {}, checks: {} }; } })();
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };

  const reviewerAt = async (dir: string, sha: string) => createHash("sha256").update(await d.git(dir, ["ls-tree", sha, "--", ...REVIEWER_TREE])).digest("hex").slice(0, 32);
  const files = async (dir: string, from: string, head: string): Promise<string[]> =>
    (await d.git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", from, head])).split("\0").filter(Boolean);

  /**
   * The verdict of the eval of product commit `head`, judged by `judge`: its kernel receipt decides. A check asked for the same
   * head and policy by a judge with the same judging content is the same eval: it is followed (and its receipt verified for the
   * judge it ran with) rather than asked again.
   */
  async function evaluate(repo: string, head: string, dir: string, judge: string): Promise<Gate> {
    const policy = (await d.git(dir, ["rev-parse", "--verify", `${head}:${POLICY}`])).slice(0, 12);
    const key = `${repo.toLowerCase()}:${head}:${await reviewerAt(dir, judge)}:${policy}`;
    const what = `the reviewer eval on \`${head.slice(0, 12)}\` (it brings the AI reviewer's own code: it lands only on a passing receipt)`;
    const had = s.checks[key];
    // A failed read throws (the merge waits); only a check the kernel no longer knows (404) is asked for again.
    let v = had ? await d.kernel("GET", `/v1/checks/${had.id}`).catch((e) => { if ((e as { status?: number })?.status === 404) return undefined; throw e; }) : undefined;
    if (!v || !["running", "done"].includes(v.state)) {
      // Never asked, or it couldn't run (no box: counted, asked again a few times at most); one the kernel lost at a restart
      // never ran to a verdict, so it is asked again without counting.
      const lost = Boolean(had) && (!v || v.state === "lost");
      if (!lost && (had?.asks ?? 0) >= ASKS) {
        delete s.checks[key]; // a new merge request asks again
        save();
        return { stop: `${what} couldn't run ${ASKS} times (${v?.error ?? v?.state ?? "unknown"})` };
      }
      const spec = { repo, judge_commit: judge, subject_commit: head, cases_from: head, policy_hash: policy };
      v = await d.kernel("POST", "/v1/checks", { repo, head, run: "eval", spec });
      s.checks[key] = { id: String(v.id), asks: (had?.asks ?? 0) + (lost ? 0 : 1), judge };
      save();
      log("reviewer eval asked", { repo, head, judge });
    }
    if (v.state === "running") return { wait: `${what} is running` };
    if (v.state !== "done" || !v.receipt) return { wait: `${what} is being asked for again` };
    const ok = await d.kernel("POST", "/v1/receipts/verify", { receipt: v.receipt, for: { repo, head, run: "eval", judge: s.checks[key]!.judge, policy } });
    if (ok?.ok === true) {
      s.reviewers[await reviewerAt(dir, head)] = { head, at: new Date().toISOString() };
      save();
      return undefined;
    }
    if (v.receipt.verdict === "fail") return { stop: `${String(v.receipt.summary ?? "the reviewer eval didn't pass").slice(0, 8000)}. Fix the reviewer change and push a new head (a new head gets a new eval). A change to an existing case's expectation can't pass here: the owner merges that by hand` };
    return { stop: `the reviewer eval's receipt for \`${head.slice(0, 12)}\` doesn't hold: ${String(ok?.why ?? "the kernel didn't verify it")}` };
  }
  const failClosed = (err: unknown): Gate => ({ wait: `the reviewer-eval gate couldn't read it yet, asking again (${String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200)})` });

  /**
   * The product moving from `from` to `to` (the release train's bump): undefined when the reviewer's content is the same, or a
   * passing receipt covers the new content; else the eval of `to` judged by `from`, receipt for `to`. `to` must be on main.
   */
  async function bump(from: string, to: string): Promise<Gate> {
    if (from === to) return undefined;
    if (!d.productRepo) return { stop: "the product repo isn't set here, so the reviewer-eval gate can't read the bump" };
    try {
      await d.fetch(d.productRepo, from);
      const { dir } = await d.fetch(d.productRepo, to);
      const reviewer = await reviewerAt(dir, to);
      if (reviewer === (await reviewerAt(dir, from))) return undefined;
      const tip = await d.fetch(d.productRepo, await d.defaultBranch(d.productRepo));
      if (!(await d.git(tip.dir, ["merge-base", "--is-ancestor", to, tip.sha]).then(() => true, () => false))) return { stop: `\`${to.slice(0, 12)}\` isn't on ${d.productRepo}'s default branch: a bump names merged commits only` };
      if (s.reviewers[reviewer]) return undefined;
      return await evaluate(d.productRepo, to, dir, from);
    } catch (err) {
      return failClosed(err);
    }
  }

  /** Whether the merge queue may merge this PR at its head now: undefined (yes), { wait } (its eval runs) or { stop }. */
  async function gate(repo: string, pr: Pr): Promise<Gate> {
    if (!same(repo, d.productRepo)) return undefined;
    const head = pr.headRefOid;
    if (!SHA.test(head ?? "")) return { stop: "its head commit couldn't be read for the reviewer-eval gate" };
    if (!BRANCH.test(pr.baseRefName ?? "")) return { stop: "its base branch can't be read for the reviewer-eval gate" };
    try {
      const base = await d.fetch(repo, pr.baseRefName);
      if ((await d.fetch(repo, head)).sha !== head) return { wait: `#${pr.number}'s head isn't at \`${head.slice(0, 12)}\` yet` };
      // What it changes is read from its merge base; it is judged by the base branch's tip, the reviewer it would land on.
      const from = await d.git(base.dir, ["merge-base", base.sha, head]);
      return touchesReviewer(await files(base.dir, from, head)) ? await evaluate(repo, head, base.dir, base.sha) : undefined;
    } catch (err) {
      return failClosed(err);
    }
  }
  return Object.assign(gate, { bump });
}
export type EvalGate = ReturnType<typeof createEvalGate>;
