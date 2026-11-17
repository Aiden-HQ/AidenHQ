import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../config.mjs";
import { applyWaitingForLock, bumpTitle, definitionsOf, productPin, strayFiles, trialEditsText, trialHandbookOnly, untrialedNewAgents } from "../apply.ts";
import { applyCardArgs } from "../cards.ts";
import { hostFetch, remoteCodeText } from "../../../../kernel/src/loader/sources.ts";
import { ISOLATED_ENV, SAFE_GIT_ARGS, changeBase, git, landOnMain } from "../../../../modules/codehost-github/src/git.mjs";
import { UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import YAML from "yaml";
import { botIdentity, cfg, execFileP, log, pc, running, state } from "./context.ts";
import { trialNoTap } from "./watch.ts";
import { applyTierState, authorityOf, autonomyNow, fileApproval, tierFor, waitingFor } from "./tier-state.ts";
import { reportOutcome, whileApplying } from "./approvals.ts";
import { branchRows, prepareWorkspace } from "./unsplit.ts";

/** Approved fleet change: lands exactly the approved commit, re-checked, then re-applies the instance on this host. */
async function applyApproved(issue: any, a: any) {
  if (!cfg.apply?.repo) throw new UserError("applying the fleet's configuration isn't set up here (`apply.repo` in config/runner.yaml)");
  const task = state.task(issue.id);
  const workspace = await prepareWorkspace(issue, task, { clone: false });
  const b: any = await fleetBranch(issue, workspace);
  if (b.error) throw new UserError(b.error);
  const { r }: any = b;
  if (r.branch !== a.args.branch) throw new UserError(`the task's branch is now \`${r.branch}\`, not the approved \`${a.args.branch}\``);
  const c: any = a.args.sha === b.sha ? b : await fleetChange(r, a.args.sha);
  const stray = strayFiles(c.files);
  if (!c.files.length) throw new UserError(`nothing to apply: the approved commit has no changes against ${r.defaultBase}`);
  if (stray.length) throw new UserError(`it changes files outside the instance config (${stray.join(", ")})`);
  const t = await agentTexts(c);
  const untrialed = untrialedNewAgents(c.files, t.base, t.head);
  if (untrialed.length) throw new UserError(`a new agent must start in trial (${untrialed.join(", ")})`);
  const bump = await productBump(c);
  if (bump?.error) throw new UserError(bump.error);
  // What lands must be what the card showed: the same diff (and product move) as approved, recomputed here.
  if ((await fleetDiffText(c, bump)) !== a.details || c.files.join("\n") !== a.args.files.join("\n")) throw new UserError("the change no longer matches the diff that was approved; it needs a new approval");
  return landFleet(issue, r, a.args.sha, c.files, `approval ${a.id}`, `Applied on ${cfg.selfName}'s approval ${a.id} (${issue.identifier})`);
}

/** Lands a checked fleet commit on the latest main (no force), then re-applies the instance on this host. */
function landFleet(issue: any, r: any, approvedSha: any, files: any, why: any, message: any, guard?: any) {
  return whileApplying(issue, "applying the fleet change", async () => {
    const sha = await landOnMain(r.path, r.defaultBase, approvedSha, message, ({ guard, identity: await botIdentity() } as any));
    if (!sha) throw new UserError(`the change conflicts with ${r.defaultBase}; the Platform Engineer must rebase${why.startsWith("approval") ? ", and the new diff needs a new approval" : ""}`);
    await git(r.path, "fetch", "--quiet", "origin");
    state.updateBranch(issue.id, r.repo, r.branch, { pushed: 1 });
    log("fleet config applied: pushed", { issue: issue.identifier, sha, why, files });
    // The apply waits out a lock another apply holds (a concurrent land, or an operator running one): it is refused at
    // once with "another apply is running" (ops/apply-config.sh), which is a reason to wait, not a failed change.
    const out = await applyWaitingForLock(
      () => execFileP("bash", [join(REPO_ROOT, "ops/apply-config.sh"), sha], { maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60_000 }).then((o) => ({ ok: true, text: o.stdout + o.stderr }), (e) => ({ ok: false, text: `${e.stdout ?? ""}${e.stderr ?? e.message}` })),
      REPO_ROOT,
    );
    // Done with the branch only once it is live: after a failed apply the next turn shows it again, for a retry.
    if (out.ok) state.updateBranch(issue.id, r.repo, r.branch, { merged: 1 });
    const tail = out.text.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-40).join("\n");
    const head = out.ok ? "Applied" : out.timedOut ? "**Pushed to main, but the apply waited out its bound on the lock and stopped**" : "**Pushed to main, but the apply script failed**";
    const said = `${head} (${why}): \`${r.defaultBase}\` is now \`${sha.slice(0, 9)}\`.\n\n\`\`\`\n${tail}\n\`\`\``;
    await pc.comment(issue.id, said);
    return { ok: out.ok, text: said };
  });
}

/** The agent definitions a change touches, at its merge base and at the change (path → text; absent when not there). */
async function agentTexts(c: any) {
  const [base, head] = await Promise.all([textsAt(c, c.base), textsAt(c, c.sha)]);
  return { base, head };
}
async function textsAt(c: any, rev: any) {
  const out: any = {};
  for (const p of definitionsOf(c.files)) {
    const t = await git(c.r.path, "show", `${rev}:${p}`).catch(() => undefined);
    if (t !== undefined) out[p] = t;
  }
  return out;
}

/** The host's grants table (scripts/paperclip-setup.mjs), or undefined: the trial exception then fails closed. */
function readGrants() {
  try {
    return JSON.parse(readFileSync(grantsPath(), "utf8"));
  } catch {
    return undefined;
  }
}
const grantsPath = () => cfg.grants_file ?? join(process.env.AIDENHQ_CONFIG_DIR ?? join(REPO_ROOT, "config"), "grants", "grants.json");
/** The instance commit this host last applied: the latest `instance_sha` setup recorded in revs.jsonl, beside the grants. */
function deployedInstance() {
  try {
    return JSON.parse((readFileSync(join(dirname(grantsPath()), "revs.jsonl"), "utf8").trim().split("\n").at(-1) as any)).instance_sha ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handbook edits to agents in trial: showFleetDiff queues them instead of filing a card; here, once
 * the run is over, the same commit is checked again from git (only those handbooks, the agents still in trial on main)
 * and landed. The diff and the outcome are comments on the task, which is how they show in Activity. Never retried here;
 * after a failed apply-config the branch stays open, so the agent's next turn shows it again (landing it again is a no-op).
 */
async function runTrialEdits() {
  const box: any = JSON.parse(state.get("trial_edits") || "{}");
  for (const [issueId, want] of (Object.entries(box) as any)) {
    if (running.has(issueId)) continue;
    delete box[issueId];
    state.set("trial_edits", JSON.stringify(box));
    try {
      const issue = await pc.issue(issueId);
      const workspace = await prepareWorkspace(issue, state.task(issue.id), { clone: false });
      const b: any = await fleetBranch(issue, workspace);
      if (b.error) throw new UserError(b.error);
      if (b.sha !== want.sha || b.r.branch !== want.branch) throw new UserError("the branch moved since the edit was shown; the Platform Engineer's next turn shows it again");
      if (want.tier0) {
        // Tier 0: recomputed now, and again against the exact main it lands on; anything higher gets a card next turn.
        if (autonomyNow() === "off") throw new UserError("autonomy was turned off, so it needs a tap");
        const bump = await productBump(b);
        const t = await tierFor(issue, "apply", await applyTierState(b, bump));
        if (t.reject || t.tier !== 0) throw new UserError(`it's no longer Tier 0 (${t.reason}), so it needs a card`);
        const guard = async (main: any) => (await tierFor(issue, "apply", await applyTierState(b, bump, main))).tier === 0;
        // Its record first: an apply is read by the AI reviewer at least (the kernel's floor), so it lands once approved.
        const rec = await fileApproval(issue, { action: "apply", args: { repo: b.r.repo, branch: b.r.branch, sha: b.sha, files: b.files }, diff: await fleetDiffText(b, bump), ts: [t] });
        if (rec.state !== "used") { await pc.comment(issueId, waitingFor(rec, issue)); continue; }
        await reportOutcome(rec.id, await landFleet(issue, b.r, b.sha, b.files, `Tier 0: ${t.reason}`, `Tier 0 change (${issue.identifier}): ${t.rule}`, guard));
        continue;
      }
      if (!trialNoTap(await pc.issue(issueId), readGrants()) || !trialHandbookOnly(b.files, (await agentTexts(b)).base)) throw new UserError("it's no longer a handbook-only edit to an agent in trial, so it needs a tap");
      // Checked again on the exact main it lands on: an agent that graduated meanwhile gets a card.
      const guard = async (main: any) => trialHandbookOnly(b.files, await textsAt(b, main));
      const rec = await fileApproval(issue, { action: "apply", args: { repo: b.r.repo, branch: b.r.branch, sha: b.sha, files: b.files }, diff: await fleetDiffText(b, await productBump(b)), ts: [{ tier: 0, rule: "trial-handbook", reason: "a handbook edit to an agent in trial: no tap needed" }] });
      if (rec.state !== "used") { await pc.comment(issueId, waitingFor(rec, issue)); continue; }
      await reportOutcome(rec.id, await landFleet(issue, b.r, b.sha, b.files, "a handbook edit to an agent in trial: no tap needed", `Handbook edit to an agent in trial (${issue.identifier})`, guard));
    } catch (err: any) {
      await pc.comment(issueId, `**The trial handbook edit didn't land:** ${String(err instanceof UserError ? err.message : err.stderr || err.message || err).trim().slice(0, 1000)}`).catch(() => {});
    }
  }
}

// Fleet changes (Platform Engineer): when a run ends with a change on the instance repo's task branch, the runner shows the
// diff and files it as an approval card; on the tap, applyApproved() lands exactly that commit on main and runs
// ops/apply-config.sh on this host. Only instance config may differ from main (apply.ts), so a prompt-injected edit to a
// script can't run here; the push can't force.

/**
 * The fleet repo's one task branch, and the change a commit on it makes: its diff against its merge base with
 * origin/main (not main's tip, so a main that moved since doesn't show up as reverts). { error } when there isn't exactly one branch.
 */
async function fleetBranch(issue: any, workspace: any) {
  const slug = cfg.apply?.repo;
  const rows = slug ? (await branchRows(issue, workspace)).filter((r) => r.repo.toLowerCase() === slug.toLowerCase() && r.branch !== r.defaultBase && !r.merged) : [];
  if (rows.length !== 1) return { error: `Need exactly one branch of ${slug} on this task to apply; there are ${rows.length}${rows.length ? `: ${rows.map((r) => r.branch).join(", ")}` : ""}.` };
  const [r]: any = rows;
  await git(r.path, "fetch", "--quiet", "origin");
  const sha: any = await git(r.path, "rev-parse", "--verify", `refs/heads/${r.branch}^{commit}`);
  return { r, sha, ...((await fleetChange(r, sha)) as any) };
}

async function fleetChange(r: any, sha: any) {
  const base = await changeBase(r.path, `refs/remotes/origin/${r.defaultBase}`, sha, deployedInstance());
  const files = (await git(r.path, "diff", "--no-renames", "--name-only", base, sha)).split("\n").filter(Boolean);
  const pin = (rev: any) => git(r.path, "show", `${rev}:instance.yaml`).then(productPin, () => undefined);
  return { r, sha, base, files, pins: async () => ({ from: await pin(base), to: await pin(sha) }), diff: () => execFileP("git", [...SAFE_GIT_ARGS, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", base, sha], { cwd: r.path, maxBuffer: 32 * 1024 * 1024, env: ISOLATED_ENV }).then((o) => o.stdout), log: () => git(r.path, "log", "--format=%s", `${base}..${sha}`) };
}

/**
 * The product commits an instance change brings by moving its `product:` pin (null when it doesn't move it), or { error }
 * when the new pin isn't on the product's main: nothing unmerged runs on the host.
 */
async function productBump(c: any) {
  const { from, to } = await c.pins();
  if (!to || from === to) return null;
  await git(REPO_ROOT, "fetch", "--quiet", "origin", "main");
  if (!(await git(REPO_ROOT, "merge-base", "--is-ancestor", to, "refs/remotes/origin/main").then(() => true, () => false))) return { error: `product \`${to.slice(0, 9)}\` is not on the product's main` };
  const isAncestor = (a: any, b: any) => git(REPO_ROOT, "merge-base", "--is-ancestor", a, b).then(() => true, () => false);
  const forward = !from || (await isAncestor(from, to));
  const back = !forward && (await isAncestor(to, from));
  const title = bumpTitle({ from, to, forward, back });
  if (!title) return { error: `product pins \`${from.slice(0, 9)}\` and \`${to.slice(0, 9)}\` have diverged (neither contains the other)` };
  const log = !from ? "" : await git(REPO_ROOT, "log", "--oneline", "--no-decorate", forward ? `${from}..${to}` : `${to}..${from}`);
  return { from, to, title, forward, back, log: log || "(no commits)" };
}

/** The diff a card shows (and applyApproved rechecks): the change's content diff, plus the product move it brings. */
async function fleetDiffText(c: any, bump: any) {
  const diff = await c.diff();
  const trial = await trialEditsText(c.r.path, c.base, c.files, await agentTexts(c)).catch((e) => `Trial edits: couldn't be read (${String(e.message ?? e).split("\n")[0]!.slice(0, 150)}); check Activity before approving.`);
  return [diff, bump && `${bump.title.replaceAll("`", "")}:\n${bump.log}`, await remoteCode(c), trial].filter(Boolean).join("\n\n");
}

/** The third-party module code an instance.yaml change brings (sources.ts remoteCodeText), for the reviewer to read. */
async function remoteCode(c: any) {
  if (!c.files.includes("instance.yaml")) return "";
  try {
    const [bi, hi] = await Promise.all([c.base, c.sha].map(async (rev) => YAML.parse(await git(c.r.path, "show", `${rev}:instance.yaml`).catch(() => "")) ?? {}));
    if (!bi.marketplaces && !hi.marketplaces) return "";
    return remoteCodeText(bi, hi, { ...hostFetch(REPO_ROOT), parse: (t) => YAML.parse(t) });
  } catch (err: any) {
    return `Third-party module code: couldn't be read (${String(err.message ?? err).split("\n")[0]!.slice(0, 150)}).`;
  }
}

/**
 * The full content diff of the fleet branch, written by the runner (not the agent) into the reply, and filed as the
 * approval card for exactly that commit: one tap (or `apply <task>`) lands it.
 */
async function showFleetDiff(issue: any, workspace: any) {
  const b: any = await fleetBranch(issue, workspace).catch(() => ({ error: "x" }));
  if (b.error || !b.files.length) return "";
  // No duplicate-card guard for an apply: the instance's main can be ahead of what this host runs (a failed apply-config),
  // so the change being on main never means it was applied.
  const stray = strayFiles(b.files);
  if (stray.length) return `**Can't be applied:** it changes files outside the instance config (${stray.join(", ")}). Only instance.yaml, apps.yaml, agents/<key>.md and agents/<key>/{agent.yaml,AGENTS.md} can be applied; product code and module handbooks change through an Engineer PR.`;
  const diff = await b.diff();
  if (diff.length > 60_000) return `**Diff too large to review** (${b.files.length} files, ${diff.length} characters): it can't be applied as it is. Split the change into smaller ones.`;
  const t = await agentTexts(b);
  const untrialed = untrialedNewAgents(b.files, t.base, t.head);
  if (untrialed.length) return `**Can't be applied:** a new agent starts in trial (\`trial: true\` in agents/${untrialed[0]}/agent.yaml, read-only grants, reporting to architect); its write grants come with a second change after the trial.`;
  // The tier from the verified instance diff (autonomy off: Tier 0 is a card and the rest review-first, tiers.mjs
  // autonomyCap). Tier 0 lands after this run like the trial exception.
  const on = autonomyNow() !== "off";
  const bump: any = await productBump(b).catch((e) => ({ error: e.message }));
  if (bump?.error) return `**Can't be applied:** ${bump.error}.`;
  const st = await applyTierState(b, bump);
  const tier = await tierFor(issue, "apply", st);
  if (tier.reject) return `**Can't be applied:** ${tier.reason}.`;
  // Only on a task the owner or the Agent Architect started: anyone else's handbook edit (or a chain of agent comments) gets a card.
  if (on ? tier.tier === 0 : trialHandbookOnly(b.files, t.base) && trialNoTap(await pc.issue(issue.id), readGrants())) {
    // The trial exception: lands after this run, with no card (runTrialEdits). The diff stays here, in Activity.
    state.set("trial_edits", JSON.stringify({ ...JSON.parse(state.get("trial_edits") || "{}"), [issue.id]: { sha: b.sha, branch: b.r.branch, ...(on ? { tier0: true } : {}) } }));
    return `**${on ? `Runs at once (Tier 0: ${tier.reason})` : "Handbook edit to an agent in trial"}** (commit \`${b.sha.slice(0, 12)}\`): no tap needed, it lands in a moment.\n\n\`\`\`diff\n${diff.replaceAll("```", "‵‵‵")}\n\`\`\``;
  }
  // A review-first card (new module authority, or autonomy off) is filed for the reviewer (Tier 1); its approve goes on to the owner.
  const reviewFirst = Boolean(tier.reviewFirst);
  const card: any = await fileApproval(issue, { action: "apply", args: applyCardArgs(b, ...authorityOf(st)), diff: await fleetDiffText(b, bump), ts: [tier] }).catch((err) => ({ error: String(err.message ?? err).slice(0, 300) }));
  const upgrade = bump ? `\n\n**${bump.title}:**\n\n\`\`\`\n${bump.log.replaceAll("```", "‵‵‵")}\n\`\`\`` : "";
  const ask = card.error
    ? `**Couldn't file the approval card:** ${card.error}. Nothing will be applied until it is filed; ask the agent to try again.`
    : card.tier === 1 && reviewFirst
      ? `**With the AI reviewer, then you** (${card.id}: ${tier.reason}): the reviewer reads it first and its reject is final; if it approves, the card comes to you with its verdict. On your approval it lands exactly this commit on the latest \`${b.r.defaultBase}\`.`
    : card.tier === 1
      ? `**With the AI reviewer** (${card.id}, Tier 1: ${tier.reason}): it approves, rejects with a reason, or sends it to you. On approval it lands exactly this commit on the latest \`${b.r.defaultBase}\`.`
      : `**Waiting for your approval** (${card.id}): tap Approve on the board's Approvals tab or the Telegram card${card.replaced ? "" : `, or reply \`apply ${issue.identifier}\``}. It lands exactly this commit on the latest \`${b.r.defaultBase}\`; Reject and nothing lands.`;
  return `**Fleet change** (commit \`${b.sha.slice(0, 12)}\`, ${b.files.length} file${b.files.length === 1 ? "" : "s"}):\n\n\`\`\`diff\n${diff.replaceAll("```", "‵‵‵")}\n\`\`\`${upgrade}\n\n${ask}`;
}

/** `aidenhq apply`: nothing to run any more. The runner files the card itself when the turn ends. */
async function agentApply(ctx: any) {
  if (!ctx.brief || !cfg.apply?.repo) throw new UserError("Applying the fleet's configuration isn't set up for this agent (`apply.repo` in config/runner.yaml).");
  return `Nothing to run: when your turn ends, the runner shows ${cfg.selfName} the diff of your committed change as an approval card, and it lands on their tap. End your turn with the change committed, saying in one line what it does.`;
}

export { agentApply, applyApproved, fleetBranch, fleetDiffText, productBump, readGrants, runTrialEdits, showFleetDiff };
