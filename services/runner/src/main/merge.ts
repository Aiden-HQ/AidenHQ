import { join } from "node:path";
import { finishedStatus, isAgentSubtask, engineLabel, repoAllowed } from "../agents.mjs";
import { REPO_ROOT } from "../config.mjs";
import { hiding } from "../../../../kernel/src/sandbox.ts";
import { ensureClone, git, replayOnto } from "../../../../modules/codehost-github/src/git.mjs";
import { READ, WRITE, appRemoteUrl, mergePermissions } from "../../../../modules/codehost-github/src/github-app.ts";
import { appliedNote } from "../prompt.ts";
import { UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import * as merges from "../../../../modules/codehost-github/src/merge-gate.mjs";
import * as prQueue from "../../../../modules/engineering/src/merge-queue.mjs";
import { BASE_FILES_QUERY, baseFilesSince } from "../siblings.ts";
import { createEvalGate } from "../evalgate.ts";
import { normalizeRepo } from "../../../../modules/codehost-github/src/repos.ts";
import { RERUN, STATUS, appFor, botIdentity, cfg, evalSandbox, execFileP, gho, ghoMerge, log, ownRepo, pc, running, state } from "./context.ts";
import { reportActivity, reportUsage } from "./activity.ts";
import { designReviewer, fileDesignReviewTask } from "./watch.ts";
import { redHead, stopped, wakeForRedChecks, wakeForTurnedAway } from "./breaker.ts";
import { autonomyNow, fileApproval, findRealGh, graded, mayClose, mergeTierState, refusedForGood, reportOutcome, tellParent, tierFor, withTrusted } from "./unsplit.ts";

// ------------------------------------------------------------------ merges

const mergeCheck = { last: 0 };
const mergeQueue = (issueId: any) => (state.get(`merges:${issueId}`) ? JSON.parse(state.get(`merges:${issueId}`)) : undefined);
const activeMerges = () => JSON.parse(state.get("merges:active") || "[]");
function saveMerges(issueId: any, queue: any) {
  state.set(`merges:${issueId}`, JSON.stringify(queue));
  const active = activeMerges().filter((id: any) => id !== issueId);
  state.set("merges:active", JSON.stringify(queue.state === "running" || queue.held ? [...active, issueId] : active));
}

/**
 * The PRs the agent queued with `aidenhq merge` (the user's words allowed it), in its order, or
 * carrying on with a stopped queue. advanceMerges() does the merging, one poll at a time.
 * `each`: a Tier 0 agents-org merge (owner, 2026-11-12), an independent queue that starts even during the task's run:
 * merges are GitHub calls, not workspace changes.
 */
async function startMerges(issue: any, { prs = [], gapMinutes, strict = false, each = false, during = false }: any = {}) {
  const existing = mergeQueue(issue.id);
  const outside = prs.filter((p: any) => !repoAllowed(normalizeRepo(p.repo), cfg.allowed_orgs));
  if (outside.length) return void (await pc.comment(issue.id, `I only merge in your orgs (${cfg.allowed_orgs.join(", ")}), so I didn't start: ${outside.map((p: any) => p.url).join(", ")}.`));
  // `during`: an approved product PR card's merge (mergeAfterPublish), bound to its heads, may start whatever runs then.
  if (!each && !during && running.has(issue.id)) return void (await pc.comment(issue.id, "Can't start merging while a run is in progress on this task. Comment **stop** first, or wait for it to finish."));
  // A card's queue replaces a running independent one: its waiting PRs are requested again, and start once the card's ends.
  if (!each && existing?.independent && existing.state === "running") {
    const waiting = existing.prs.filter((p: any) => p.status === "pending" && !prs.some((n: any) => n.url.toLowerCase() === p.url.toLowerCase()));
    if (waiting.length) requestAutoMerge(issue, waiting);
  }
  const queue = each ? prQueue.addEach(existing, prs) : prQueue.startOrResume(existing, prs, { gapMinutes: gapMinutes ?? existing?.gapMinutes ?? cfg.merges?.gap_minutes ?? 15 });
  // Undefined both when every named PR merged and when none was named (and nothing earlier is waiting): say which.
  if (!queue) return void (await pc.comment(issue.id, prs.length ? "Nothing to merge: those PRs are merged already." : "Nothing to merge: no PR was named, and no earlier merge is waiting. Name the PRs (`aidenhq merge <PR link> …`)."));
  const engine = state.task(issue.id)?.engine;
  // strict: a merge the AI reviewer approved merges only with named checks, all green.
  Object.assign(queue, { identifier: issue.identifier, engine: engine ? engineLabel(engine) : undefined, strict: strict || Boolean(queue.strict) });
  saveMerges(issue.id, queue);
  const pending = queue.prs.filter((p: any) => p.status === "pending");
  // An independent queue: the publish (or the agent's own request) already said so on the task.
  if (!each) {
    await pc.startWork(
      issue.id,
      `${existing && !prs.length ? "Carrying on" : "On it"}: merging ${pending.length} PR${pending.length === 1 ? "" : "s"} one at a time${pending.length > 1 && queue.gapMinutes ? `, at least ${queue.gapMinutes} minutes apart` : ""}, in this order: ${pending.map((p: any) => `#${p.number}`).join(", ")}. Each one has to be approved with green checks, and its base branch green before and after it. If anything isn't, I stop and tell you here.`,
    );
  }
  log("merges started", { issue: issue.identifier, prs: pending.length, gap: queue.gapMinutes, each });
  mergeCheck.last = 0; // start right away
  reportActivity();
  return true;
}

/**
 * Merges in the agents org (owner, 2026-11-12): an Engineer's PR there ends merged, as soon as its CI is green. A request
 * (the runner's own after it publishes to an open PR, or the agent's `aidenhq merge` at Tier 0) is picked up by
 * runAutoMerges, which binds each PR's head and tiers each PR on its own: Tier 0 starts an independent strict queue at
 * once, even during the task's run, with an audit row; red checks are a comment and anything higher a card, both once the
 * run is over (as before).
 */
function requestAutoMerge(issue: any, prs: any, gap?: any) {
  const box = JSON.parse(state.get("auto_merges") || "{}");
  // A PR asked for again is tiered again, even during a run.
  const was = (box[issue.id]?.prs ?? []).map(({ afterRun, ...w }: any) => (prs.some((p: any) => p.url.toLowerCase() === w.url.toLowerCase()) ? w : { ...w, ...(afterRun ? { afterRun } : {}) }));
  const fresh = prs.filter((p: any) => !was.some((w: any) => w.url.toLowerCase() === p.url.toLowerCase()));
  box[issue.id] = { prs: [...was, ...fresh.map(({ repo, number, url }: any) => ({ repo, number, url }))], ...(gap !== undefined ? { gap } : {}), since: new Date().toISOString() };
  state.set("auto_merges", JSON.stringify(box));
}

/** A queue entry as the board takes it: the fields its merge args schema has, never the runner's own flags (`ui`). */
const cardPr = ({ repo, number, url, head, noReview, patch }: any) => ({ repo, number, url, ...(head ? { head } : {}), ...(noReview ? { noReview } : {}), ...(patch ? { patch } : {}) });

async function runAutoMerges() {
  const box: any = JSON.parse(state.get("auto_merges") || "{}");
  for (const [issueId, want] of (Object.entries(box) as any)) {
    const busy = running.has(issueId);
    const off = autonomyNow() === "off";
    // During the run only Tier 0 starts: a PR tiered higher waits for its end (afterRun), and with autonomy off every PR does.
    const todo = busy ? want.prs.filter((p: any) => !p.afterRun) : want.prs;
    if (!todo.length || (busy && off)) continue;
    // A card's queue running on the task: requests wait until it ends, rather than mixing the two.
    const q = mergeQueue(issueId);
    if (q?.state === "running" && !q.independent) continue;
    const save = (fn: any) => {
      const now = JSON.parse(state.get("auto_merges") || "{}");
      fn(now);
      state.set("auto_merges", JSON.stringify(now));
    };
    try {
      const issue = await pc.issue(issueId);
      const sameUrl = (a: any, b: any) => a.url.toLowerCase() === b.url.toLowerCase();
      const gone = [];
      const read = [];
      for (const p of todo) {
        const pr = (await mergeGithub.pr(p.repo, p.number))?.repository?.pullRequest;
        if (pr?.state === "MERGED" || pr?.state === "CLOSED") gone.push(p);
        else if (!/^[0-9a-f]{40}$/.test(pr?.headRefOid ?? "")) throw new UserError(`couldn't read ${p.url} on GitHub`);
        else read.push({ repo: p.repo, number: p.number, url: p.url, head: pr.headRefOid, noReview: true });
      }
      const states = await mergeTierState(read);
      // CI starts a little after a push: a PR without named checks gets a few minutes before that counts; the others go on.
      const early = Date.now() - Date.parse(want.since) < 5 * 60_000;
      const ready = read.map((p, i) => [p, states[i]]).filter(([, s]) => !(early && s.headMatches && !s.checks.length));
      if (!ready.length && !gone.length) continue;
      // A UI PR's Tier 0 merge waits for the design review (merges.mjs eachDecision) when the fleet has a design reviewer; the
      // flag is set either way, so a fleet without one merges as before. `ui` is the queue's own flag, never the board's: the
      // card's args are its schema, which knows only repo, number, url, head and noReview.
      const reviewer = designReviewer();
      const bound = ready.map(([p, s]) => ({ ...p, ...(s.patch ? { patch: s.patch } : {}), ui: Boolean(reviewer) && merges.touchesUi(s.files) }));
      // Each PR on its own (owner, 2026-11-12): one red or carded PR doesn't hold the others back.
      const tiers = await Promise.all(ready.map(([, s]) => tierFor(issue, "merge", { prs: [s] })));
      const isZero = (t: any) => t.tier === 0 && !t.reject;
      const zero = bound.filter((_, i) => isZero(tiers[i]));
      const rest = bound.map((p, i) => [p, tiers[i]]).filter(([, t]) => !isZero(t));
      // Taken out before acting, so a failure from here on can't file twice: it's said on the task instead. During the run
      // the rest stays for its end (a newer request for it clears that and tiers it again).
      // The Tier 0 merges' record first, while they are still requested (a wait mid-run sees them requested throughout):
      // the kernel runs it at once only if it keeps it at Tier 0.
      const zeroRec = zero.length ? await fileApproval(issue, { action: "merge", args: { prs: zero.map(cardPr) }, ts: tiers.filter(isZero) }) : undefined;
      const taken = [...gone, ...zero, ...(busy ? [] : rest.map(([p]) => p))];
      save((b: any) => {
        const e = b[issueId];
        if (!e) return;
        e.prs = e.prs.filter((p: any) => !taken.some((x) => sameUrl(x, p)));
        if (busy) for (const p of e.prs) if (rest.some(([r]) => sameUrl(r, p)) && e.since === want.since) p.afterRun = true;
        if (!e.prs.length) delete b[issueId];
      });
      want.taken = true;
      if (zeroRec) {
        const rec = zeroRec;
        if (rec.state === "used") {
          const started = await startMerges(issue, { prs: zero, strict: true, each: true });
          await reportOutcome(rec.id, started ? { ok: true, text: `Merging ${zero.map((p) => p.url).join(", ")}, each once green on the head shown.` } : { ok: false, text: "The merge didn't start (said on the task)." });
        } else await pc.comment(issueId, `The merge waits for ${rec.tier === 1 ? "the AI reviewer" : `${cfg.selfName}'s tap`} (${rec.id}).`);
      }
      if (busy || !rest.length) continue;
      const said = rest.filter(([, t]) => t.reject);
      if (said.length) await pc.comment(issueId, said.map(([, t]) => `**Not merged:** ${t.reason}.${["checks-not-green", "no-checks", "head-moved"].includes(t.rule) ? " The merge is requested again when you publish again." : ""}`).join("\n"));
      for (const [p, t] of said) await wakeForTurnedAway(issueId, { ...p, key: t.rule });
      const carded = rest.filter(([p]) => !said.some(([s]) => s === p));
      if (carded.length) {
        const reason = carded.map(([, t]) => t.reason).join("; ");
        const a = await fileApproval(issue, { action: "merge", args: { prs: carded.map(([p]) => cardPr(p)), ...(want.gap !== undefined ? { gap: want.gap } : {}) }, ts: carded.map(([, t]) => t) });
        await pc.comment(issueId, `The merge waits for ${a.tier === 1 ? "the AI reviewer" : `${cfg.selfName}'s tap`} (${a.id}): ${reason}.`);
      }
    } catch (err: any) {
      // GitHub or the board on a bad minute: try again next poll, and give up after ten in a row. A refusal the board
      // would repeat (a 4xx on the args) is said at once: nothing is waiting on a tap.
      const refused = refusedForGood(err);
      const errors = (want.errors ?? 0) + 1;
      log("auto merge failed", { issue: issueId, errors, err: String(err.stderr || err.message || err).slice(0, 300) });
      if (!want.taken && !refused && !(err instanceof UserError) && errors < 10) {
        save((b: any) => b[issueId] && (b[issueId].errors = errors));
        continue;
      }
      if (!want.taken) save((b: any) => delete b[issueId]); // once taken, what it acted on is out already
      await pc.comment(issueId, `**The merge wasn't requested:** ${String(err instanceof UserError ? err.message : err.stderr || err.message || err).trim().slice(0, 1000)}${refused ? " Nothing is waiting on your tap: fix it and publish again, or ask for the merge again." : ""}`).catch(() => {});
    }
  }
}

/** Add a request to the task's history (the first turn on a task also takes its own description). */
function remember(issueId: any, request: any) {
  const key = `history:${issueId}`;
  state.set(key, `${state.get(key) || ""}\n\n---\n\n${request}`.trim().slice(-20_000));
}

async function stopMerges(issue: any, why: any) {
  const queue = mergeQueue(issue.id);
  Object.assign(queue, { state: "stopped", reason: why, stoppedAt: new Date().toISOString() });
  saveMerges(issue.id, queue);
  const next = queue.prs.find((p: any) => p.status === "pending");
  await pc.setStatus(issue.id, "in_review", merges.summary(queue, `**Stopped the merges** (${why}).${next ? ` Tell me to carry on and I'll continue from #${next.number}.` : ""}`));
  reportActivity();
}

/**
 * One step for every running queue: GitHub reads and writes go through mergeGithub. Card queues once a minute
 * (`minute`), independent ones every poll.
 */
async function advanceMerges({ minute = true } = {}) {
  for (const issueId of activeMerges()) {
    const queue = mergeQueue(issueId);
    // An independent queue that finished during the task's run: its status change waits for the run's end.
    if (queue?.held) {
      if (running.has(issueId)) continue;
      const said = queue.held;
      delete queue.held;
      saveMerges(issueId, queue);
      await finishMerges(issueId, queue, said, { posted: true });
      continue;
    }
    if (queue?.state !== "running") {
      if (queue) saveMerges(issueId, queue);
      else state.set("merges:active", JSON.stringify(activeMerges().filter((id: any) => id !== issueId)));
      continue;
    }
    if (!queue.independent && !minute) continue;
    let step: any;
    try {
      step = await merges.advance(queue, { github: mergeGithub, timeoutMinutes: cfg.merges?.timeout_minutes ?? 90, cardIsReview: (ownRepo as any) });
      queue.errors = 0;
    } catch (err: any) {
      // GitHub or the network: try again next minute, and give up after ten in a row.
      queue.errors = (queue.errors ?? 0) + 1;
      log("merge step failed", { issue: queue.identifier, errors: queue.errors, err: String(err.stderr || err.message || err).slice(0, 300) });
      saveMerges(issueId, queue);
      if (queue.errors >= 10) await stopMerges({ id: issueId, identifier: queue.identifier }, `GitHub kept failing: ${String(err.stderr || err.message || err).trim().split("\n").pop()!.slice(0, 200)}`);
      continue;
    }
    // A head that is neither the runner's nor GitHub's update of it: requested again, so it is tiered anew.
    if (step.retier?.length) requestAutoMerge({ id: issueId }, step.retier);
    // A PR its checks kept from merging: the task's Engineer is woken to fix it, once per head and three times per PR at most
    // (its turn may have ended on the runner's word that green PRs merge on their own).
    // The same failure on two heads stops the task instead (the breaker): no more wakes, and the delegator is told once.
    for (const f of step.turned ?? []) if (!(step.fixes ?? []).some((x: any) => x.url === f.url)) await wakeForTurnedAway(issueId, f);
    for (const f of step.fixes ?? []) {
      if (await redHead({ id: issueId, identifier: queue.identifier }, f).catch((err) => (log("red head unread", { pr: f.url, err: String(err.message ?? err).slice(0, 200) }), Boolean(stopped(issueId))))) continue;
      await wakeForRedChecks(issueId, queue, f).catch((err) => log("red checks wake failed", { pr: f.url, err: String(err.message ?? err).slice(0, 200) }));
    }
    // A UI PR now waiting on its design review: the reviewer gets a task for that head (and, none in time, once more; then the
    // queue parks it with a note).
    for (const pr of step.wake ?? []) await fileDesignReviewTask(pr).catch((err) => log("design review task failed", { pr: pr.url, err: String(err.message ?? err).slice(0, 300) }));
    // Finished while the task's run goes on: said now, but the task's status stays the run's until it ends.
    if (step.done && running.has(issueId)) step.queue.held = step.say;
    saveMerges(issueId, step.queue);
    if (step.done && !step.queue.held) await finishMerges(issueId, step.queue, step.say);
    else for (const s of step.say) await pc.comment(issueId, s);
    if (step.say.length || step.done) log("merges advanced", { issue: queue.identifier, state: step.queue.state, merged: step.queue.prs.filter((p: any) => p.status === "merged").length });
    if (step.done) reportActivity();
  }
}

/** A finished queue: the task's status (with `say`, unless already posted), the parent's note, and the tasks that opened its PRs. */
async function finishMerges(issueId: any, queue: any, say: any, { posted = false } = {}) {
  const full = await pc.issue(issueId).catch(() => undefined);
  let status = finishedStatus(full, queue, state.branches(issueId).filter((b) => b.pr_url && !b.merged).map((b) => b.pr_url));
  // A graded task closes only through the grader: it stays in review until then.
  if (status === "done" && !(await mayClose(issueId, "finish_merges"))) status = "in_review";
  if (!posted) await pc.setStatus(issueId, status, say.join("\n\n"));
  else if (full && status !== full.status) await pc.setStatus(issueId, status);
  // The delegator hears how the merges ended when that is the last word: they failed, or the task closed ungraded. With a
  // grade to follow, the grade's outcome is the news (notices.ts).
  if (full?.parentId && isAgentSubtask(full)) {
    const kind = queue.state !== "done" ? "failed" : status === "done" ? "done" : (await graded(issueId)) ? "merged" : "done";
    // A failure is told once per what failed (each PR's head, status and note, and the stop's reason): the same environment
    // stop or red checks on the same head again is no news (WOR-5276 woke 15 times on them). A new head or reason is told.
    const failed = kind === "failed" ? JSON.stringify([queue.reason ?? "", queue.prs.map((p: any) => [p.url, p.head, p.updatedHead, p.status, p.note ?? ""])]) : "", told = failed && state.get(`merge-failure-told:${issueId}`) === failed;
    if (!told && (await tellParent(full, kind, appliedNote(queue.identifier, "merge queue", { ok: queue.state === "done", text: say.join("\n\n") })).catch(() => false)) && failed) state.set(`merge-failure-told:${issueId}`, failed);
  }
  // The tasks that opened these PRs close too, so they don't sit "in review" (shown as waiting for the owner).
  const mergedUrls = queue.prs.filter((p: any) => p.status === "merged").map((p: any) => p.url);
  // Its own task too: a merge recorded only on other tasks' rows left this one's branch reading unmerged, so a later receipt
  // invited a `pr` for work already on the default branch.
  const markMerged = (id: any) => state.branches(id).filter((b) => b.pr_url && mergedUrls.some((u: any) => u.toLowerCase() === String(b.pr_url).toLowerCase())).forEach((b) => state.updateBranch(id, b.repo, b.branch, { merged: 1 }));
  markMerged(issueId);
  for (const other of state.issuesWithPrs(mergedUrls, issueId)) {
    markMerged(other);
    const o = await pc.issue(other).catch(() => undefined);
    const open = state.branches(other).filter((b) => b.pr_url && !b.merged).map((b) => b.pr_url);
    if (o?.status === "in_review" && finishedStatus(o, queue, open) === "done" && (await mayClose(other, "finish_merges"))) await pc.setStatus(other, "done", `Merged by ${queue.identifier}'s merge queue.`).catch(() => {});
  }
}

/**
 * The reviewer-eval gate on product merges (evalgate.ts): a PR that changes the AI reviewer's own code merges only on a 100%
 * receipt for its head. The eval runs in the job jail with its own key (secrets `openrouter_eval_key`), never the fleet's.
 */
const evalGate = createEvalGate({
  productRepo: cfg.productRepo,
  workDir: cfg.workDir,
  keyFile: join(cfg.secretsDir, "openrouter_eval_key"),
  productRoot: REPO_ROOT,
  state,
  git,
  clone: async (slug) => ensureClone(cfg.workDir, normalizeRepo(slug), cfg.repo_sources?.[slug] ?? ((await appFor(slug)) ? appRemoteUrl(slug) : undefined)),
  jail: (argv, paths) => hiding(evalSandbox, argv, [], paths),
  log,
  usage: reportUsage,
});

/** GitHub for the merge queue, with your gh login: fixed GraphQL reads, and the writes in merges.WRITES only. */
const mergeGithub = {
  evalGate,
  async pr(repo: any, number: any) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.PR_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`, "-f", `pullRef=refs/pull/${number}/head`], await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 }));
    return merges.withGate(JSON.parse(stdout).data);
  },
  async commit(repo: any, oid: any) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.COMMIT_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-f", `oid=${oid}`], await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 }));
    return JSON.parse(stdout).data?.repository?.object;
  },
  async merge(repo: any, number: any, { sha, method }: any) {
    return (await githubWrite(repo, `repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha }, "PUT", mergePermissions(repo, cfg.productRepo))).sha;
  },
  async updateBranch(repo: any, number: any, head: any) {
    await githubWrite(repo, `repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT", mergePermissions(repo, cfg.productRepo));
  },
  /** The base branch's files changed since `oid`, and its tip (siblings.ts): paged or unread is `files: undefined`. */
  async prBaseFiles(repo: any, base: any, oid: any) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${BASE_FILES_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-f", `base=refs/heads/${base}`, "-f", `oid=${oid}`], await gho(repo, READ));
    return baseFilesSince(JSON.parse(stdout).data);
  },
  async baseStatus(repo: any, base: any) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.BASE_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-f", `ref=refs/heads/${base}`, "-f", `base=${base}`], await gho(repo, READ));
    const r = JSON.parse(stdout).data?.repository;
    return { tip: r?.ref?.target?.oid ?? null, open: r?.heads?.nodes?.some((n: any) => n.state === "OPEN" && !n.isCrossRepository) ?? false, merged: (r?.heads?.nodes ?? []).filter((n: any) => n.state === "MERGED"), overflow: Boolean(r?.heads?.pageInfo?.hasNextPage), stacked: (r?.stacked?.totalCount ?? 0) > 0 };
  },
  async retarget(repo: any, number: any, base: any) {
    await githubWrite(repo, `repos/${repo}/pulls/${number}`, { base }, "PATCH");
  },
  /**
   * A stacked PR's own approved commits (from..its head) replayed by the runner onto the default branch's tip in its own
   * clone, and pushed as the PR's head (leased to the approved head). Returns the new head; throws on a conflict, a head
   * that moved, or anything that isn't a straight line of commits on top of `from`.
   */
  async rebuild(repo: any, pr: any, from: any, defaultBranch: any) {
    return withTrusted(repo, [defaultBranch, pr.headRefName], async (path: any, [tip, head]: any) => {
      if (pr.isCrossRepository || head !== pr.headRefOid) throw new Error("its head moved");
      const re = await replayOnto(path, from, head, tip, await botIdentity());
      if (!re) throw new Error(`its commits don't replay cleanly onto \`${defaultBranch}\``);
      const url = await git(path, "remote", "get-url", "origin");
      await git(path, "push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${pr.headRefName}:${head}`, url, `${re.tip}:refs/heads/${pr.headRefName}`);
      return re.tip;
    });
  },
  async deleteBranch(repo: any, branch: any) {
    await githubWrite(repo, `repos/${repo}/git/refs/heads/${branch}`, {}, "DELETE");
  },
  async comment(repo: any, number: any, body: any) {
    await githubWrite(repo, `repos/${repo}/issues/${number}/comments`, { body }, "POST");
  },
  /** A commit status on the head (the design review's wait), as github-mcp's `commit_status_set` writes it. */
  async status(repo: any, sha: any, { state, context, description }: any) {
    await githubWrite(repo, `repos/${repo}/statuses/${sha}`, { state, context, description }, "POST", STATUS);
  },
  async close(repo: any, number: any) {
    await githubWrite(repo, `repos/${repo}/pulls/${number}`, { state: "closed" }, "PATCH");
  },
  async markReady(id: any, repo: any) {
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.READY_MUTATION}`, "-f", `id=${id}`], await ghoMerge(repo));
    const res = JSON.parse(stdout);
    if (res.errors?.length) throw new Error(res.errors.map((e: any) => e.message).join("; "));
  },
  /** The checks re-run on this PR ({ name: { head, id } }): kept in state, so a queue started again doesn't re-run them twice. */
  reruns(repo: any, number: any) {
    return JSON.parse(state.get(`reruns:${repo.toLowerCase()}#${number}`) || "{}");
  },
  /** A workflow run's { status, updatedAt } (the ghost check: a run that is over while a job of it still reads in progress). */
  async run(repo: any, run: any) {
    const { stdout } = await execFileP(await findRealGh(), ["api", `repos/${repo}/actions/runs/${run}`, "--jq", "{ status, updatedAt: .updated_at } | @json"], await gho(repo, READ));
    return JSON.parse(stdout);
  },
  /** Re-runs a workflow run's failed jobs, then records its checks (a refused re-run records nothing: the next queue may try). */
  async rerun(repo: any, number: any, { run, checks, head, whole }: any) {
    if (whole) await githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun`, {}, "POST", RERUN);
    else await githubWrite(repo, `repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, {}, "POST", RERUN);
    const key = `reruns:${repo.toLowerCase()}#${number}`;
    state.set(key, JSON.stringify({ ...JSON.parse(state.get(key) || "{}"), ...Object.fromEntries(checks.map((c: any) => [c.name, { head, id: c.id }])) }));
    log("checks re-run", { repo, number, run, checks: checks.map((c: any) => c.name), head });
  },
  /**
   * A check's Actions job: its steps (empty when GitHub never started it: no runner, billing) and its failure annotations
   * (GitHub's own words about why). The job is listed under the check's workflow run, where it links back to the check run
   * (`merges.jobFor`). Reads only when a red check has to be classified; an unlisted job is unreadable.
   */
  async job(repo: any, check: any) {
    const run = check.checkSuite?.workflowRun?.databaseId;
    if (!run) return { steps: [], annotations: [] };
    const { stdout } = await execFileP(await findRealGh(), ["api", "--paginate", `repos/${repo}/actions/runs/${run}/jobs?per_page=100`, "--jq", ".jobs[] | @json"], await gho(repo, READ));
    const jobs = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const job = merges.jobFor(jobs, check);
    if (!job?.id) return { steps: [], annotations: [] };
    const annotations = await execFileP(await findRealGh(), ["api", `repos/${repo}/check-runs/${check.databaseId}/annotations`], await gho(repo, READ)).then((r) => JSON.parse(r.stdout));
    return { steps: job.steps ?? [], annotations: Array.isArray(annotations) ? annotations : [] };
  },
  /** The code-review gate's comment (its last, by the workflow's bot) says the review never finished on `head`. */
  async codeReviewInfra(repo: any, number: any, head: any) {
    const jq = `.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${merges.CODE_REVIEW.marker}"))) | .body | @json`;
    try {
      const { stdout } = await execFileP(await findRealGh(), ["api", "--paginate", `repos/${repo}/issues/${number}/comments?per_page=100`, "--jq", jq], await gho(repo, READ, { maxBuffer: 16 * 1024 * 1024 }));
      const last: any = stdout.trim().split("\n").filter(Boolean).at(-1);
      return Boolean(last) && merges.codeReviewInfra(JSON.parse(last), head);
    } catch (err: any) {
      log("code review comment unread", { repo, number, err: String(err.message ?? err).slice(0, 200) });
      return false; // unknown is a real failure
    }
  },
};

async function githubWrite(repo: any, path: any, fields: any, method = "PUT", perms = WRITE) {
  if (!merges.allowedWrite(method, path, cfg.agentsOrg, cfg.productRepo)) throw new Error(`refused GitHub write ${method} ${path}`);
  const args = ["api", "-X", method, path];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  const { stdout } = await execFileP(await findRealGh(), args, await ghoMerge(repo, undefined, perms));
  return JSON.parse(stdout || "{}");
}

export { activeMerges, advanceMerges, mergeCheck, mergeGithub, mergeQueue, remember, requestAutoMerge, runAutoMerges, startMerges, stopMerges };
