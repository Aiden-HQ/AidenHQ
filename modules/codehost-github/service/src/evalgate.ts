// The reviewer-eval gate on the code host (one-way phase 2, W2; from the runner's evalgate.ts): a product or official modules
// PR that brings the AI reviewer's own code merges only on a passing reviewer-eval receipt for its head. The eval itself is a
// kernel check job (POST /v1/checks, run "eval"): the kernel lays it out by the judging rules and applies the pass rule (at
// least 95% of the base's cases, every added case, each miss a false block of a clean case), and signs a receipt bound to the
// head, the judging commit and the policy hash. This side decides only who judges what, and verifies the receipt at the merge
// (POST /v1/receipts/verify): a check that is running waits; anything it can't read, run or verify stops (fails closed).
//
// What is judged, always a commit of the official modules repo (where the reviewer lives), by an earlier one:
// - a modules PR that changes the reviewer: its head, judged by its base branch, receipt for its head;
// - a product PR that changes the product's reviewer code (REVIEWER_CODE): the modules commit its merge would pin, judged by
//   the base's pin, receipt for the product head;
// - a modules pin bump (a product PR moving modules-pin.json; an apply moving the official modules, `bump`) whose reviewer
//   content differs: the new commit, judged by the old one, receipt for that modules commit. A passing receipt for the same
//   reviewer content (REVIEWER_TREE's object ids), from any head, already covers it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The AI reviewer's own code, as product paths (the official modules sit under modules/ there). */
export const REVIEWER_CODE = [
  /^modules\/ai-reviewer\//,
  /^kernel\/sdk\/src\/reviewer\.ts$/,
  /^services\/shared\/review-files\.(mjs|ts)$/,
  /^services\/runner\/src\/(review-request|siblings|cards)\.(mjs|ts)$/,
  /^services\/runner\/src\/(tiers|gate-core)\.(mjs|ts)$/,
  /^modules\/codehost-github\/(service\/)?src\/plan\.mjs$/,
  /^modules\/platform\/src\/check\.mjs$/,
  /^kernel\/src\/(tier|writes|records|reviews|kinds|checkjobs)\.ts$/,
  /^kernel\/src\/loader\/authority\.ts$/,
];
export const touchesReviewer = (files: string[]) => files.some((f) => REVIEWER_CODE.some((r) => r.test(f)));
/** The same, for a path in the official modules repo (its modules sit at its root). */
export const touchesModulesReviewer = (files: string[]) => touchesReviewer(files.map((f) => `modules/${f}`));
/** The reviewer's content in a modules commit, by git object id: the same ids are the same reviewer, whatever commit holds them. */
const REVIEWER_TREE = ["ai-reviewer", "codehost-github/src/plan.mjs", "codehost-github/service/src/plan.mjs", "platform/src/check.mjs"];
/** The policy whose hash a receipt binds: its git tree id at the commit under test. */
const POLICY = "ai-reviewer/service/security";

export type Gate = undefined | { wait: string } | { stop: string };
export type ModulesAt = { repo: string | undefined; sha: string };
type Pr = { number: number; headRefOid: string; baseRefName: string };
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
/** How many times a check that couldn't run is asked for again before the merge stops. */
const ASKS = 3;

export function createEvalGate(d: {
  productRepo?: string; modulesRepo?: string;
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
  const s: { reviewers: Record<string, { head: string; at: string }>; checks: Record<string, { id: string; asks: number }> } = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { reviewers: {}, checks: {} };
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };

  const official = (m: ModulesAt, what: string): Gate => (d.modulesRepo && same(m.repo, d.modulesRepo) ? undefined : { stop: `${what} takes the official modules from \`${m.repo ?? "somewhere else"}\`, not \`${d.modulesRepo ?? "(unknown)"}\`, so the reviewer-eval gate can't vouch for the AI reviewer it brings` });
  async function pinAt(dir: string, rev: string): Promise<ModulesAt> {
    const p = JSON.parse(await d.git(dir, ["show", `${rev}:modules-pin.json`]));
    if (!SHA.test(String(p?.sha ?? ""))) throw new Error(`${rev.slice(0, 12)}'s modules-pin.json names no commit`);
    return { repo: String(p.repo ?? ""), sha: p.sha };
  }
  const reviewerAt = async (dir: string, sha: string) => createHash("sha256").update(await d.git(dir, ["ls-tree", sha, "--", ...REVIEWER_TREE])).digest("hex").slice(0, 32);
  async function files(dir: string, base: string, head: string): Promise<string[]> {
    const mb = await d.git(dir, ["merge-base", base, head]);
    return (await d.git(dir, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", mb, head])).split("\0").filter(Boolean);
  }
  /** The official modules repo's commits, fetched; its bare dir. */
  async function modules(...shas: string[]): Promise<string> {
    let dir = "";
    for (const sha of shas) dir = (await d.fetch(d.modulesRepo!, sha)).dir;
    return dir;
  }
  /** A pin names only what the modules repo merged: a commit on its default branch. */
  async function merged(sha: string): Promise<Gate> {
    const tip = await d.fetch(d.modulesRepo!, await d.defaultBranch(d.modulesRepo!));
    const ok = await d.git(tip.dir, ["merge-base", "--is-ancestor", sha, tip.sha]).then(() => true, () => false);
    return ok ? undefined : { stop: `it pins modules commit \`${sha.slice(0, 12)}\`, which isn't on ${d.modulesRepo}'s default branch: pins name merged commits only` };
  }

  /** The verdict of the eval of modules commit `subject`, judged by `judge`, for `repo@head`: its kernel receipt decides. */
  async function evaluate(repo: string, head: string, mdir: string, subject: string, judge: string): Promise<Gate> {
    const policy = (await d.git(mdir, ["rev-parse", "--verify", `${subject}:${POLICY}`])).slice(0, 12);
    const spec = { repo: d.modulesRepo, judge_commit: judge, subject_commit: subject, cases_from: subject, policy_hash: policy };
    const key = `${repo.toLowerCase()}:${head}:${judge}:${policy}`;
    const what = `the reviewer eval on \`${head.slice(0, 12)}\` (it brings the AI reviewer's own code, modules \`${subject.slice(0, 12)}\`: it lands only on a passing receipt)`;
    const had = s.checks[key];
    let v = had ? await d.kernel("GET", `/v1/checks/${had.id}`).catch(() => undefined) : undefined;
    if (!v || !["running", "done"].includes(v.state)) {
      // Never asked, or it couldn't run (the kernel lost it, or no box): asked again, a few times at most.
      if ((had?.asks ?? 0) >= ASKS) {
        delete s.checks[key]; // a new merge request asks again
        save();
        return { stop: `${what} couldn't run ${ASKS} times (${v?.error ?? v?.state ?? "unknown"})` };
      }
      v = await d.kernel("POST", "/v1/checks", { repo, head, run: "eval", spec });
      s.checks[key] = { id: String(v.id), asks: (had?.asks ?? 0) + 1 };
      save();
      log("reviewer eval asked", { repo, head, subject, judge });
    }
    if (v.state === "running") return { wait: `${what} is running` };
    if (v.state !== "done" || !v.receipt) return { wait: `${what} is being asked for again` };
    const ok = await d.kernel("POST", "/v1/receipts/verify", { receipt: v.receipt, for: { repo, head, run: "eval", judge, policy } });
    if (ok?.ok === true) {
      s.reviewers[await reviewerAt(mdir, subject)] = { head, at: new Date().toISOString() };
      save();
      return undefined;
    }
    if (v.receipt.verdict === "fail") return { stop: `${String(v.receipt.summary ?? "the reviewer eval didn't pass").slice(0, 8000)}. Fix the reviewer change and push a new head (a new head gets a new eval). A change to an existing case's expectation can't pass here: the owner merges that by hand` };
    return { stop: `the reviewer eval's receipt for \`${head.slice(0, 12)}\` doesn't hold: ${String(ok?.why ?? "the kernel didn't verify it")}` };
  }
  const failClosed = (err: unknown): Gate => ({ stop: `the reviewer-eval gate couldn't read it (${String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200)})` });

  /**
   * A modules pin moving from `from` to `to` (a product PR's modules-pin.json, an apply): undefined when the reviewer's content
   * is the same, or a passing receipt covers the new content; else the eval of `to` judged by `from`, receipt for `to`.
   */
  async function bump(from: ModulesAt, to: ModulesAt, what = "the change"): Promise<Gate> {
    if (same(from.repo, to.repo) && from.sha === to.sha) return undefined;
    const notOfficial = official(from, what) ?? official(to, what);
    if (notOfficial) return notOfficial;
    try {
      const dir = await modules(from.sha, to.sha);
      const reviewer = await reviewerAt(dir, to.sha);
      if (reviewer === (await reviewerAt(dir, from.sha))) return undefined;
      const unmerged = await merged(to.sha);
      if (unmerged) return unmerged;
      if (s.reviewers[reviewer]) return undefined;
      return await evaluate(d.modulesRepo!, to.sha, dir, to.sha, from.sha);
    } catch (err) {
      return failClosed(err);
    }
  }

  /** Whether the merge queue may merge this PR at its head now: undefined (yes), { wait } (its eval runs) or { stop }. */
  async function gate(repo: string, pr: Pr): Promise<Gate> {
    const product = same(repo, d.productRepo);
    if (!product && !same(repo, d.modulesRepo)) return undefined;
    const head = pr.headRefOid;
    if (!SHA.test(head ?? "")) return { stop: "its head commit couldn't be read for the reviewer-eval gate" };
    if (!BRANCH.test(pr.baseRefName ?? "")) return { stop: "its base branch can't be read for the reviewer-eval gate" };
    try {
      const base = await d.fetch(repo, pr.baseRefName);
      if ((await d.fetch(repo, head)).sha !== head) return { wait: `#${pr.number}'s head isn't at \`${head.slice(0, 12)}\` yet` };
      const changed = await files(base.dir, base.sha, head);
      if (!product) return touchesModulesReviewer(changed) ? await evaluate(repo, head, base.dir, head, base.sha) : undefined;
      if (!changed.includes("modules-pin.json") && !touchesReviewer(changed)) return undefined;
      const judge = await pinAt(base.dir, base.sha);
      const lands = changed.includes("modules-pin.json") ? await pinAt(base.dir, head) : judge;
      if (!touchesReviewer(changed)) return await bump(judge, lands, `#${pr.number}`);
      const notOfficial = official(judge, `#${pr.number}'s base`) ?? official(lands, `#${pr.number}`);
      if (notOfficial) return notOfficial;
      const mdir = await modules(judge.sha, lands.sha);
      const unmerged = lands.sha === judge.sha ? undefined : await merged(lands.sha);
      return unmerged ?? (await evaluate(repo, head, mdir, lands.sha, judge.sha));
    } catch (err) {
      return failClosed(err);
    }
  }
  return Object.assign(gate, { bump });
}
export type EvalGate = ReturnType<typeof createEvalGate>;
