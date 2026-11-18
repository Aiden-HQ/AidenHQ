// The runner's side of an apply until the big switch (what may land, and the executor, are kernel/src/apply.ts): the trial
// edits a graduation card lists, who may use the trial exception, and the runner's wait on the host's apply lock.
import { git } from "../../../modules/codehost-github/src/git.mjs";
import { APPLY_LOCK, applyIsBusy, definitionsOf, isTrial } from "../../../kernel/src/apply.ts";

/**
 * The graduation card's list of what changed without a tap: when the change flips an agent from trial to not-trial,
 * the handbook-only commits on main touching its AGENTS.md since the commit that added its agent.yaml (tap 1), up to the
 * change's merge base. Built from git by the runner, never from agent-written text. "" when nothing graduates.
 */
export async function trialEditsText(repoPath: string, base: string, files: string[], texts: { base: Record<string, string | undefined>; head: Record<string, string | undefined> }) {
  const out: string[] = [];
  for (const def of definitionsOf(files)) {
    if (!isTrial(texts.base[def]) || texts.head[def] === undefined || isTrial(texts.head[def])) continue;
    const key = def.split("/")[1];
    const book = `agents/${key}/AGENTS.md`;
    const added = (await git(repoPath, "log", "--diff-filter=A", "--format=%H", base, "--", def)).split("\n").filter(Boolean).pop();
    if (!added) continue;
    const edits: string[] = [];
    for (const sha of (await git(repoPath, "log", "--first-parent", "--format=%H", `${added}..${base}`, "--", book)).split("\n").filter(Boolean)) {
      const [date, short, ...subject] = (await git(repoPath, "log", "-1", "--format=%as%x09%h%x09%s", sha)).split("\t");
      const diff = (mode: string, ...paths: string[]) => git(repoPath, "diff", "--no-renames", mode, `${sha}^1`, sha, ...paths);
      const [num] = (await diff("--numstat", "--", book)).split("\n").map((l) => l.split("\t"));
      const others = (await diff("--name-only")).split("\n").filter((f) => f && f !== book);
      const subj = subject.join(" ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
      edits.push(`${short}  ${date}  ${subj}  (+${num?.[0] ?? 0} -${num?.[1] ?? 0})${others.length ? `  also changed: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ` +${others.length - 5} more` : ""}` : ""}`);
    }
    out.push(`${key}: ${edits.length ? `${edits.length} handbook change${edits.length === 1 ? "" : "s"} since the trial began (those not marked "also changed" landed without a tap):\n${edits.join("\n")}` : "no handbook changes since the trial began."}`);
  }
  return out.length ? `Trial edits that landed without a tap:\n${out.join("\n")}` : "";
}

/**
 * Who may use the trial exception: a task the owner created, or one the Agent Architect created (its follow-ups included), by
 * the `architect` role in the host's grants table (never Paperclip metadata, which agents can edit). Any other agent's
 * task gets a card. No grants table: a card (fail closed).
 */
const isArchitect = (grants: any, agentId: string | undefined) => Boolean(agentId) && (grants?.agents?.[agentId!]?.roles ?? []).includes("architect");

export function trialNoTapBy(issue: any, grants: any, runnerMade = false): boolean {
  if (issue?.createdByAgentId) return isArchitect(grants, issue.createdByAgentId);
  return ownerMade(issue, runnerMade);
}

/**
 * The owner wrote the task: a user created it and no agent did. `runnerMade`: the runner filed it itself (a Dependabot PR's
 * task, with the board key, so Paperclip names the owner): never the owner's. Every owner-origin check uses this.
 */
export const ownerMade = (issue: any, runnerMade = false): boolean => Boolean(issue?.createdByUserId) && !issue.createdByAgentId && !runnerMade;

// The host's apply lock, seen from the runner. ops/apply-config.sh opens data/apply.lock, holds it for the whole apply and
// refuses a second one at once with "another apply is running" (ops/lib/apply-lock.sh). That refusal is right for the lock
// and wrong for a land: the commit is already on main and the apply holding the lock is about to finish, so reporting the
// change as failed is a spurious failure. A land waits the lock out instead, bounded, and then applies; a lock that
// outlasts the bound is reported as that, naming the lock and the time waited, never as the change having failed.
export const APPLY_LOCK_WAIT_MS = 15 * 60_000;
export const APPLY_LOCK_POLL_MS = 2_000;
/** The apply's own words when another process holds the lock (ops/apply-config.sh). */
export const applySaysLocked = (text: unknown) => /another apply is running/.test(String(text ?? ""));
/** A wait as the operator reads it: "0.6s", "9m05s". */
const waitedText = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);

/**
 * One host apply, waiting out a lock another apply holds: `run` is one attempt (ops/apply-config.sh), tried again once the
 * lock is free, while the bound still has room. A lock that does not clear within the bound comes back `timedOut`, naming
 * the lock and the wait, and the apply is not run again on top of it. Any other failure is the apply's own and comes back
 * untouched.
 */
export async function applyWaitingForLock(run: () => Promise<any>, repoPath: string, { boundMs = APPLY_LOCK_WAIT_MS, pollMs = APPLY_LOCK_POLL_MS } = {}) {
  const start = Date.now();
  const deadline = start + boundMs;
  const outOfTime = (out: any) => {
    const waitedMs = Date.now() - start;
    return { ...out, ok: false, timedOut: true, waitedMs, text: `${out.text}\ntimed out: ${APPLY_LOCK} was still being refused after waiting ${waitedText(waitedMs)}, so the instance was not re-applied on this host` };
  };
  for (;;) {
    const out = await run();
    if (out.ok || !applySaysLocked(out.text)) return out;
    // The apply refused on the lock: wait it out, polling by trying the lock itself so nothing is held meanwhile. The first
    // sleep spaces the attempts too: a probe can see the lock free a moment before another apply takes it.
    do {
      await new Promise((r) => setTimeout(r, Math.max(Math.min(pollMs, deadline - Date.now()), 1)));
    } while (Date.now() < deadline && (await applyIsBusy(repoPath)));
    // The bound is spent: that is the outcome, and nothing is tried on top of it. The clock decides, never the probe alone.
    if (Date.now() >= deadline) return outOfTime(out);
  }
}
