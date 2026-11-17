import { join } from "node:path";
import { isAgentSubtask, ownRequest, stripHidden } from "../agents.mjs";
import { branchCardArgs, cardText } from "../cards.ts";
import { git, remoteIsEmpty } from "../../../../modules/codehost-github/src/git.mjs";
import { READ, WRITE, appRemoteUrl, inOrg } from "../../../../modules/codehost-github/src/github-app.ts";
import { checkBranchName } from "../branch.ts";
import { cleanMessages, existingPrUrl, leakIn, leaksInternal, stripAttribution, writePrDescription } from "../describe.ts";
import { prTitle } from "../prompt.ts";
import { keepReviewedHead, messagesSince, resolvePrBase, retargetBase, reviewedRef, UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import * as merges from "../../../../modules/codehost-github/src/merge-gate.mjs";
import * as prQueue from "../../../../modules/engineering/src/merge-queue.mjs";
import { MAX_REJECTS } from "../../../../kernel/src/tier.ts";
import { LUNA } from "../models.mjs";
import { requestReview, reviewRequest } from "../review-request.mjs";
import { guardBranch } from "../evidence.ts";
import { normalizeRepo } from "../../../../modules/codehost-github/src/repos.ts";
import { appFor, cfg, execFileP, gho, log, ownRepo, pc, sameRepo, state } from "./context.ts";
import { designReviewer, fileDesignReviewTask } from "./watch.ts";
import { requestFrom } from "./dispatch.ts";
import { requestAutoMerge } from "./merge.ts";
import { stopped, stoppedText } from "./breaker.ts";
import { AlreadyApplied, AwaitingApproval, alreadyApplied, autonomyNow, branchTierState, currentTier, fileApproval, inAgentsOrg, keyIn, tierFor, trustedPatch, waitingFor } from "./tier-state.ts";
import { checkFindings, checksKey, checksOf, checksUsed } from "./card-review.ts";
import { approvedRecord, bindBase, cardContext, mergeAfterPublish, pinKey, rebuild, refuseRewritten, refusedForGood, reportOutcome } from "./approvals.ts";
import { access, branchRows, findRealGh, lastReport, leaveFinishedPrs, tidyBranches } from "./github.ts";

/** The runner's cache clone of one repository, from its "org/name". */
const cacheClone = (slug: any) => join(cfg.workDir, "repos", ...String(slug).split("/"));

/**
 * Keep a `pr` card's reviewed heads in the runner's cache clone, as refs/reviewed/<approval>/<branch>: the objects outlive
 * the task's workspace, and nothing is pushed (an unapproved head is published nowhere). A head that can't be kept is
 * logged; a rejection names only the refs that resolve to the exact commit the card carried (reviewedRefsOf).
 */
async function keepReviewed(ordered: any, branches: any, approval: any) {
  for (const [i, r] of ordered.entries()) {
    const b = branches[i];
    try {
      const ref = await keepReviewedHead(r.path, cacheClone(b.repo), { repo: b.repo, approval, branch: b.branch, sha: b.sha, cacheRoot: join(cfg.workDir, "repos") });
      log("reviewed head kept", { approval, repo: b.repo, branch: b.branch, sha: b.sha, ref });
    } catch (err: any) {
      log("reviewed head not kept", { approval, repo: b.repo, branch: b.branch, err: String(err.message ?? err).slice(0, 200) });
    }
  }
}

/**
 * The refs a rejected card's heads are kept at, read back from the cache and only when each still resolves to exactly the
 * commit the card named: a rejection never points at a head that isn't there.
 */
async function reviewedRefsOf(a: any) {
  const out = [];
  for (const b of a.args?.only ?? []) {
    const ref = reviewedRef(a.id, b.branch);
    const tip = await git(cacheClone(b.repo), "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).catch(() => "");
    if (b.sha && tip === b.sha) out.push({ repo: b.repo, branch: b.branch, ref });
  }
  return out;
}

/** The line a rejection adds so a later task on the same work resolves the reviewed head instead of rebuilding it. */
const reviewedLine = (refs: any) =>
  refs.length
    ? `\n\nThe reviewed head stays in the runner's cache as ${refs.map((r: any) => `\`${r.ref}\``).join(", ")} (a task clone of ${[...new Set(refs.map((r: any) => r.repo))].join(", ")} fetches it): it was never pushed, so GitHub has no branch and no PR for it. Start from that ref rather than from this note.`
    : "";

/**
 * The reviewed range of each branch, bound before tiering (a product branch's trusted base must be the one the workspace
 * shows), and the change's content key the card carries (the owner's veto binds to it, however the branch is renamed or
 * rebased). Sets `base` and `patch` on `branches` ({ repo, branch, sha }, in `ordered`'s order).
 */
async function bindBranches(ordered: any, branches: any) {
  for (const [i, r] of ordered.entries()) {
    const base = await bindBase(r, branches[i].sha);
    if (base) branches[i].base = base;
    const patch = await trustedPatch(r.repo, branches[i].sha, { from: r.path });
    if (patch) branches[i].patch = patch;
  }
}

/** A PR on the product repo is one card for push, PR and merge (owner, 2026-11-13). */
const carriesMerge = (command: any, ordered: any) => command === "pr" && Boolean(cfg.productRepo) && ordered.every((r: any) => sameRepo(r.repo, cfg.productRepo));

/** The exact commit each branch is at now, as a card names it. */
const branchHeads = (ordered: any) => Promise.all(ordered.map(async (r: any) => ({ repo: r.repo, branch: r.branch, sha: await git(r.path, "rev-parse", "--verify", `refs/heads/${r.branch}^{commit}`) })));

/**
 * `aidenhq push` and `aidenhq pr`: the same publishing as the user's "push" and "pr", as an approval record: the branches
 * that would go out, at their exact commits, wait for the user's tap; runApprovals() publishes them then (results on the task).
 */
async function agentPublish(ctx: any, command: any, args: any) {
  if (stopped(ctx.issue.id)) throw new UserError(stoppedText(stopped(ctx.issue.id)));
  const only = (Array.isArray(args.branches) ? args.branches : [])
    .map((b: any) => ({ repo: normalizeRepo(String(b?.repo ?? ""))?.slug ?? "", branch: String(b?.branch ?? "") }))
    .filter((b: any) => b.repo && b.branch);
  const text: any = command === "pr" && args.title ? { title: String(args.title), body: String(args.body ?? "") } : undefined;
  let ranAtOnce: any; // Tier 0: its record, claimed at filing; published now, the outcome reported on it
  let carried: any; // an earlier approval's commits, replayed by the runner: published (and merged) on it, its record carried by it
  try {
    const result = await publish(ctx.issue, ctx.workspace, command, ctx.signal, {
      only,
      text,
      check: async (ordered: any) => {
        // History rewritten in place (replace refs, grafts, shallow) shows one commit and publishes another: refused before tiering.
        await refuseRewritten(ordered);
        const branches = await branchHeads(ordered);
        // A PR on the product repo is one card for push, PR and merge (owner, 2026-11-13): approving it also merges each PR at
        // exactly these commits once every named check and the base branch are green (mergeAfterPublish); the card says so.
        const merge = carriesMerge(command, ordered);
        // Every branch already satisfied on its repo's current default branch (after a fresh fetch): no card, evidence instead.
        for (const r of (new Map(ordered.map((r: any) => [r.path, r])).values() as any)) await git(r.path, "fetch", "--quiet", "origin", r.defaultBase).catch(() => "");
        const on = await Promise.all(ordered.map((r: any, i: any) => guardBranch(git, r, branches[i].sha)));
        if (on.every((o) => o.satisfied)) throw new AlreadyApplied(await alreadyApplied(ctx.issue, command, branches.map((b) => b.sha).join(","), on.map((o, i) => `${branches[i].repo} \`${branches[i].branch}\`: ${o.evidence}`).join("; ")));
        await bindBranches(ordered, branches);
        // The card's args, built from the branches as bound: the board's schema decides what a card may carry (cards.ts).
        const cardArgs = branchCardArgs(branches, { text, merge });
        // Computed here, right before anything is published, from the branches as git sees them (autonomy off: Tier 0 is a
        // card and Tier 1 review-first, tiers.mjs autonomyCap).
        const t = await tierFor(ctx.issue, command, { branches: await Promise.all(ordered.map((r: any, i: any) => branchTierState(r, branches[i].sha, branches[i].base))) }, merge ? ["merge"] : []);
        if (t.reject) throw new UserError(`Not done: ${t.reason}.`);
        if (t.tier === 0) {
          // Once more right before it goes out at once: nothing rewrote the clone's history while it was tiered.
          await refuseRewritten(ordered);
          // Its record first: the kernel may raise it (a protected target, the owner's veto), and then it is a card.
          const rec = await fileApproval(ctx.issue, { action: command, args: cardArgs, ts: [t] });
          if (rec.state !== "used") {
            if (command === "pr") await keepReviewed(ordered, branches, rec.id);
            throw new AwaitingApproval(waitingFor(rec, ctx.issue));
          }
          ranAtOnce = { rec };
          // Exactly the commits classified go out (a branch moved meanwhile can't ride along).
          return new Map(branches.map((b) => [pinKey(b.repo, b.branch), b.sha]));
        }
        // A clean rebase of approved commits: the runner's own replay of them is published on that approval.
        const built: any = await rebuild(ctx.issue, command, cardArgs, ordered, branches, t);
        if (built) {
          const args2 = { ...cardArgs, only: branches.map((b, i) => ({ ...b, sha: built.pins.get(pinKey(b.repo, b.branch)), base: built.moves[i].base })) };
          const ids = [...new Set(built.records.map((r: any) => r.approval))];
          // Its record, carried by those approvals (the kernel checks them): no new card unless the kernel says otherwise.
          const rec = await fileApproval(ctx.issue, { action: command, args: args2, ts: [{ tier: 0, rule: "replayed-approval", reason: `the commits of approval ${ids.join(", ")}, replayed by the runner onto a new base with no conflict` }], carries: ids }).catch((err) => (refusedForGood(err) ? undefined : Promise.reject(err)));
          if (rec?.state === "used") {
            carried = { ...built, args: args2, rec };
            return built.pins;
          }
        }
        const a = await fileApproval(ctx.issue, { action: command, args: cardArgs, ts: [t] });
        // A `pr` card's head is never on GitHub before approval: the cache keeps exactly what was reviewed
        // (refs/reviewed/<approval>/<branch>), so a rejection can name it and the next task on the work can resolve it.
        if (command === "pr") await keepReviewed(ordered, branches, a.id);
        throw new AwaitingApproval(waitingFor(a, ctx.issue));
      },
    });
    if (ranAtOnce) await reportOutcome(ranAtOnce.rec.id, result);
    if (carried) {
      const ids = [...new Set(carried.records.map((r: any) => r.approval))].join(", ");
      const said = `The approved commits of ${ids}, replayed by the runner onto the new \`main\` with no conflict (your rebase matches them), so no new card: ${carried.args.merge ? "published, and merging once green on the new commits" : "published"}.`;
      await pc.comment(ctx.issue.id, said);
      if (result.ok) {
        for (const [i, m] of carried.moves.entries()) {
          // The runner's commits are now the approved ones; the workspace branch takes them (same trees, so its files don't change).
          approvedRecord(ctx.issue.id, carried.args.only[i], { ...carried.records[i], sha: m.to, base: m.base });
          await git(m.r.path, "update-ref", `refs/heads/${m.r.branch}`, m.to, m.from).catch(() => {});
          await git(m.r.path, "update-ref", "-d", "refs/aidenhq/replayed").catch(() => {});
        }
      }
      // Merged as the approved card's own merge would, bound to the runner's commits.
      const outcome = carried.args.merge && result.ok ? await mergeAfterPublish(ctx.issue, { args: carried.args }, result) : result;
      await reportOutcome(carried.rec.id, outcome);
      return `${said}\n\n${stripHidden(outcome.text).trim()}`;
    }
    return stripHidden(result.text).trim();
  } catch (err) {
    if (err instanceof AwaitingApproval || err instanceof AlreadyApplied) return err.message;
    throw err;
  }
}

/** Reviewer checks a task may run before filing (`aidenhq review`), across its jobs: each is a real reviewer call, recorded. */
const REVIEW_CHECKS = 3;
/** A check's verdict: thrown out of publish()'s check, so nothing is published or filed. */
class Checked extends Error {}

/**
 * `aidenhq review [push] [<org/repo> <branch>]…`: the AI reviewer's verdict on the card `aidenhq pr` (or `push`) would file
 * now, without filing it. The same branches, the same tiering and the same request as the card's review (reviewRequest),
 * so a rejection is fixed in the same run instead of costing a card, a rejection notice and a new job. No card is filed.
 * The gate isn't an oracle to tune against: only a real reviewer call counts, REVIEW_CHECKS per task across its jobs (kept in
 * state; the next word of whoever asked, the delegator or the owner, gives REVIEW_CHECKS more); each check is one short line
 * on the task (verdict and code), and its findings go to every later review of the action on the task (checkFindings), so
 * the card's review sees what was probed. The agent never learns which models judged. The
 * card's own review still decides.
 */
async function agentReview(ctx: any, args: any) {
  const command = args.action === "push" ? "push" : "pr";
  const only = (Array.isArray(args.branches) ? args.branches : [])
    .map((b: any) => ({ repo: normalizeRepo(String(b?.repo ?? ""))?.slug ?? "", branch: String(b?.branch ?? "") }))
    .filter((b: any) => b.repo && b.branch);
  try {
    const out = await publish(ctx.issue, ctx.workspace, command, ctx.signal, {
      only,
      quiet: true,
      check: async (ordered: any) => {
        await refuseRewritten(ordered);
        const branches = await branchHeads(ordered);
        await bindBranches(ordered, branches);
        const a = { action: command, args: branchCardArgs(branches, { merge: carriesMerge(command, ordered) }) };
        const mode = autonomyNow();
        const input: any = await currentTier(ctx.issue, a, { withDiff: true });
        const n = checksUsed(ctx.issue.id);
        log("review check", { issue: ctx.issue.identifier, action: command, tier: input.reject ? "reject" : input.tier, rule: input.rule, mode, used: n });
        if (input.reject) throw new Checked(`Code refuses this ${command} before any review (rule \`${input.rule}\`): ${input.reason}. No reviewer was asked, and this check isn't counted.`);
        if (input.tier === 0) throw new Checked(`Tier 0 (${input.reason}): \`aidenhq ${command}\` runs at once, with no review. This check isn't counted.`);
        if (input.tier > 1 && !input.reviewFirst) throw new Checked(`Tier 2 (${input.reason}): ${cfg.selfName} decides the card, not the AI reviewer. File it with \`aidenhq ${command}\`; this check isn't counted.`);
        // Autonomy off: the card is review-first (the reviewer's reject is final), so the check is worth asking.
        if (mode === "tier0") throw new Checked(`Autonomy is ${mode}: ${cfg.selfName} decides every card, so there is no AI review to check against. File it with \`aidenhq ${command}\`; this check isn't counted.`);
        if (n >= REVIEW_CHECKS) throw new Checked(`No checks left on this task (${REVIEW_CHECKS} used; the next word from whoever asked gives ${REVIEW_CHECKS} more). File it with \`aidenhq ${command}\`: the card's review decides.`);
        const card = { action: command, ...cardText(command, a.args) };
        // Counted before the call, so a call cut off by a restart still counts.
        const entry = { action: command, target: card.target, at: new Date().toISOString(), decision: "pending", code: "" };
        state.set(checksKey(ctx.issue.id), JSON.stringify([...checksOf(ctx.issue.id), entry]));
        const chain = await prRequest(await pc.issue(ctx.issue.id)).catch(() => "");
        const context = await cardContext(ctx.issue, { branches: branches.map((x) => ({ repo: x.repo, branch: x.branch })) }, input.bases);
        // The same request a card's review sends (reviewRequest), through the kernel's reviewer slot; a failed call is no verdict.
        const v: any = await requestReview({ kernelUrl: cfg.kernelUrl, key: keyIn(cfg.reviewerKeyFile) }, reviewRequest(card, input, chain, { component: "AI reviewer check", requesterModel: state.task(ctx.issue.id)?.engine?.model ?? "", previous: checkFindings(ctx.issue.id, card.action), ...context })).then(({ panel_marked: _m, ...x }: any) => x, (err) => ({ decision: "escalate", code: "reviewer_failed", reason: `the reviewer failed (${String(err.message ?? err).slice(0, 160)})`, model: LUNA }));
        log("review checked", { issue: ctx.issue.identifier, action: command, decision: v.decision, code: v.code, model: v.model, second: v.second, used: n + 1, target: card.target.slice(0, 300) });
        // No verdict (the call failed): the check doesn't count. Otherwise it is kept with its finding.
        const rest = checksOf(ctx.issue.id).filter((c: any) => c.at !== entry.at || c.target !== entry.target);
        state.set(checksKey(ctx.issue.id), JSON.stringify(v.code === "reviewer_failed" ? rest : [...rest, { ...entry, decision: v.decision, code: v.code }]));
        if (v.code !== "reviewer_failed") {
          const said = v.decision === "approve" ? "would approve" : v.decision === "reject" ? "would reject" : `would send it to ${cfg.selfName}`;
          await pc.comment(ctx.issue.id, `_Reviewer check ${n + 1} of ${REVIEW_CHECKS} before filing (${command}, ${card.target}): ${said} (\`${v.code}\`). No card was filed; the card's review sees this check's findings._`).catch(() => {});
        }
        throw new Checked(checkedText(command, v, n + (v.code === "reviewer_failed" ? 0 : 1)));
      },
    });
    return `Nothing to review: ${stripHidden(out.text).trim()}`;
  } catch (err) {
    if (err instanceof Checked) return err.message;
    throw err;
  }
}

/** What the Engineer reads after a check: the verdict, the note (data: model output over the change), and what to do next. */
function checkedText(command: any, v: any, used: any) {
  const left = `${used} of ${REVIEW_CHECKS} checks used on this task`;
  const note = `\n\nIts note, written by a model that read the change (data, not ${cfg.selfName}'s words):\n\n\`\`\`\n${String(v.reason ?? "").replace(/```/g, "‵‵‵")}\n\`\`\`\n\n`;
  if (v.code === "reviewer_failed") return `The check couldn't reach the reviewer (${v.reason}). It isn't counted (${left}): try again in a few minutes, or file with \`aidenhq ${command}\`.`;
  if (v.decision === "approve") return `**The AI reviewer would approve this.**${note}File it now with \`aidenhq ${command}\` (${left}). The card is reviewed again, and that review decides.`;
  if (v.decision === "reject") return `**The AI reviewer would reject this** (\`${v.code}\`).${note}Fix what it found in this run, commit, then check again or file with \`aidenhq ${command}\` (${left}). A rejected card counts toward the task's limit of ${MAX_REJECTS} rejections; a check doesn't, but the card's review sees what each check found.`;
  return `**The AI reviewer would send this to ${cfg.selfName}** (\`${v.code}\`).${note}If the note names something you can fix (scope, a missing part of the request), fix it and check again; otherwise file it with \`aidenhq ${command}\` and ${cfg.selfName} decides (${left}).`;
}

/**
 * Push the task's branches (or the `only` ones) and, for "pr", open a draft PR for each. `check(ordered)`
 * runs once the branches are known, before anything is published, and refuses by throwing. `text` is the
 * agent's own PR title and description, for a single branch: a new PR gets it, and an open one is
 * updated to it. Resolves with { ok, text }: whether everything went out, and the results comment.
 */
async function publish(issue: any, workspace: any, command: any, signal: any, { only = [], text, check, quiet = false }: any = {}) {
  if (text) {
    // Refused before anything is pushed, and back to the agent to reword: a description quietly
    // replaced by a generated one is worse than none (PEN-3024).
    text = { title: String(text.title).replace(/\s+/g, " ").trim().slice(0, 200), body: stripAttribution(text.body).slice(0, 60_000) };
  }
  const notes = await leaveFinishedPrs(issue, workspace);
  const tidyNotes = await tidyBranches(issue, workspace);
  const rows = await branchRows(issue, workspace);
  const named = (r: any) => !only.length || only.some((o: any) => o.repo.toLowerCase() === r.repo.toLowerCase() && o.branch === r.branch);
  const unknown = only.filter((o: any) => !rows.some((r) => o.repo.toLowerCase() === r.repo.toLowerCase() && o.branch === r.branch));
  if (unknown.length) throw new UserError(`not a branch of this task: ${unknown.map((o: any) => `${o.repo} ${o.branch}`).join(", ")}. Its branches: ${rows.map((r) => `${r.repo} ${r.branch}`).join(", ") || "none yet"}`);
  // The agent's own text for a single branch whose PR is open: that PR's title and description to update.
  const editing = command === "pr" && Boolean(text) && rows.filter((r) => named(r) && !r.merged).length === 1;
  const publishable = rows.filter((r) => named(r) && !r.merged && (r.unpublished.length || (command === "pr" && !r.prUrl) || (editing && r.prUrl)));
  // Outside reviewers mustn't see our internal names; our own repos (the product, the agents org) are about them.
  const leak = text && !publishable.every((r) => ownRepo(r.repo)) ? leakIn(`${text.title}\n${text.body}`) : undefined;
  if (leak) throw new UserError(`Not done: the PR title or description mentions "${leak}". The repository's reviewers mustn't see internal names, tools, task numbers or local paths; reword it and run the command again.`);
  if (!publishable.length) {
    const open = rows.filter((r) => named(r) && r.prUrl && !r.merged);
    // GitHub already has everything: as good as published.
    const said = [...notes, rows.length ? (open.length ? `Nothing new to publish: GitHub already has every commit${command === "pr" ? `, and the PRs are open: ${open.map((r) => r.prUrl).join(", ")}` : ""}.` : "Nothing new to publish.") : "There are no commits to publish."].join("\n\n");
    if (!quiet) await pc.comment(issue.id, said);
    return { ok: true, text: said };
  }
  // Parents before the branches stacked on them: a stacked PR needs its base on GitHub first.
  const ordered: any = [];
  const visit = (r: any) => {
    if (ordered.includes(r)) return;
    const parent = publishable.find((p) => p.repo === r.repo && p.branch === r.base);
    if (parent) visit(parent);
    ordered.push(r);
  };
  publishable.forEach(visit);
  // A check may pin the exact commits it cleared (Tier 0): those are what get pushed, whatever the branch says now.
  const pinned = check ? await check(ordered) : undefined;
  // Pinned (an approval, Tier 0, a replay): every branch going out has its pin, or nothing goes out.
  const unpinned = pinned ? ordered.filter((r: any) => !pinned.get(pinKey(r.repo, r.branch))) : [];
  if (unpinned.length) throw new UserError(`not published: ${unpinned.map((r: any) => `${r.repo} \`${r.branch}\``).join(", ")} isn't part of what was approved`);

  const full = await pc.issue(issue.id);
  const results = [];
  for (const r of ordered) {
    const label = `${new Set(rows.map((x) => x.repo)).size > 1 ? `${r.repo} · ` : ""}\`${r.branch}\``;
    if (signal?.aborted) {
      results.push(`| ${label} | not published: stopped on request |`);
      continue;
    }
    try {
      results.push(`| ${label} | ${await publishBranch(issue, full, r, command, rows, ordered.length === 1 ? text : undefined, pinned?.get(pinKey(r.repo, r.branch)))} |`);
    } catch (err: any) {
      log("publish failed", { issue: issue.identifier, repo: r.repo, branch: r.branch, err: String(err.stderr || err.message).slice(0, 300) });
      results.push(`| ${label} | ⚠️ ${String(err instanceof UserError ? err.message : err.stderr || err.message).trim().split("\n").slice(-3).join(" ").replace(/\|/g, "/").slice(0, 400)} |`);
    }
  }
  const ok = !signal?.aborted && !results.some((line) => line.includes("⚠️"));
  // Agents-org PRs end merged (owner, 2026-11-12): every PR this publish opened or moved is requested for merging, at once
  // when CI is green (runAutoMerges). The product's and the instance's PRs stay the owner's.
  // With autonomy off each request becomes the owner's card (runAutoMerges).
  const autoMerge = ok
    ? state.branches(issue.id).filter((b) => b.pr_url && !b.merged && inOrg(cfg.agentsOrg, b.repo) && !sameRepo(b.repo, cfg.apply?.repo) && !sameRepo(b.repo, cfg.productRepo) && ordered.some((r: any) => sameRepo(r.repo, b.repo) && r.branch === b.branch))
    : [];
  const prs = prQueue.findPrs(autoMerge.map((b) => b.pr_url).join("\n"));
  if (prs.length) requestAutoMerge(issue, prs);
  const said = [...notes, ...tidyNotes.map((n) => `_${n}_`), "| Branch | Result |", "|---|---|", ...results, ...(prs.length ? ["", `_Merging requested: ${prs.map((p) => p.url).join(", ")}, each as soon as its checks are green on this head._`] : [])].join("\n");
  await pc.comment(issue.id, said);
  return { ok, text: said };
}

/**
 * A branch this task pushed and then rewrote (a rebase) can replace its earlier version: only
 * when GitHub's tip is a commit the task's own branch once pointed at (its reflog), so nothing anyone
 * else pushed is lost, and leased to exactly that commit. Undefined when the push is a fast-forward.
 */
async function leaseFor(r: any) {
  if (!r.onGitHub) return undefined;
  await git(r.path, "fetch", "--quiet", "origin", `+refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`);
  const remote = await git(r.path, "rev-parse", `refs/remotes/origin/${r.branch}`);
  if (await git(r.path, "merge-base", "--is-ancestor", remote, `refs/heads/${r.branch}`).then(() => true, () => false)) return undefined;
  const seen = (await git(r.path, "reflog", "show", "--format=%H", `refs/heads/${r.branch}`).catch(() => "")).split("\n");
  if (r.branch === r.defaultBase || !r.pushed || !seen.includes(remote)) {
    throw new UserError(`not replaced: GitHub's \`${r.branch}\` has commits this task didn't make (\`${remote.slice(0, 9)}\`). Ask me to build on GitHub's version instead`);
  }
  return remote;
}

/**
 * Publish one branch on the user's "push" or "pr": checks first (writable repository, a valid public
 * name, no internal names in its commits), then push (forced only over its own earlier version), then for "pr" a draft PR into its
 * base, the parent branch for a stacked one. Returns the result line for the table.
 */
async function publishBranch(issue: any, full: any, r: any, command: any, rows: any, text: any, pin: any) {
  if (!r.writable) throw new UserError(`not published: \`${r.repo}\` is outside your orgs (${cfg.allowed_orgs.join(", ")}), so it's read-only`);
  const empty = await remoteIsEmpty(r.path);
  if (r.branch === r.defaultBase ? !empty : !checkBranchName(r.branch, { base: r.defaultBase, defaultBranch: r.defaultBase })) throw new UserError(`not a branch name I'd publish`);
  // Only the commits being published: what's already on GitHub (other people's work) isn't ours to judge.
  const unpublishedMessages = (await git(r.path, "log", "--format=%B%x1e", r.branch, "--not", "--remotes=origin").catch(() => "")).split("\x1e");
  const leaky: any = ownRepo(r.repo) ? undefined : unpublishedMessages.find((m) => leaksInternal(m));
  if (r.unpublished.length && leaky) throw new UserError(`a commit message mentions internal names ("${leaky.split("\n")[0].slice(0, 80)}"). Ask me to reword it`);
  const viaApp = Boolean(await appFor(r.repo));
  if (!viaApp) await access().ensureWritable(r.repo); // its own write deploy key, the first time the runner pushes to it
  const url = viaApp ? appRemoteUrl(r.repo) : await git(r.path, "remote", "get-url", "origin");
  let pushed = "";
  if (r.unpublished.length || !r.onGitHub) {
    // Into an empty repository the first branch becomes its default branch, as GitHub expects.
    const target = empty ? r.defaultBase : r.branch;
    const lease = empty ? undefined : await leaseFor(r);
    const sent = pin ?? (await git(r.path, "rev-parse", "--verify", `refs/heads/${r.branch}^{commit}`));
    await git(r.path, "push", "--no-verify", ...(lease ? [`--force-with-lease=refs/heads/${target}:${lease}`] : []), url, `${sent}:refs/heads/${target}`);
    await git(r.path, "fetch", "--quiet", "origin");
    state.updateBranch(issue.id, r.repo, r.branch, { pushed: 1 });
    state.recordPush(r.repo, target, sent);
    log("branch pushed", { issue: issue.identifier, repo: r.repo, branch: r.branch, target });
    if (target !== r.branch) return `The repository was empty: pushed as its first commits on \`${target}\` → https://github.com/${r.repo}/tree/${encodeURIComponent(target)}`;
    pushed = `${lease ? "Replaced the earlier version with" : "Pushed"} ${r.unpublished.length} commit${r.unpublished.length === 1 ? "" : "s"}`;
  }
  // A branch keeps its one PR when what it builds on changes (a stacked parent split, replaced or merged): it moves base.
  const open = r.prUrl && command === "pr" ? await execFileP(await findRealGh(), ["pr", "view", r.prUrl, "--json", "state,baseRefName"], await gho(r.repo, READ)).then(({ stdout }) => JSON.parse(stdout), () => undefined) : undefined;
  const moved = open?.state === "OPEN" ? await retargetBase(r.path, { branch: r.branch, base: r.base, current: open.baseRefName, defaultBranch: r.defaultBase }) : "";
  const onto = moved ? `, moved onto \`${moved}\`` : "";
  if (r.prUrl && command === "pr" && (text?.title || moved)) {
    await execFileP(await findRealGh(), ["pr", "edit", r.prUrl, ...(text?.title ? ["--title", text.title, "--body", text.body] : []), ...(moved ? ["--base", moved] : [])], await gho(r.repo, WRITE, { cwd: r.path })).catch((err) => {
      throw new UserError(`couldn't update the PR. GitHub said: ${String(err.stderr || "gh pr edit failed").trim().slice(-400)}`);
    });
    log("pr updated", { issue: issue.identifier, url: r.prUrl, ...(moved ? { from: open.baseRefName, to: moved } : {}) });
    if (text?.title) return `${pushed ? `${pushed}, updated` : "Updated"} the title and description of ${r.prUrl}${onto}`;
  }
  if (r.prUrl) return `${pushed || "Up to date"}. PR: ${r.prUrl}${onto}`;
  if (command === "push") return `${pushed} → https://github.com/${r.repo}/compare/${r.base}...${encodeURIComponent(r.branch)}?expand=1`;
  // Written for the repository's reviewers: nothing about AidenHQ, tasks or this machine.
  // The base as GitHub has it now: a stacked branch's base only while it still exists and this branch has commits on it.
  const { base, from, error } = await resolvePrBase(r.path, { branch: r.branch, base: r.base, defaultBranch: r.defaultBase });
  if (error) throw new UserError(error);
  const messages = cleanMessages((await messagesSince(r.path, from, r.branch)).join("\x1e"));
  const stat = await git(r.path, "diff", "--stat", `${from}...${r.branch}`).catch(() => "");
  const diff = await git(r.path, "diff", `${from}...${r.branch}`).catch(() => "");
  const oneline = await git(r.path, "log", "--oneline", `${from}..${r.branch}`).catch(() => "");
  const subject = messages.at(-1)?.split("\n")[0] ?? full.title;
  const fallbackTitle = prTitle(oneline, rows.filter((x: any) => !x.merged).length > 1 || leaksInternal(full.title) ? subject : full.title);
  const siblings = rows.filter((x: any) => x !== r && !x.merged);
  // The agent's own title and description (it knows the conversation), unless they mention internal names.
  const own = text?.title && (ownRepo(r.repo) || !leaksInternal(`${text.title}\n${text.body ?? ""}`)) ? { title: String(text.title).slice(0, 200), body: String(text.body ?? "").slice(0, 60_000), generated: false } : undefined;
  const pr: any = own ?? await writePrDescription({
    cfg, repo: r.repo, base,
    request: [
      await prRequest(full),
      siblings.length ? `This pull request is one of ${siblings.length + 1} from this request; it covers only the branch \`${r.branch}\`${r.purpose ? ` (${r.purpose})` : ""}. Describe only its own changes.` : "",
      base !== r.defaultBase ? `It is stacked on \`${base}\`, which has its own pull request.` : "",
    ].filter(Boolean).join("\n\n"),
    messages, stat, diff, report: siblings.length ? undefined : await lastReport(issue.id).catch(() => undefined), fallbackTitle,
  });
  // Our own repos' PRs may name our tools and paths (an Evidence section's .aidenhq/out/ screenshots), as `own` above allows.
  const body = !ownRepo(r.repo) && leaksInternal(pr.body) ? "" : pr.body;
  log("pr description", { issue: issue.identifier, branch: r.branch, generated: pr.generated, rejected: Boolean(pr.rejected), own: Boolean(own), ownRefused: Boolean(text?.title && !own) });
  let adopted;
  const { stdout } = await execFileP(await findRealGh(), ["pr", "create", "--draft", "--repo", r.repo, "--head", r.branch, "--base", base, "--title", pr.title, "--body", body], await gho(r.repo, WRITE, { cwd: r.path })).catch((err) => {
    // The branch already has an open PR (another task opened it): this task takes it over, with the new commits on it.
    adopted = existingPrUrl(err.stderr, r.repo);
    if (adopted) return { stdout: adopted };
    // gh's error message repeats the whole command line (PR body included): show stderr only.
    throw new UserError(`couldn't open the PR. GitHub said: ${String(err.stderr || "gh pr create failed").trim().slice(-400)}`);
  });
  const prUrl: any = stdout.trim().split("\n").pop();
  if (adopted) {
    state.updateBranch(issue.id, r.repo, r.branch, { pr_url: prUrl, closed: 0, closed_head: null });
    log("existing PR adopted", { issue: issue.identifier, url: prUrl });
    return `${pushed ? `${pushed} to the PR that was already open` : "This branch already has an open PR"}: ${prUrl}`;
  }
  state.updateBranch(issue.id, r.repo, r.branch, { pr_url: prUrl, closed: 0, closed_head: null });
  log("draft PR opened", { issue: issue.identifier, url: prUrl });
  // An agents-org PR that changes UI files gets its design review now, beside CI, rather than once its merge is queued:
  // the review was the slowest step on that path, and it started minutes after the PR opened (roadmap-keeper#202: 4
  // minutes). Once per head: the queue's own ask for this head then files nothing more.
  if (inAgentsOrg(r.repo) && designReviewer()) await (async () => merges.touchesUi((await git(r.path, "-c", "core.quotePath=false", "diff", "--name-only", `${from}...${r.branch}`)).split("\n")) && fileDesignReviewTask({ repo: r.repo, number: Number(prUrl.split("/").pop()), url: prUrl, head: pin ?? (await git(r.path, "rev-parse", "--verify", `refs/heads/${r.branch}^{commit}`)) }))().catch((err) => log("design review task failed", { pr: prUrl, err: String(err.message ?? err).slice(0, 300) }));
  return `${pushed ? `${pushed}, opened` : "Opened"} draft PR ${prUrl}`;
}

/**
 * What the PR writer gets as the request: the task, and for an Engineer sub-task also the parent the
 * user wrote, which is where PR wording rules live (PEN-357's "Title: … Body: …").
 */
async function prRequest(full: any) {
  const own = [full.title, requestFrom(full) || stripHidden(full.description ?? "").trim()].filter(Boolean).join("\n\n");
  if (!isAgentSubtask(full)) return own;
  const parent = await pc.issue(full.parentId).catch(() => undefined);
  const parentText = parent ? ownRequest(parent) : "";
  return parentText ? `${own}\n\nThis change is one repository of a larger request (its rules for PR titles and bodies apply):\n\n${parent.title}\n\n${parentText}` : own;
}

export { agentPublish, agentReview, prRequest, publish, reviewedLine, reviewedRefsOf };
