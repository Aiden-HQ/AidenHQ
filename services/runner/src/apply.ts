// What `aidenhq apply` may land: the instance repo's config only (instance.yaml, apps.yaml, handbook additions).
// Product code and module handbooks change through Engineer PRs; the instance pins the product (`product: <sha>`), so
// upgrading the product is itself an instance change that the owner sees with its commit log.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { git } from "../../../modules/codehost-github/src/git.mjs";

// Agents the instance defines itself live in agents/<key>/ (agent.yaml + AGENTS.md); owner/profile.md is how the owner works.
export const APPLY_PATHS = /^(instance\.yaml|apps\.yaml|agents\/[\w.-]+\.md|agents\/[a-z0-9][a-z0-9-]*\/(agent\.yaml|AGENTS\.md|memory\.md)|owner\/profile\.md)$/;

/** Files a change touches outside what apply may land. */
export const strayFiles = (files: string[]) => files.filter((f) => !APPLY_PATHS.test(f));

const HANDBOOK = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/;
const DEFINITION = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/;
/** An agent.yaml that puts its agent in trial (a top-level `trial: true`). */
export function isTrial(text: unknown): boolean {
  try {
    return text != null && YAML.parse(String(text))?.trial === true;
  } catch {
    return false;
  }
}
/** The agent.yaml paths whose content the two checks below need, at the merge base and at the change. */
export const definitionsOf = (files: string[]) => [...new Set(files.map((f) => HANDBOOK.exec(f)?.[1] ?? DEFINITION.exec(f)?.[1]).filter(Boolean))].map((k) => `agents/${k}/agent.yaml`);

/**
 * Agents a change adds that don't start in trial. A new agent always starts read-only ("draft, don't do"), so tap 1 is
 * safe to approve; its write grants come with tap 2, a change to an agent that already exists. `base`/`head`: path → text
 * (undefined when the file isn't there).
 */
export const untrialedNewAgents = (files: string[], base: Record<string, string | undefined>, head: Record<string, string | undefined>) =>
  files.filter((f) => DEFINITION.test(f) && base[f] === undefined && head[f] !== undefined && !isTrial(head[f])).map((f) => DEFINITION.exec(f)![1]);

/**
 * The trial exception: a change that only edits the handbooks of agents in trial lands without a
 * tap. In trial means at the merge base (main as it was), not on the branch, and the definition isn't in the change.
 */
export const trialHandbookOnly = (files: string[], base: Record<string, string | undefined>) =>
  files.length > 0 && files.every((f) => HANDBOOK.test(f) && isTrial(base[`agents/${HANDBOOK.exec(f)![1]}/agent.yaml`]));

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

/** The delegating agent's follow-ups on its task: always the Architect's; any delegator's on a task that runs without the owner's go-ahead (`approved`). */
export const architectFollowUps = (comments: any[], delegatorId: string | undefined, grants: any, { approved = false, reopened = false } = {}) =>
  // Reopened (todo) by an agent after a run, on a task that already runs unasked: any agent's comment is the next request, as a
  // fresh task_delegate from that agent would be (so Aiden can restart an Engineer task another agent delegated).
  approved && reopened ? comments
  : delegatorId && (approved || isArchitect(grants, delegatorId)) ? comments.filter((c: any) => c.authorAgentId === delegatorId) : [];

export function trialNoTapBy(issue: any, grants: any, runnerMade = false): boolean {
  if (issue?.createdByAgentId) return isArchitect(grants, issue.createdByAgentId);
  return ownerMade(issue, runnerMade);
}

/**
 * The owner wrote the task: a user created it and no agent did. `runnerMade`: the runner filed it itself (a Dependabot PR's
 * task, with the board key, so Paperclip names the owner): never the owner's. Every owner-origin check uses this.
 */
export const ownerMade = (issue: any, runnerMade = false): boolean => Boolean(issue?.createdByUserId) && !issue.createdByAgentId && !runnerMade;

/** instance.yaml's top-level `product:` pin (a full sha), or undefined. */
export function productPin(text: unknown): string | undefined {
  return /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(String(text ?? ""))?.[1];
}

/**
 * How a `product:` move reads to the owner: an upgrade adds commits, a rollback removes them (and says so). undefined when
 * neither pin is an ancestor of the other (diverged): that move is refused.
 */
export function bumpTitle({ from, to, forward, back }: { from?: string; to: string; forward?: boolean; back?: boolean }): string | undefined {
  const s = (x: string) => `\`${x.slice(0, 9)}\``;
  if (!from) return `Product pinned at ${s(to)}`;
  if (forward) return `Product upgrade ${s(from)} → ${s(to)}, adding these commits`;
  if (back) return `Product DOWNGRADE (rollback) ${s(from)} → ${s(to)}, removing these commits`;
}

// The host's apply lock, seen from the runner. ops/apply-config.sh opens data/apply.lock, holds it for the whole apply and
// refuses a second one at once with "another apply is running" (ops/lib/apply-lock.sh). That refusal is right for the lock
// and wrong for a land: the commit is already on main and the apply holding the lock is about to finish, so reporting the
// change as failed is a spurious failure. A land waits the lock out instead, bounded, and then applies; a lock that
// outlasts the bound is reported as that, naming the lock and the time waited, never as the change having failed.
export const APPLY_LOCK = "data/apply.lock";
export const APPLY_LOCK_WAIT_MS = 15 * 60_000;
export const APPLY_LOCK_POLL_MS = 2_000;
/** The apply's own words when another process holds the lock (ops/apply-config.sh). */
export const applySaysLocked = (text: unknown) => /another apply is running/.test(String(text ?? ""));
// flock's -E status for "somebody else holds it", so a probe's other failures stay failures.
const FLOCK_BUSY = 75;

/** Whether another process holds <repo>/data/apply.lock now: a probe that locks the file itself, so a free lock stays free. */
export function applyIsBusy(repoPath: string): Promise<boolean> {
  const lock = join(repoPath, APPLY_LOCK);
  // The entry point creates it before it locks; no file is no apply running (and flock won't open one that isn't there).
  if (!existsSync(lock)) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    execFile("flock", ["-n", "-E", String(FLOCK_BUSY), lock, "true"], (err: (Error & { code?: unknown }) | null) => {
      if (!err) return resolve(false);
      if (err.code === FLOCK_BUSY) return resolve(true);
      reject(new Error(`couldn't check whether ${lock} is held (${err.message})`));
    });
  });
}

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

// `node apply.ts product-pin <instance.yaml>`: the pin, for ops/apply-config.sh (one parser for both). `product-fork`: the
// kernel's fork (product_fork:, spec §6.9b) as "<url> <sha>", or nothing; a malformed one exits 1.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && ["product-pin", "product-fork"].includes(process.argv[2]!)) {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(process.argv[3]!, "utf8");
  if (process.argv[2] === "product-pin") process.stdout.write(productPin(text) ?? "");
  else {
    const { forksOf } = await import("../../../kernel/src/loader/sources.ts");
    const k = forksOf(YAML.parse(text) ?? {}).find((x) => x.target === "kernel");
    process.stdout.write(k ? `${k.at.url} ${k.at.sha}` : "");
  }
}
