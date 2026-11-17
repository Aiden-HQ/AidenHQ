import { FOR_OTHERS, hasMarker, isAgentSubtask, isRuleProposal, ownRequest, runsUnasked, findRepos, mentionedRepos, parseCommand, pickedEngine, pickerFor, repoAllowed, stripHidden } from "../agents.mjs";
import { architectFollowUps } from "../apply.ts";
import { READ } from "../../../../modules/codehost-github/src/github-app.ts";
import { readApproval } from "../intake.ts";
import { Paperclip } from "../paperclip.ts";
import { UserError } from "../../../../modules/codehost-github/src/workspace.ts";
import * as merges from "../../../../modules/codehost-github/src/merge-gate.mjs";
import { MERGE_REQUESTED, onlyMergesLeft, prSnapshot, stateSection, threadEntries, threadSection } from "../thread.ts";
import { readBusy } from "../busy.ts";
import { normalizeRepo } from "../../../../modules/codehost-github/src/repos.ts";
import { cfg, execFileP, gho, log, pc, queue, running, state } from "./context.ts";
import { agentCaps } from "./poll.ts";
import { mergeQueue, stopMerges } from "./merge.ts";
import { breakerKey, stopped } from "./breaker.ts";
import { checksFromKey, checksOf } from "./card-review.ts";
import { readGrants } from "./apply-path.ts";
import { runCommand } from "./commands.ts";
import { branchRows, findRealGh, handleParentPr, logTail, reportError, startJob, stopping } from "./unsplit.ts";

async function handleIssue(issue: any, engineerIds: any) {
  const known = state.task(issue.id);
  const task = known ?? state.ensureTask(issue.id, issue.identifier);
  // Comments written before the runner first saw the task only count if they are recent
  // (so "comment, then add the label" works, but old discussions don't trigger jobs).
  const horizon = known ? 0 : Date.now() - (cfg.first_seen_lookback_minutes ?? 30) * 60_000;
  const all = await pc.comments(issue.id);
  const userComments = all.filter((c: any) => Paperclip.isUserInstruction(c));
  const comments = userComments.filter((c: any) => !state.handled(c.id));
  const fresh = comments.filter((c: any) => known || Date.parse(c.createdAt) >= horizon);
  for (const c of comments.filter((x: any) => !fresh.includes(x))) state.markHandled(c.id, issue.id);
  // The agent that delegated this task may follow up on it once it has run (the Agent Architect reviewing the Platform Engineer's
  // diff): a new request on the same task, so its next commit replaces the card. Never a command, never a go-ahead.
  const agentNotes = state.get(`history:${issue.id}`) ? all.filter((c: any) => c.authorType === "agent" && c.authorAgentId && !state.handled(c.id)) : [];
  const delegator = agentNotes.length ? (issue.createdByAgentId ?? (await pc.issue(issue.id)).createdByAgentId) : undefined;
  const followUps = agentNotes.length ? architectFollowUps(agentNotes, delegator, readGrants(), { approved: Boolean(state.get(`auto:${issue.id}`)), reopened: issue.status === "todo" }) : [];
  for (const c of agentNotes.filter((x: any) => !followUps.includes(x))) state.markHandled(c.id, issue.id); // other agents: ignored
  if (!fresh.length && followUps.length) {
    for (const c of followUps) state.markHandled(c.id, issue.id);
    const text = followUps.map((c) => stripHidden(c.body).trim()).filter(Boolean).join("\n\n");
    if (text) await handleRequest(issue, `(From an agent, not ${cfg.selfName}'s own words.)\n\n${text}`, { fromAgent: true });
    return;
  }
  if (!fresh.length) {
    // Newly assigned to an Engineer without comments. A task the user wrote themselves is the
    // request (its description); otherwise ask, once.
    // The description may arrive after the assignment (assign, then paste), so it is checked on
    // every update until it has been taken up, not only the first time.
    if (engineerIds.has(issue.assigneeAgentId) && !userComments.length && !running.has(issue.id) && !state.get(`ownreq:${issue.id}`) && !state.get(`history:${issue.id}`)) {
      const full = await pc.issue(issue.id);
      // A task an agent delegated from the owner's own chat, or under a task an agent or routine created (an app incident), just
      // runs: the gate that matters is `apply`, which needs his words. Under his own board tasks, the user's go-ahead stays.
      const chain = [full];
      for (let hops = 0; isAgentSubtask(full) && chain.at(-1)?.parentId && hops < 10; hops++) chain.push(await pc.issue(chain.at(-1).parentId).catch(() => null));
      if (runsUnasked(chain) || isRuleProposal(full, readGrants())) {
        // Runs without the owner's go-ahead (agent work from a chat or app): `auto:` lets its delegator follow up (not `approved:` alone, which the user's go-ahead also sets).
        state.set(`approved:${full.id}`, new Date().toISOString());
        state.set(`auto:${full.id}`, new Date().toISOString());
      }
      if (requestFrom(full)) {
        state.set(`ownreq:${issue.id}`, new Date().toISOString());
        return handleRequest(issue, ""); // the description is the request
      }
      // An agent's sub-task under the owner's own task waits for his go-ahead, and says so once (one log line, one comment).
      const root = chain.at(-1), why = root ? ` under ${root.identifier}, ${cfg.selfName}'s own task,` : " (its parent tasks couldn't be read)";
      if (isAgentSubtask(full)) return full.status !== "todo" || state.get(`held:${issue.id}`) ? undefined : (state.set(`held:${issue.id}`, new Date().toISOString()), log("held for the go-ahead", { issue: issue.identifier, root: root?.identifier ?? null }), pc.comment(issue.id, `Waiting for ${cfg.selfName}'s go-ahead: an agent wrote this task${why} so its description is the agent's request, not ${cfg.selfName}'s words. A comment from ${cfg.selfName} on this task starts it.`));
      if (!state.get(`greeted:${issue.id}`)) {
        state.set(`greeted:${issue.id}`, new Date().toISOString());
        await pc.comment(issue.id, "Ready. What would you like me to do, and in which repository? (Or write it in the task description.)");
      }
    }
    return;
  }

  const texts = [];
  for (const c of fresh) {
    state.markHandled(c.id, issue.id);
    const command = parseCommand(c.body); // exactly "push" or "pr"
    if (command) {
      await runCommand(issue, state.task(issue.id), command);
      continue;
    }
    const text = stripHidden(c.body).trim();
    if (text) texts.push(text);
  }
  if (texts.length) await handleRequest(issue, texts.join("\n\n"));
}

/**
 * The request in a task's description: the user's own task, or a sub-task the Researcher created
 * that the user has given the go-ahead for. Empty for everything else.
 */
function requestFrom(full: any) {
  const own = ownRequest(full);
  if (own) return own;
  return (isAgentSubtask(full) || isRuleProposal(full, readGrants())) && state.get(`approved:${full.id}`) ? stripHidden(full.description).trim() : "";
}

async function handleRequest(issue: any, latest: any, { fromAgent = false } = {}) {
  // A new word from whoever asked (the delegator or the owner) lifts a stop on identical failures, and gives the task its
  // reviewer checks before filing again (agentReview).
  if (latest && stopped(issue.id)) {
    state.set(breakerKey(issue.id), "{}");
    log("breaker cleared", { issue: issue.identifier });
  }
  if (latest && checksOf(issue.id).length) {
    state.set(checksFromKey(issue.id), new Date().toISOString());
    log("review checks reset", { issue: issue.identifier });
  }
  const full = await pc.issue(issue.id);
  let instructions = latest;
  // Commenting on a sub-task the Researcher created is the go-ahead for that one; an agent's comment never is.
  if (latest && !fromAgent && isAgentSubtask(full)) state.set(`approved:${issue.id}`, new Date().toISOString());
  // First run on a task the user wrote (or approved): its title and description are part of the request.
  if (!state.get(`history:${issue.id}`)) {
    const own = requestFrom(full);
    // An agent-written description is shown once, under the Task block, and is the agent's request, never the owner's words.
    if (own) instructions = ownRequest(full) ? [`${full.title}\n\n${own}`, instructions].filter(Boolean).join("\n\n") : instructions || `(From an agent, not ${cfg.selfName}'s own words.)\n\nThe request is the task above.`;
  }
  // A run or merges in progress: the comment may be about that work ("stop", "how's it going?").
  if (latest && (running.has(issue.id) || mergeQueue(issue.id)?.state === "running")) return whileBusy(issue, latest, instructions);
  return dispatch({ issue, instructions });
}

/**
 * A comment while the task's run (or publishing, or its merge queue) is in progress. The agent can't
 * read it until its run ends, so a short reading decides: stop the work, answer a progress question
 * from what the work shows, or keep the comment for the next turn. It never starts anything.
 */
async function whileBusy(issue: any, latest: any, instructions: any) {
  const r = running.get(issue.id);
  const mq = mergeQueue(issue.id);
  const activity = r
    ? `A run started ${r.startedAt} on this request:\n${String(r.request ?? "").slice(0, 3000)}\n\nThe end of its log:\n${r.logPath ? logTail(r.logPath, 30) : "(publishing branches)"}`
    : merges.summary(mq, "The merge queue is running.");
  const read = await readBusy({ cfg, user: cfg.selfName, comment: latest, activity }).catch((err) => (log("busy reading failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }), { decision: "later", answer: "" }));
  log("comment while busy", { issue: issue.identifier, decision: read.decision });
  if (read.decision === "stop") {
    if (r) {
      r.controller.abort();
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].issue.id === issue.id) queue.splice(i, 1);
      return;
    }
    return stopMerges(issue, "you asked me to stop");
  }
  if (read.decision === "answer" && read.answer) return void (await pc.comment(issue.id, read.answer));
  // A session that takes messages while it works gets the comment now, as the user's own words.
  if (await r?.channel?.send?.(latest)) {
    log("comment passed to the run", { issue: issue.identifier });
    return void (await pc.comment(issue.id, `Passed on: ${r.who ?? "the agent"} reads it now, while working.`));
  }
  return dispatch({ issue, instructions });
}

/**
 * Repositories a request can work in: any in the allowed orgs, plus public repositories elsewhere,
 * which are read-only. Tokens outside the orgs are checked on GitHub, so "DA/L1" isn't one.
 */
async function repoCandidates(text: any) {
  const out = findRepos(text, cfg.allowed_orgs).map((r) => r.slug);
  const outside = mentionedRepos(text).filter((r) => !repoAllowed(r, cfg.allowed_orgs)).slice(0, 10);
  for (const r of outside) {
    const slug = await publicRepo(r.slug);
    if (slug && !out.some((o) => o.toLowerCase() === slug.toLowerCase())) out.push(slug);
  }
  return out;
}

const publicRepos = new Map(); // slug (lowercase) → GitHub's name for a public repo, or null
/** GitHub's name for a public repository, or undefined (private, missing, or not a repository). */
async function publicRepo(slug: any) {
  const key = slug.toLowerCase();
  if (!publicRepos.has(key)) {
    let name = null;
    try {
      const { stdout } = await execFileP(await findRealGh(), ["api", `repos/${slug}`, "--jq", "select(.private == false) | .full_name"], { timeout: 20_000 });
      name = stdout.trim() || null;
    } catch {}
    publicRepos.set(key, name);
  }
  return publicRepos.get(key) ?? undefined;
}

async function dispatch(job: any) {
  const { issue } = job;
  // Comments that arrive while a turn waits join it: the agent reads them together.
  const waiting = queue.find((j: any) => j.issue.id === issue.id);
  if (waiting) {
    waiting.instructions = `${waiting.instructions}\n\n${job.instructions}`;
    return;
  }
  if (running.has(issue.id)) {
    queue.push(job);
    await pc.comment(issue.id, "Noted: I'll read this as soon as the current run on this task finishes.");
  } else if (stopping || running.size >= (cfg.max_concurrent ?? 2) || atAgentCap(issue)) {
    queue.push(job);
    await pc.comment(issue.id, `Queued: ${running.size} job(s) already running.`);
  } else {
    void startJob(job);
  }
}

async function dispatchReplies() {
  const r = cfg.replies ?? {};
  const debounceMs = (r.debounce_seconds ?? 90) * 1000;
  const exclude = new Set(r.exclude_labels ?? ["needs-review", cfg.label]);
  let since = state.get("replies_since");
  if (!since) {
    since = new Date(Date.now() - (r.first_run_lookback_hours ?? 24) * 3_600_000).toISOString();
    state.set("replies_since", since);
  }
  const ready = [];
  const pending = [];
  for (const issue of await pc.myOpenIssues()) {
    if ((issue.labels ?? []).some((l: any) => exclude.has(l.name))) continue;
    let fresh = (await pc.comments(issue.id)).filter((c: any) => Paperclip.isUserInstruction(c) && c.createdAt >= since && !state.handled(c.id));
    // A message that @-mentions only other agents went to them: the Researcher leaves it.
    for (const c of fresh.filter((c: any) => hasMarker(c.body, FOR_OTHERS))) state.markHandled(c.id, issue.id);
    fresh = fresh.filter((c: any) => !hasMarker(c.body, FOR_OTHERS));
    if (!fresh.length) continue;
    // An exact "pr" on a parent opens the PRs of all its finished Engineer sub-tasks, right away.
    if (await handleParentPr(issue, fresh)) fresh = fresh.filter((c: any) => !state.handled(c.id));
    if (!fresh.length) continue;
    // Wait until the newest comment on this task is older than the debounce window.
    if (Date.now() - Date.parse(fresh.at(-1).createdAt) < debounceMs) continue;
    // Sub-tasks waiting for a go-ahead on this task: the runner reads the comment first.
    if (await handleGoAhead(issue, fresh)) continue;
    ready.push(issue.identifier);
    pending.push(...fresh.map((c: any) => [c.id, issue.id]));
  }
  if (!ready.length) return;
  await pc.runRoutine(r.routine ?? "Process task replies", { tasks: ready.join(", ") });
  for (const [cid, iid] of pending) state.markHandled(cid, iid);
  log("replies dispatched to Researcher", { tasks: ready });
}

/**
 * If Engineer sub-tasks the Researcher created under this task are waiting, decide whether the
 * user's new comments are the go-ahead. "start" starts them all, "hold" keeps them waiting; anything
 * else (changes, questions) goes to the Researcher as usual. True when the comments were handled here.
 */
async function handleGoAhead(parent: any, fresh: any) {
  const engineers = await pc.engineerAgents();
  const waiting = (await pc.children(parent.id)).filter(
    (c: any) => engineers.some((a) => a.id === c.assigneeAgentId) && isAgentSubtask(c) && c.status === "todo" && !state.get(`approved:${c.id}`) && !state.get(`history:${c.id}`),
  );
  if (!waiting.length) return false;
  const comment = fresh.map((c: any) => stripHidden(c.body).trim()).filter(Boolean).join("\n\n");
  const decision = await readApproval({ cfg, user: cfg.selfName, title: parent.title, waiting, comment }).catch((err) => {
    log("go-ahead check failed", { issue: parent.identifier, err: String(err.message ?? err).slice(0, 300) });
    return "other";
  });
  log("go-ahead read", { issue: parent.identifier, decision, waiting: waiting.length });
  if (decision === "other") return false;
  for (const c of fresh) state.markHandled(c.id, parent.id);
  if (decision === "hold") {
    await pc.comment(parent.id, `OK, the ${waiting.length} Engineer task${waiting.length === 1 ? "" : "s"} will wait until you say go.`);
    return true;
  }
  const now = new Date().toISOString();
  for (const c of waiting) state.set(`approved:${c.id}`, now), state.set(`ownreq:${c.id}`, now);
  await pc.comment(
    parent.id,
    `Starting ${waiting.length} Engineer task${waiting.length === 1 ? "" : "s"}: ${waiting.map((c: any) => c.identifier).join(", ")}. They run ${cfg.max_concurrent ?? 2} at a time, and each one reports on its own task; reply **pr** there to open its PR.`,
  );
  log("sub-tasks approved", { issue: parent.identifier, tasks: waiting.map((c: any) => c.identifier) });
  // Read each sub-task's request in the background; dispatch() queues the runs.
  void (async () => {
    for (const c of waiting) await handleRequest(c, "").catch((err) => reportError(c, err));
  })();
  return true;
} // agent id → max_parallel, refreshed each poll
const atAgentCap = (issue: any) => {
  const cap = agentCaps.get(issue?.assigneeAgentId);
  return Boolean(cap) && [...running.values()].filter((r) => r.agent === issue.assigneeAgentId).length >= cap;
};
function drainQueue() {
  while (!stopping && running.size < (cfg.max_concurrent ?? 2)) {
    const i = queue.findIndex((j: any) => !running.has(j.issue.id) && !atAgentCap(j.issue));
    if (i < 0) return;
    void startJob(queue.splice(i, 1)[0]);
  }
}

// ------------------------------------------------------------------ jobs

/** The task's main repository, for a task that has none yet: the others join its workspace. */
async function setMainRepo(issue: any, slug: any) {
  const repo = normalizeRepo(slug);
  if (!repo) throw new UserError(`\`${slug}\` isn't a GitHub repository I can read.`);
  if (!repoAllowed(repo, cfg.allowed_orgs) && !(await publicRepo(repo.slug))) {
    throw new UserError(`\`${repo.slug}\` is outside your orgs (${cfg.allowed_orgs.join(", ")}) and isn't a public GitHub repository, so I can't work in it.`);
  }
  state.updateTask(issue.id, { repo: repo.slug });
  return state.task(issue.id);
}

/**
 * The executor picked on the task: its Engineer assignee and model override. An engine
 * remembered from before the picker was first seen moves the picker, so the task always shows what
 * runs it. Otherwise the picker wins.
 */
async function syncPicker(issue: any, full: any, task: any) {
  const engineers = await pc.engineerAgents();
  const picked = pickedEngine(full, engineers, cfg);
  if (!picked) return task;
  const seenKey = `picker:${issue.id}`;
  let engine: any = picked;
  if (task.engine && !state.get(seenKey) && task.engine.kind !== picked.kind) {
    const fields = pickerFor(task.engine, engineers);
    if (fields) {
      await pc.setPicker(issue.id, fields);
      engine = pickedEngine({ ...full, ...fields }, engineers, cfg);
    } else engine = task.engine;
  }
  state.set(seenKey, new Date().toISOString());
  state.updateTask(issue.id, { engine });
  return state.task(issue.id);
}

/**
 * What a run sees of the task beyond the request: the conversation since the session last read it
 * (everything for a new session; this run's own request left out) and the live state of its branches,
 * PRs and merges. GitHub or Paperclip being unreachable leaves a part out rather than failing the run.
 */
async function conversation(issue: any, workspace: any, { instructions, resumed, persona }: any) {
  const key = `thread_upto:${issue.id}`;
  const seen = state.get(key) || ""; // the newest comment any earlier run of this task was given
  const upto = resumed ? seen : "";
  const comments = await pc.comments(issue.id).catch((err) => (log("thread unavailable", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }), []));
  const agents = await pc.agents().catch(() => []);
  const entries = threadEntries(comments.filter((c: any) => c.createdAt > upto), {
    user: cfg.selfName,
    you: persona?.name,
    agents,
    // This run's request: comments no run has seen yet, which the instructions carry.
    current: (c: any) => c.createdAt > seen && instructions.includes(stripHidden(c.body).trim()),
  });
  if (comments.length) state.set(key, comments.at(-1).createdAt);
  return {
    thread: threadSection(cfg.selfName, entries, { resumed }),
    stand: await liveState(issue, workspace),
  };
}

/**
 * Where the task's work stands, read now: branches, their PRs on GitHub, and the merge queue. For `wait`, led by
 * MERGE_REQUESTED when every PR in flight has its merge requested or queued and only CI or the queue is left.
 */
async function liveState(issue: any, workspace: any, { wait = false } = {}) {
  const rows = await branchRows(issue, workspace).catch(() => []);
  const prs = new Map();
  const gh = await findRealGh().catch(() => "");
  await Promise.all(
    [...new Set(rows.filter((r) => r.prUrl && !r.merged).map((r) => r.prUrl))].map(async (url) => {
      const { stdout } = await execFileP(gh, ["pr", "view", url, "--json", "state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup"], await gho(normalizeRepo(url)?.slug, READ, { timeout: 20_000 })).catch(() => ({ stdout: "" }));
      prs.set(url, prSnapshot(stdout ? JSON.parse(stdout) : undefined));
    }),
  );
  const queue = mergeQueue(issue.id);
  const text = stateSection({ rows, prs, merges: queue ? merges.summary(queue, queue.state === "running" ? "Running." : queue.state === "stopped" ? `Stopped: ${queue.reason}.` : "Done.") : "" });
  if (!wait) return text;
  const requested = JSON.parse(state.get("auto_merges") || "{}")[issue.id]?.prs ?? [];
  const queued = queue?.state === "running" ? queue.prs.filter((p: any) => p.status === "pending") : [];
  return onlyMergesLeft(rows, prs, [...requested, ...queued].map((p) => p.url.toLowerCase())) ? `${MERGE_REQUESTED}\n\n${text}` : text;
}

// ------------------------------------------------------------------ the agent's tools (aidenhq …)

/** `aidenhq status` (and `aidenhq wait`, with `wait`): where the task's work stands, read now. */
async function agentStatus({ issue, workspace }: any, { wait }: any = {}) {
  return (await liveState(issue, workspace, { wait: wait === true })) || "No branches, PRs or merges on this task yet.";
}

export { agentStatus, conversation, dispatch, dispatchReplies, drainQueue, handleIssue, publicRepo, repoCandidates, requestFrom, setMainRepo, syncPicker };
