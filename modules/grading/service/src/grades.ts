// Graded done (wave 1): a delegated task's rubric and grading state, kept here in the grading module's own storage (never
// the task's editable description), and the completion gate its finish check answers for a task with a row. Moved from the
// board unchanged (lean-core 3h); the runner still claims pending rows, gathers evidence and asks the grader.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
// A criterion claiming a repository file's contents lack something is refused wherever a rubric is written: one rule, shared
// byte-identically with the task tools (services/shared/absence.ts).
import { uncheckableAbsence } from "./absence.ts";

export { uncheckableAbsence };

/**
 * open: filed with the delegation, the task not finished yet — or restarted by an amendment or a correction, with `resume` set
 * when the work was already in review and the runner must grade it now. pending: a completion path hit the gate, waiting for the
 * runner. awaiting_evidence: checks, a deploy or an approval still running. Then satisfied, needs_revision (back to the
 * assignee: only a criterion the grader shows unmet sends work back) or grading_failed (the grader failed or returned no usable
 * criteria: retried on a bounded ladder, never the owner's). Fail open: a grader that is down, can't judge or can't verify, and
 * the MAX_LOOPS-th rejected version, settle the row satisfied: the task closes done, ungraded, and its parent hears why. not_graded: the task was cancelled or otherwise closed before
 * the grader settled it, so there is nothing left to grade.
 */
export type GradeState = "open" | "pending" | "awaiting_evidence" | "satisfied" | "needs_revision" | "grading_failed" | "not_graded";
export interface Deliverable {
  kind: "pr" | "app" | "apply" | "file" | "report" | "issue";
  ref: string;
}
/** One grader verdict, bound to the exact deliverable version it graded (PR head SHA, deployed SHA, apply record). */
export interface Verdict {
  at: string;
  version: string;
  model: string;
  verdict: "satisfied" | "needs_revision" | "cannot_judge";
  criteria: { id: string; met: "yes" | "no" | "unknown"; evidence: string }[];
  /** The rubric this pass graded (rubricHash), so a verdict from a rubric since amended is never applied to the new one. */
  rubric?: string;
  /** The round the pass began on (Grade.round): a row that moved on since is a different round, and this verdict is dropped. */
  round?: number;
}
export interface Grade {
  issueId: string;
  /** 3-8 checkable criteria, each at most 200 characters; none: the template for the deliverable's kind. */
  rubric: string[];
  deliverable: Deliverable;
  /**
   * Which filing this row holds: 0 as first filed, +1 on every restart (an amendment, or a re-file that re-binds it). A verdict
   * names it with its rubric's hash, so a pass that began on an earlier filing is dropped even when the rubric later comes back
   * to the same words: the contents alone cannot tell a pass on A from a pass on B that was amended back to A.
   */
  revision: number;
  /**
   * The grading round this row is on: 0 when filed, +1 at every restart and every verdict, so a close decided on one round is
   * told apart from a later submission that left the filing (and its hash) unchanged.
   */
  round: number;
  /** Distinct deliverable versions rejected so far. */
  attempts: number;
  state: GradeState;
  verdicts: Verdict[];
  /** Failed grader passes since the last real verdict; the retry ladder starts over at 0. */
  failures: number;
  /** When the last grader pass failed (null until one does). */
  failedAt: string | null;
  /** Why the row ended not_graded (the task was cancelled or closed before the grader settled it); null otherwise. */
  closedReason: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The row was restarted by an amendment while its work was already submitted (the task in review): the state is `open`, as
   * every restart is, and this says the runner grades it now rather than waiting for another finish.
   */
  resume: boolean;
  /** When the row was resumed (see `resume`): a resumed row waits out the same completion-comment grace a held one does. */
  resumedAt: string | null;
}

interface Row {
  issue_id: string;
  rubric: string;
  deliverable: string;
  attempts: number;
  state: string;
  verdicts: string;
  failures: number;
  failed_at: string | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
  resume: number;
  resumed_at: string | null;
  revision: number;
  round: number;
}

/** Rejected versions before the grade gives up and closes the task done, ungraded (fail open: never parked on anyone). */
export const MAX_LOOPS = 3;
/** The waits after successive failed grader passes (1, 5, 15 then 60 minutes); the pass after the last wait is the 5th. */
export const GRADER_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Failed grader passes before the task closes done, ungraded; the retry ladder has one wait fewer. */
export const MAX_GRADER_FAILURES = 5;
/** How long after the `failures`-th failed pass the runner retries it. */
export const graderRetryDelay = (failures: number) => GRADER_RETRY_MS[Math.min(Math.max(failures, 1), GRADER_RETRY_MS.length) - 1]!;

/** Where a body breaks the contract: a 400 with its field. */
export class Invalid extends Error {}
/** Where a filing conflicts with the row already there (a settled row, or a filer that may not replace it): a 409. */
export class Conflict extends Error {}
const bad = (msg: string): never => { throw new Invalid(msg); };
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[], at: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${at}${k}: not allowed`); };
const str = (v: unknown, max: number, at: string, min = 0) => (typeof v === "string" && v.length >= min && v.length <= max ? v : bad(`${at}: a string of ${min}-${max} characters`));
const oneOf = <T extends string>(v: unknown, values: readonly T[], at: string): T => (values.includes(v as T) ? (v as T) : bad(`${at}: one of ${values.join(", ")}`));

export const ISSUE_REF = /^[\w.-]+\/[\w.-]+#\d+$/;
export const KINDS = ["pr", "app", "apply", "file", "report", "issue"] as const;
/** A rubric's criteria as filed or amended: 3-8, each 3-200 characters, or none where a filing allows the kind's template. */
export function parseRubric(v: unknown, { allowEmpty = true }: { allowEmpty?: boolean } = {}): string[] {
  const rubric = (Array.isArray(v) ? v : bad("rubric: a list")).map((c, i) => str(typeof c === "string" ? c.trim() : c, 200, `rubric.${i}`, 3));
  if (rubric.length > 8 || (!allowEmpty && rubric.length < 3) || (allowEmpty && rubric.length > 0 && rubric.length < 3)) bad(`rubric: 3-8 criteria${allowEmpty ? ", or none for the template" : ""}`);
  return rubric;
}
/** A delegation's rubric: 3-8 checkable criteria, or none (the grader then uses modules/grading/rubrics/<kind>.md). */
export function parseFiling(b: unknown): { issue: string; rubric: string[]; deliverable: Deliverable } {
  if (!isMap(b)) return bad("send {issue, rubric, deliverable}");
  only(b, ["issue", "rubric", "deliverable"], "");
  const rubric = parseRubric(b.rubric);
  const d = isMap(b.deliverable) ? b.deliverable : bad("deliverable: {kind, ref}");
  only(d, ["kind", "ref"], "deliverable.");
  const deliverable = { kind: oneOf(d.kind, KINDS, "deliverable.kind"), ref: d.ref === undefined ? "" : str(d.ref, 500, "deliverable.ref") };
  if (deliverable.kind === "issue" && !ISSUE_REF.test(deliverable.ref)) bad("deliverable.ref: owner/name#number for an issue");
  return { issue: str(b.issue, 100, "issue", 1), rubric, deliverable };
}
/** A rubric amendment: the task, and its full replacement rubric (the deliverable is left as filed). */
export function parseAmendment(b: unknown): { issue: string; rubric: string[] } {
  if (!isMap(b)) return bad("send {issue, rubric}");
  only(b, ["issue", "rubric"], "");
  return { issue: str(b.issue, 100, "issue", 1), rubric: parseRubric(b.rubric, { allowEmpty: false }) };
}
/**
 * A filing's identity for a grading pass: its rubric and the deliverable it was filed with. A verdict names it, so a pass that
 * began before an amendment or a re-bound deliverable is discarded rather than applied to what the row holds now: a rubric-only
 * token would let a pass on PR #1 mark PR #2's row satisfied.
 */
export const rubricHash = (rubric: string[], deliverable?: Deliverable, revision?: number) => createHash("sha256").update(JSON.stringify([rubric, deliverable ?? null, revision ?? null])).digest("hex").slice(0, 16);
const OUTCOMES = ["awaiting_evidence", "satisfied", "needs_revision", "cannot_judge", "grading_failed", "error"] as const;
export type VerdictInput = { version: string; outcome: (typeof OUTCOMES)[number]; model: string; criteria: Verdict["criteria"]; reason?: string; rubric?: string; round?: number };
/** The runner's outcome of one grading pass: still waiting on evidence, or the grader's verdict on `version` (grading_failed: the grader failed and is retried; error: evidence that never came or every model refused). */
export function parseVerdict(b: unknown): VerdictInput {
  if (!isMap(b)) return bad("send {version, outcome}");
  only(b, ["version", "outcome", "model", "criteria", "reason", "rubric", "round"], "");
  const criteria = b.criteria === undefined ? [] : Array.isArray(b.criteria) && b.criteria.length <= 8 ? b.criteria : bad("criteria: at most 8");
  return {
    reason: typeof b.reason === "string" ? b.reason.slice(0, 300) : undefined,
    rubric: b.rubric === undefined ? undefined : str(b.rubric, 32, "rubric"),
    // The round the pass began on: a non-negative integer, or none (a caller that never read the row has no round to name).
    round: b.round === undefined ? undefined : Number.isInteger(b.round) && (b.round as number) >= 0 ? (b.round as number) : bad("round: a non-negative integer"),
    version: str(b.version, 200, "version"), outcome: oneOf(b.outcome, OUTCOMES, "outcome"), model: b.model === undefined ? "" : str(b.model, 100, "model"),
    criteria: criteria.map((c, i) => { const m = isMap(c) ? c : bad(`criteria.${i}`); only(m, ["id", "met", "evidence"], `criteria.${i}.`); return { id: str(m.id, 20, `criteria.${i}.id`), met: oneOf(m.met, ["yes", "no", "unknown"] as const, `criteria.${i}.met`), evidence: str(m.evidence, 1000, `criteria.${i}.evidence`) }; }),
  };
}

/** The kernel's known repos (its codehostRepos, GET /v1/agents): the product repo, the agents orgs, github_orgs and maintainer_repos. */
export type KnownRepos = { product?: string; agentsOrgs?: string[]; orgs?: string[]; maintained?: string[] };
/** Whether a PR deliverable's ref may be filed: none (the task's own PRs), or a repo or PR the instance reaches (`KnownRepos`) or the local org (`codehost:local/<repo>[/change/<n>]`). Unknown repos refuse, as tiering does. */
export function prRefAllowed(ref: string, t: KnownRepos): boolean {
  if (!ref) return true;
  // The org `local` is this server's own (codehost-local): a repo or change request there is as much the fleet's as the agents org's.
  // Only in its explicit, canonical form (the stored ref is this exact string); a bare `local/x` would read as a GitHub owner/name.
  if (/^codehost:local\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/change\/\d+)?$/.test(ref)) return true;
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pull\/\d+|#\d+)?\/?$/.exec(ref.trim());
  if (!m) return false;
  const [org, repo] = [m[1]!.toLowerCase(), `${m[1]}/${m[2]}`.toLowerCase()];
  const lower = (l?: string[]) => (l ?? []).map((x) => x.toLowerCase());
  return [...lower(t.agentsOrgs), ...lower(t.orgs)].includes(org) || [...lower(t.maintained), ...lower(t.product ? [t.product] : [])].includes(repo);
}

const fromRow =(r: Row): Grade => ({ issueId: r.issue_id, rubric: JSON.parse(r.rubric), deliverable: JSON.parse(r.deliverable), revision: r.revision ?? 0, round: r.round ?? 0, attempts: r.attempts, state: r.state as GradeState, verdicts: JSON.parse(r.verdicts), failures: r.failures ?? 0, failedAt: r.failed_at ?? null, closedReason: r.closed_reason ?? null, createdAt: r.created_at, updatedAt: r.updated_at, resume: Boolean(r.resume), resumedAt: r.resumed_at ?? null });

export class Grades {
  private events?: { emit: (topic: string, id: string) => void };
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    // Two openers can run this at once (the service and a one-shot move): one BEGIN IMMEDIATE makes the CREATE TABLEs one
    // step, and the busy timeout waits for the other rather than failing on a locked database. The per-column ALTER checks
    // stay as they were: they run inside the same transaction, after the CREATEs, and each sees the table it just made.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS grades (
        issue_id TEXT PRIMARY KEY, rubric TEXT NOT NULL, deliverable TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, verdicts TEXT NOT NULL DEFAULT '[]', failures INTEGER NOT NULL DEFAULT 0, failed_at TEXT,
        closed_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      const columns = (db.prepare("PRAGMA table_info(grades)").all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes("failures")) db.exec("ALTER TABLE grades ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
      if (!columns.includes("failed_at")) db.exec("ALTER TABLE grades ADD COLUMN failed_at TEXT");
      if (!columns.includes("closed_reason")) db.exec("ALTER TABLE grades ADD COLUMN closed_reason TEXT");
      // A restarted row (an amendment) whose work is already submitted: the state stays `open`, as a restart is, and this
      // flag is what makes the runner grade it at once rather than wait for another finish.
      if (!columns.includes("resume")) db.exec("ALTER TABLE grades ADD COLUMN resume INTEGER NOT NULL DEFAULT 0");
      if (!columns.includes("resumed_at")) db.exec("ALTER TABLE grades ADD COLUMN resumed_at TEXT");
      // The filing this row holds, +1 on every restart: a verdict names it, so a pass on a filing that was later amended back to
      // the same words is still stale. A row written before this column existed is its first filing.
      if (!columns.includes("revision")) db.exec("ALTER TABLE grades ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
      // The round a close is bound to: +1 on every restart and every verdict. A re-filed submission keeps the filing hash but
      // starts a new round, so a close queued on the satisfied pass before it never lands on the submission after it.
      if (!columns.includes("round")) db.exec("ALTER TABLE grades ADD COLUMN round INTEGER NOT NULL DEFAULT 0");
      // Why the grader's latest pass on a task failed (the Fleet Steward reads it to tell one component down from many tasks failing).
      db.exec("CREATE TABLE IF NOT EXISTS grade_failures (issue_id TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL)");
      // Who filed each row's rubric, in its own table rather than a column on `grades`. A fresh start, not a migration: a row
      // written before this table existed has no record and is treated as such by file() below.
      db.exec("CREATE TABLE IF NOT EXISTS grade_filers (issue_id TEXT PRIMARY KEY, filer TEXT NOT NULL)");
      // The retired `escalated` state (2026-11-22): such a row's last verdict sent the work back, so it is needs_revision, and
      // its assignee finishing again grades it afresh. Idempotent.
      db.exec("UPDATE grades SET state = 'needs_revision' WHERE state = 'escalated'");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A failed grader pass's reason, kept until a later pass on the task gets any other outcome. */
  noteFailure(issueId: string, reason: string, at = new Date().toISOString()) { this.db.prepare("INSERT OR REPLACE INTO grade_failures (issue_id, at, reason) VALUES (?, ?, ?)").run(issueId, at, reason.slice(0, 300)); }
  clearFailure(issueId: string) { this.db.prepare("DELETE FROM grade_failures WHERE issue_id = ?").run(issueId); }
  failuresSince(at: string): { task: string; at: string; reason: string }[] { return this.db.prepare("SELECT issue_id AS task, at, reason FROM grade_failures WHERE at >= ? ORDER BY at DESC LIMIT 200").all(at) as { task: string; at: string; reason: string }[]; }

  get(issueId: string): Grade | undefined {
    const r = this.db.prepare("SELECT * FROM grades WHERE issue_id = ?").get(issueId) as Row | undefined;
    return r && fromRow(r);
  }

  /**
   * Files a delegation's rubric, or replaces it while the grade is unsettled. `filer` is the caller as the row records it:
   * `agent:<id>` from the agent route, `module:<name>` from the kernel's module route (grades.test / settle.test write direct).
   *
   * A byte-identical filing is a retry: the stored row comes back and nothing is written. A filing that differs (another
   * deliverable kind or ref, or another rubric) replaces both and restarts the row: open, no attempts, no verdicts, no close
   * reason. Only the row's recorded filer may do that, so a delegator's correction lands on the task
   * it already filed instead of needing a new task.
   *
   * A row with no filer record was filed before `grade_filers` existed, and it is deliberately not adopted, backfilled or
   * upgraded: the product takes fresh starts over migrating old data unless the owner asks for a migration. Such a row
   * still refuses a differing filing, and the work is filed as a new task instead. A satisfied or not_graded row is
   * settled and keeps refusing a differing filing.
   *
   * `closed` is the caller's read of the task's own status (done or cancelled). A closed task's rubric is never replaced,
   * even while its row is still `open` and the five-minute sweep has not settled it yet: the row would restart and grade
   * work the owner has already closed or cancelled. A byte-identical filing is still a retry that touches nothing.
   */
  file(issueId: string, rubric: string[], deliverable: Deliverable, filer?: string, { closed = false, held = false }: { closed?: boolean; held?: boolean } = {}): { created: boolean; grade: Grade } {
    // An absence claim a diff can't show is refused on every write path, the kernel's module route included (fileForModule
    // lands here): one rule for what a rubric may say, wherever it is filed.
    const absent = uncheckableAbsence(rubric, deliverable.kind);
    if (absent) throw new Invalid(`rubric: "${absent.slice(0, 120)}" claims repository file contents are absent, which the grader can't see: it is given the diff, not the resulting files, so no diff can show a token is gone from a whole file. Name a diff-decidable alternative instead (e.g. "the diff removes every \`Linus\` line from docs/a.md").`);
    // One transaction over the read and the write: two filings of one task can't both see no row and both insert, and a
    // check that refuses rolls back without touching anything.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const have = this.get(issueId);
      const want = JSON.stringify(deliverable), wantRubric = JSON.stringify(rubric);
      if (have) {
        if (JSON.stringify(have.rubric) === wantRubric && JSON.stringify(have.deliverable) === want) {
          this.db.exec("COMMIT");
          return { created: false, grade: have };
        }
        if (have.state === "satisfied" || have.state === "not_graded") throw new Conflict("this task already has another rubric");
        // Between a task closing and the sweep settling its row, the row still reads open: the task's own status decides.
        if (closed) throw new Conflict("this task is already closed: its rubric is not replaced, and a closed task's grade is left as it settled");
        const recorded = this.filer(issueId);
        if (!recorded) throw new Conflict("this task's rubric was filed before filers were recorded, so its deliverable cannot be re-bound: file the work as a new task");
        if (!filer || recorded !== filer) throw new Conflict(`only ${recorded}, which filed this task's rubric, may replace it`);
        // A task already held in review is graded against the corrected filing at once, exactly as an amendment is: the
        // assignee finished the work, and a filer's correction is not a reason to ask them to finish again.
        this.restart(issueId, wantRubric, want, { resume: held });
      } else {
        const now = new Date().toISOString();
        this.db.prepare("INSERT INTO grades (issue_id, rubric, deliverable, attempts, state, verdicts, created_at, updated_at) VALUES (?, ?, ?, 0, 'open', '[]', ?, ?)")
          .run(issueId, wantRubric, want, now, now);
        if (filer) this.db.prepare("INSERT OR REPLACE INTO grade_filers (issue_id, filer) VALUES (?, ?)").run(issueId, filer);
      }
      this.db.exec("COMMIT");
      this.events?.emit("grades", issueId);
      return { created: !have, grade: this.get(issueId)! };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Who filed this task's rubric (`agent:<id>` or `module:<name>`), or undefined for a row filed before filers were recorded. */
  filer(issueId: string): string | undefined {
    return (this.db.prepare("SELECT filer FROM grade_filers WHERE issue_id = ?").get(issueId) as { filer: string } | undefined)?.filer;
  }

  /**
   * A row restarted at a rubric (and, when re-bound, a deliverable): open, no attempts, no verdicts, no failures, no close
   * reason. The grader then checks the next finish against this list, which is the only one it reads.
   */
  private restart(issueId: string, rubric: string, deliverable?: string, { resume = false }: { resume?: boolean } = {}): void {
    const now = new Date().toISOString();
    const reset = `rubric = ?, revision = revision + 1, round = round + 1, attempts = 0, state = 'open', verdicts = '[]', failures = 0, failed_at = NULL, closed_reason = NULL, resume = ${resume ? 1 : 0}, resumed_at = ${resume ? "?" : "NULL"}, updated_at = ?`;
    // The deliverable is written only when it is re-bound (a differing re-file); an amendment leaves it as filed.
    const args = resume ? [now] : [];
    if (deliverable === undefined) this.db.prepare(`UPDATE grades SET ${reset} WHERE issue_id = ?`).run(rubric, ...args, now, issueId);
    else this.db.prepare(`UPDATE grades SET deliverable = ?, ${reset} WHERE issue_id = ?`).run(deliverable, rubric, ...args, now, issueId);
    // A restarted row has no failure worth carrying: it describes the version it replaced.
    this.db.prepare("DELETE FROM grade_failures WHERE issue_id = ?").run(issueId);
  }

  /**
   * Replaces a filed task's rubric in place while its grade is unsettled, leaving the deliverable as filed. A delegator whose
   * criterion cannot be met corrects the list the grader reads, without a new task and without the description becoming
   * writable. Only `by` may do it, and only when it is the task's delegator or the row's recorded filer (`agent:<id>` or
   * `module:<name>`). A settled row, a closed task, a row with no filer record and any other caller are refused; the row then
   * restarts exactly as a differing re-file does (attempts 0, verdicts cleared, open). A byte-identical rubric is not an
   * amendment: the row comes back untouched.
   */
  amend(issueId: string, rubric: string[], { by, delegator, closed = false, held = false }: { by: string; delegator?: string; closed?: boolean; held?: boolean }): Grade {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const have = this.get(issueId);
      if (!have) throw new Conflict("this task has no filed rubric to amend: its rubric is filed with its delegation");
      // Who may amend is checked before the no-op: an identical list is no change, but only a caller with a claim on the row
      // may ask for it, so a refusal never depends on whether the caller guessed the rubric already filed. The task's
      // delegator is enough on its own: a row filed before filers were recorded is still the delegator's to correct, and the
      // recorded filer (an agent, or the module that filed it) is the other route.
      const recorded = this.filer(issueId);
      if (!by || (by !== delegator && by !== recorded)) throw new Conflict(`only ${delegator ? `${delegator}, the task's delegator, or ` : ""}${recorded ?? "the filer recorded on this rubric"} may amend this task's rubric`);
      const absent = uncheckableAbsence(rubric, have.deliverable.kind);
      if (absent) throw new Invalid(`rubric: "${absent.slice(0, 120)}" claims repository file contents are absent, which the grader can't see: it is given the diff, not the resulting files, so no diff can show a token is gone from a whole file. Name a diff-decidable alternative instead (e.g. "the diff removes every \`Linus\` line from docs/a.md").`);
      const wantRubric = JSON.stringify(rubric);
      if (JSON.stringify(have.rubric) === wantRubric) {
        this.db.exec("COMMIT");
        return have;
      }
      if (have.state === "satisfied" || have.state === "not_graded") throw new Conflict("this task already has another rubric");
      if (closed) throw new Conflict("this task is already closed: its rubric is not replaced, and a closed task's grade is left as it settled");
      // The row restarts exactly as a differing re-file does: open, no attempts, no verdicts. Work already submitted (the task
      // in review) is graded against the new list at once: `resume` says so, because `open` alone is a row nobody finished yet
      // and the runner would wait for another finish the task no longer needs.
      this.restart(issueId, wantRubric, undefined, { resume: held });
      this.db.exec("COMMIT");
      this.events?.emit("grades", issueId);
      return this.get(issueId)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * The Fleet Steward's rebind (role fleet-settle, checked by the route): a filed task's deliverable moved to the work that
   * actually landed (a merged PR the task's own PRs didn't name), its rubric kept as filed. The row restarts as a re-file does
   * and, the work being done, is graded at once (`resume`). Any filer's row, recorded or not; a settled row or a closed task is
   * refused, and the same deliverable is no change.
   */
  rebind(issueId: string, deliverable: Deliverable, { closed = false }: { closed?: boolean } = {}): Grade {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const have = this.get(issueId);
      if (!have) throw new Conflict("this task has no filed rubric: there is no grade to rebind");
      if (have.deliverable.kind !== deliverable.kind) throw new Invalid(`deliverable.kind: this task's deliverable is a ${have.deliverable.kind}; a rebind keeps its kind`);
      if (JSON.stringify(have.deliverable) === JSON.stringify(deliverable)) {
        this.db.exec("COMMIT");
        return have;
      }
      if (have.state === "satisfied" || have.state === "not_graded") throw new Conflict(`this task's grade is settled (${have.state}): nothing to rebind`);
      if (closed) throw new Conflict("this task is already closed: its grade is left as it settled");
      this.restart(issueId, JSON.stringify(have.rubric), JSON.stringify(deliverable), { resume: true });
      this.db.exec("COMMIT");
      this.events?.emit("grades", issueId);
      return this.get(issueId)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * The rows the runner grades: a completion path hit the gate, the evidence was still coming, the grader failed (no verdict
   * yet) and its next retry is due, or an amendment restarted a row whose work was already submitted (`resume`).
   */
  due(now = Date.now()): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state IN ('pending', 'awaiting_evidence', 'grading_failed') OR (state = 'open' AND resume = 1) ORDER BY updated_at").all() as unknown as Row[])
      .map(fromRow)
      .filter((g) => g.state !== "grading_failed" || !g.failedAt || Date.parse(g.failedAt) + graderRetryDelay(g.failures) <= now);
  }

  /**
   * Every row that is not settled yet: what a task closing has to settle. One row per grade state, for a task already
   * `done` or `cancelled`:
   *
   * open             settles: the delegation was never finished, so nothing is left to grade or to claim.
   * pending          settles: the gate was waiting for a runner that will never be asked again.
   * awaiting_evidence settles: the evidence will not be read for a closed task.
   * needs_revision   settles: there is nothing left to revise.
   * grading_failed   settles: the retry ladder has no task to retry.
   * satisfied        never swept: a real verdict stands, and a settled row keeps its `satisfied` (the close did not undo it).
   * not_graded       never swept: already terminal, and the first reason is kept.
   *
   * So the sweep takes everything except the two settled states, which is what the query says. It reads each task's status
   * first, so a task still open keeps its row whatever its state.
   */
  unsettled(): Grade[] {
    return (this.db.prepare("SELECT * FROM grades WHERE state NOT IN ('satisfied', 'not_graded') ORDER BY updated_at").all() as unknown as Row[]).map(fromRow);
  }

  /**
   * The task closed before the grader settled its row (cancelled, or done another way): there is nothing left to grade, so
   * the row ends `not_graded` with the reason. A satisfied row keeps its verdict; a row already settled keeps its first
   * reason. Called wherever a close is seen, and by the detector for a close it wasn't (a cancel in Paperclip itself).
   */
  settle(issueId: string, reason: string, now = Date.now()): Grade | undefined {
    const g = this.get(issueId);
    if (!g || g.state === "satisfied" || g.state === "not_graded") return g;
    // A row closed this way is no longer the restarted one the runner had to pick up: its resume ends with it.
    this.db.prepare("UPDATE grades SET state = 'not_graded', closed_reason = ?, resume = 0, resumed_at = NULL, updated_at = ? WHERE issue_id = ?").run(reason.slice(0, 300), new Date(now).toISOString(), issueId);
    this.events?.emit("grades", issueId);
    return this.get(issueId);
  }

  private set(issueId: string, state: GradeState, attempts: number, verdicts: Verdict[], failures: number, failedAt: string | null, now = Date.now()): Grade {
    this.db
      // A pass settling the row ends the amendment's resume: the row is no longer the restarted one the runner had to pick up.
      // Every verdict starts a new round: a close decided on the round before it is stale, even when the filing's words and
      // hash are the same (a re-filed submission is graded again, and its close must be its own).
      .prepare("UPDATE grades SET state = ?, round = round + 1, attempts = ?, verdicts = ?, failures = ?, failed_at = ?, closed_reason = NULL, resume = 0, resumed_at = NULL, updated_at = ? WHERE issue_id = ?")
      .run(state, attempts, JSON.stringify(verdicts), failures, failedAt, new Date(now).toISOString(), issueId);
    this.events?.emit("grades", issueId);
    return this.get(issueId)!;
  }

  /** Waiting for the grader again (the completion gate). */
  pend(issueId: string): void {
    const g = this.get(issueId)!;
    this.set(issueId, "pending", g.attempts, g.verdicts, g.failures, g.failedAt);
  }

  /**
   * One grading pass's outcome. Only a criterion the grader shows unmet (`met: "no"`) sends the work back to its assignee
   * (needs_revision); each distinct rejected version counts once, and the MAX_LOOPS-th, or a rejected version handed in again
   * unchanged, settles the row satisfied, so the task closes done,
   * ungraded, with the unmet criteria in the note. Anything else that isn't still waiting settles it satisfied too: a verdict
   * with nothing shown unmet (unverified, cannot_judge, evidence that never came). A grader that failed or returned no usable
   * criteria (grading_failed) is retried on the 1-5-15-60 minute ladder and settles the same way after MAX_GRADER_FAILURES passes
   * in a row; any real verdict, or a new round, clears that count.
   */
  record(issueId: string, v: VerdictInput, now = Date.now()): Grade {
    const set = (state: GradeState, attempts: number, verdicts: Verdict[], failures: number, failedAt: string | null) => this.set(issueId, state, attempts, verdicts, failures, failedAt, now);
    const g = this.get(issueId);
    if (!g) throw new Error("no grade for this task");
    // A verdict computed on a filing since replaced (its rubric amended, or its deliverable re-bound) is stale: applying it
    // would grade the new filing by the old, spend an attempt on it, or park the row as awaiting evidence for work that is no
    // longer the one asked for. Every outcome is dropped alike, leaving the row as it is (open), so the next pass grades what
    // the row now holds. A verdict naming no filing at all is dropped the same way: nothing shows it read what the row holds,
    // and an unnamed wait would park an amended row for work it never looked at.
    // The pass read this round when it began. A re-file, an amendment or a submission that moved the row on since then is a
    // different round, and this verdict graded the one before it: applying it would settle or park work nobody asked about.
    if (v.round !== undefined && Number(v.round) !== g.round) return g;
    const current = rubricHash(g.rubric, g.deliverable, g.revision);
    if (v.rubric !== current) return g;
    if (v.outcome === "awaiting_evidence") return set("awaiting_evidence", g.attempts, g.verdicts, g.failures, g.failedAt);
    const unmet = v.criteria.some((c) => c.met === "no");
    const verdict: Verdict = { at: new Date(now).toISOString(), version: v.version, model: v.model, verdict: unmet ? "needs_revision" : v.outcome === "satisfied" ? "satisfied" : "cannot_judge", criteria: v.criteria, rubric: current };
    const verdicts = [...g.verdicts, verdict].slice(-20);
    if (v.outcome === "grading_failed" && !unmet) {
      const failures = g.failures + 1;
      if (failures >= MAX_GRADER_FAILURES) return set("satisfied", g.attempts, verdicts, 0, null);
      return set("grading_failed", g.attempts, verdicts, failures, new Date(now).toISOString());
    }
    if (!unmet) return set("satisfied", g.attempts, verdicts, 0, null);
    // A version rejected before and handed in again unchanged spends no attempt, and sending it back once more would change
    // nothing: it closes ungraded at once.
    if (g.verdicts.some((x) => x.verdict === "needs_revision" && x.version === v.version)) return set("satisfied", g.attempts, verdicts, 0, null);
    const attempts = g.attempts + 1;
    return set(attempts >= MAX_LOOPS ? "satisfied" : "needs_revision", attempts, verdicts, 0, null);
  }
}

/**
 * Whether a board-side cascade (closing a task's crew parts when the task closes) may close one done: an ungraded task
 * passes, and so does one whose grade is satisfied. Anything else waits for the grader, so a cascade never satisfies a
 * rubric by itself.
 */
export function gradePassed(grades: Grades, issueId: string): boolean {
  const g = grades.get(issueId);
  return !g || g.state === "satisfied";
}

/**
 * A task closed before the grader settled its row has nothing left to grade: settle each such row `not_graded`, with the
 * close as the reason. Runs on the board's timer and in the detector's check, so a close made anywhere (the board, the tasks
 * bridge, Paperclip itself) resolves the row; a row whose task can't be read is left alone.
 */
export async function settleClosedGrades(grades: Grades, issue: (id: string) => Promise<{ status: string } | undefined>, now = Date.now()): Promise<Grade[]> {
  const settled: Grade[] = [];
  for (const g of grades.unsettled()) {
    const i = await Promise.resolve()
      .then(() => issue(g.issueId))
      .catch(() => undefined);
    if (!i) continue;
    if (i.status !== "done" && i.status !== "cancelled") continue;
    const row = grades.settle(g.issueId, `the task was ${i.status} before the grader settled it`, now);
    if (row) settled.push(row);
  }
  return settled;
}

/** A held task's scheduled check sits at the runner's evidence deadline, well past a normal grader pass. */
export const GRADE_CHECK_MS = 24 * 60 * 60_000;
/** Every way a task reaches done: the tasks bridge's task_finish, the runner's finishTurn and finishMerges. */
export type CompletionPath = "task_finish" | "finish_turn" | "finish_merges";
/**
 * pass: the path may close the task as it would have. Otherwise the task goes to in_review with the `grading` label and the
 * row has this state (grading_failed: the runner retries it).
 */
export type GateResult = { pass: true } | { pass: false; state: "pending" | "awaiting_evidence" | "needs_revision" | "grading_failed"; label: "grading" };

/**
 * The completion gate, idempotent. A task without a rubric passes, and so does a satisfied one
 * that is already done (another path closing it again). Satisfied is not sticky: a satisfied task reopened and finished
 * again is graded again (each verdict is bound to its deliverable version).
 */
export function completionGate(grades: Grades, issueId: string, _via: CompletionPath, { done = false }: { done?: boolean } = {}): GateResult {
  const g = grades.get(issueId);
  // Settled rows: satisfied (graded) and not_graded (closed before the grader settled it) pass a task that is already done.
  if (!g || (done && (g.state === "satisfied" || g.state === "not_graded"))) return { pass: true };
  if (g.state === "pending" || g.state === "awaiting_evidence" || g.state === "grading_failed") return { pass: false, state: g.state, label: "grading" };
  if (g.state === "needs_revision") {
    // Unmet criteria are never a close: wait for the runner to grade a new deliverable version.
    grades.pend(issueId);
    return { pass: false, state: "needs_revision", label: "grading" };
  }
  grades.pend(issueId);
  return { pass: false, state: "pending", label: "grading" };
}

/**
 * What the AI reviewer reads of a task's grade (POST /check/grade, the kernel's own call): the latest verdict, only when it sent
 * the work back with a criterion not shown met. Each criterion is its rubric number and code's met; an unmet one carries the
 * rubric's own text (the delegating agent's words when it filed the task, or the kind's template). Never the grader's evidence:
 * that is model output over what the PR itself wrote.
 */
export type GraderNote = { attempt: number; at: string; version: string; criteria: { id: string; met: "yes" | "no" | "unknown"; rubric?: string }[] };
export function graderNote(g: Grade | undefined, template: (kind: string) => string[]): GraderNote | null {
  const v = g?.verdicts.at(-1);
  if (!g || v?.verdict !== "needs_revision") return null;
  const rubric = g.rubric.length ? g.rubric : template(g.deliverable.kind);
  // The grader numbers the rubric 1..N; any other id is not a criterion of this rubric.
  const criteria = v.criteria.filter((c) => /^[1-9]\d?$/.test(c.id) && Number(c.id) <= rubric.length)
    .map((c) => ({ id: c.id, met: c.met, ...(c.met === "yes" ? {} : { rubric: rubric[Number(c.id) - 1]! }) }));
  if (!criteria.some((c) => c.met !== "yes")) return null;
  return { attempt: g.attempts, at: v.at, version: v.version, criteria };
}
