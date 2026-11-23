// K5, the tier formula (spec §5.1) and the generic tier rules every requester shares: every term raises, none lowers. Tier 0
// runs at once (still a record), Tier 1 is the AI reviewer's, Tier 2 the owner's. The AI reviewer blocks only malice and fails
// open (owner, 2026-11-22: "AI agents we use are trusted, not threat actors"): no write reaches the owner on its merits. The
// owner decides only what he chose himself: his own veto on a task, his signed-in settings save, and autonomy off (the
// instance's, or a routine's). The requesters' own rules (which repo, file or module change needs a review) stay with them: a
// module's executor plan (the code host's plan.ts) and the kernel's apply planner propose a raise. Pure.
import { createHash } from "node:crypto";

export type Tier = 0 | 1 | 2;
export type Autonomy = "off" | "tier0" | "full";
/** A requester's raise: any raise means the AI reviewer reads it (a Tier 2 raise is Tier 1 now: the reviewer decides). */
export type Raise = { tier: 1 | 2; reason?: string; rule?: string };
/** The cap a write was tiered under, kept on its record: the instance's autonomy off, or a routine's (`routine`: its id; absent when the trace couldn't be read). */
export type Cap = { by: "autonomy" | "routine"; value: Autonomy; routine?: string };
/** A task's routine cap, as the kernel traces it (taskRoutineCap). */
export type RoutineCap = { cap: Autonomy; routine?: string };
/** One part of a request's tier, as the requesters' rules build it. */
export type Part = { tier: number; rule?: string; reason?: string; reject?: boolean; [k: string]: unknown };
/** A model's verdict, or code's in its place. */
export type Verdict = { decision: "approve" | "reject" | "escalate"; reason: string; model: string; code?: string };

/** What a cap says, for a card's reason and the reviewer's label. */
export const capText = (c: Cap) => (c.by === "autonomy" ? `autonomy is ${c.value}` : c.routine ? `a routine's run (${c.routine}) started this task and its autonomy is ${c.value}` : "the task's routine trace couldn't be read, so it counts as a routine set to off");

/**
 * The one tier function every write goes through (writes.ts: module kinds, conn.tool, the runner's kinds). The merit tier is
 * the highest of the floors and raises: 0 runs at once, anything higher is the AI reviewer's (Tier 1). The owner's (Tier 2)
 * only: his veto on the task (`priorVeto`), his own settings save (`ownerSave`, settings-change.ts: his Save is his approval,
 * decided as his account at filing), and an autonomy of off (the instance's, or a routine's: `routine`; an unreadable trace is
 * off; rule autonomy-off or routine-autonomy). A routine's tier0 is kept on the record as its `cap`: the review shadows the
 * reviewer's verdict for the owner then, as the instance's tier0 does.
 */
export function computeTier({ floor, instanceFloor = 0, raise, checkRaises = [], priorVeto = false, autonomy, routine, uncapped = false, ownerSave = false }: {
  floor: Tier; instanceFloor?: Tier; raise?: Raise; checkRaises?: Raise[]; priorVeto?: boolean; autonomy?: Autonomy; routine?: RoutineCap;
  /** The release updater's own filing (records.ts isUpdater): it acts on an owner setting's standing authority (auto_update), so the caps don't hold it. Every other requester is capped. */
  uncapped?: boolean;
  ownerSave?: boolean;
}): { tier: Tier; merit: Tier; cap?: Cap; rule?: string; state: "claimed" | "review" | "owner" } {
  if (uncapped) { autonomy = undefined; routine = undefined; }
  const merit = Math.max(floor, instanceFloor, ...[...(raise ? [raise] : []), ...checkRaises].map((r) => r.tier)) as Tier;
  if (ownerSave || priorVeto) return { tier: 2, merit, state: "owner" };
  // The caps that hold, the routine's first (its label names it when both do).
  const caps = [routine && routine.cap !== "full" ? { by: "routine", value: routine.cap, ...(routine.routine ? { routine: routine.routine } : {}) } : undefined, autonomy === "off" ? { by: "autonomy", value: "off" } : undefined].filter(Boolean) as Cap[];
  const off = caps.find((c) => c.value === "off");
  if (off) return { tier: 2, merit, cap: off, rule: off.by === "autonomy" ? "autonomy-off" : "routine-autonomy", state: "owner" };
  if (merit === 0) return { tier: 0, merit, state: "claimed" };
  return { tier: 1, merit, ...(caps[0] ? { cap: caps[0] } : {}), state: "review" };
}

export const T = (tier: number, rule: string, reason: string): Part => ({ tier, rule, reason });
export const REJECT = (rule: string, reason: string): Part => ({ tier: 2, rule, reason, reject: true });

/** The highest part (a reject beats everything); no parts is Tier 2 (the reviewer reads it). */
export function highest(parts: Part[]): Part {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  return parts.find((p) => p.reject) ?? parts.reduce((a, b) => (b.tier > a.tier ? b : a));
}

/** A routine's `autonomy` values, strictest first (the instance setting's names). */
export const AUTONOMY: Autonomy[] = ["off", "tier0", "full"];
/**
 * The cap on a task from the routines its work came from. `origins`: the task and every issue it traces back to, as the
 * control plane returns them: its parents, and so on, up to a routine's execution task. A task a job created carries its
 * job's cap in kernel provenance (`recorded`), so an unparented task a routine's job created keeps the cap. `complete`: the trace finished; `routines`: the grants table's {<routine id>: autonomy}. The strictest routine found
 * wins (`routine`: its id). `recorded`: the caps kernel provenance holds for issues on the trace. Fails closed: a routine the table doesn't know, or an invalid value, is "off" (setup writes each
 * routine's autonomy into the table before it adds the routine's triggers), and so is a trace that didn't finish (no
 * `routine` then). None found is no cap.
 */
export function routineCap(origins: ({ originKind?: string; originId?: string } | null | undefined)[], complete: boolean, routines: Record<string, string> | null = {}, recorded: RoutineCap[] = []): RoutineCap | undefined {
  const of = (r: string): Autonomy => (AUTONOMY.includes((routines ?? {})[r] as Autonomy) ? ((routines ?? {})[r] as Autonomy) : "off");
  const caps: RoutineCap[] = origins.filter((i) => i?.originKind === "routine_execution").map((run) => ({ cap: of(run!.originId!), routine: run!.originId! }));
  // Kernel provenance (provenance.ts): the cap a creating job carried, and its routine's cap now if that is stricter.
  for (const r of recorded) caps.push(r, ...(r.routine ? [{ cap: of(r.routine), routine: r.routine }] : []));
  if (!complete) caps.push({ cap: "off" });
  return caps.reduce<RoutineCap | undefined>((a, b) => (!a || AUTONOMY.indexOf(b.cap) < AUTONOMY.indexOf(a.cap) ? b : a), undefined);
}

const ORIGIN_MAX = 24;
/**
 * Every issue a task traces back to, for its routine cap (routineCap): its parents, then theirs, with kernel provenance for
 * each (the cap the job that created it carried). So a parent the agent picked, or none, can't shed a routine's cap. Past
 * ORIGIN_MAX issues the trace is incomplete (the cap is then the strictest).
 */
export async function origins(pc: Trace, full: any): Promise<{ issues: any[]; complete: boolean; recorded: RoutineCap[] }> {
  const seen = new Map<string, any>();
  const recorded: RoutineCap[] = [];
  const queue: any[] = [full];
  while (queue.length) {
    const i = queue.shift();
    if (!i || seen.has(i.id)) continue;
    if (seen.size >= ORIGIN_MAX) return { issues: [...seen.values()], complete: false, recorded };
    seen.set(i.id, i);
    // Every issue on the trace, not only the task: a child of a job-created task carries that job's cap.
    const p = pc.provenance(i);
    if (p) recorded.push(p);
    if (i.parentId) queue.push(await pc.issue(i.parentId));
  }
  return { issues: [...seen.values()], complete: true, recorded };
}
/** What the routine trace reads: the control plane's issues, and kernel provenance for an issue (provenance.ts trace: its row's cap, "off" for a plugin-made task with no row). */
export type Trace = { issue(id: string): Promise<any>; provenance(issue: any): RoutineCap | undefined };
/**
 * A task's routine cap: kernel provenance first, then the control plane. An issue on the trace that is gone (a 404) leaves it
 * incomplete: "off". A read that fails otherwise (a 5xx, a timeout, unreachable) throws (503): a blip is never a stricter cap
 * frozen or tiered on, the caller tries again.
 */
export const taskRoutineCap = (pc: Trace, task: string, routines: Record<string, string> | null = {}): Promise<RoutineCap | undefined> =>
  pc.issue(task).then((full) => (full?.id ? origins(pc, full) : { issues: [], complete: false, recorded: [] })).then(({ issues, complete, recorded }) => routineCap(issues, complete, routines, recorded), (e: { status?: number; message?: string }) => {
    if (e?.status === 404) return routineCap([], false, routines);
    throw Object.assign(new Error(`the routine trace couldn't be read now (${String(e?.message ?? e).slice(0, 200)})`), { status: 503, type: "trace_unavailable" });
  });

// ------------------------------------------------------------------ earlier decisions on a task

/** A task's approval record as tiering reads it. */
export type Prior = { id?: string; action: string; args?: any; state: string; decidedBy?: string | null; decidedAt?: string | null; reviewCode?: string | null; review?: string | null; digest?: string };
/** The reviewer's reason codes that name malice: the rejections the reviewer posts as malicious (work.ts reads them too). */
export const MALICE = ["malicious", "secret_exfiltration", "prompt_injection"];
/** The actions a record carries: a product PR card with `args.merge` is also a merge, so neither dodges the other's no. */
const carried = (r: Prior) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
const keyOf = (list: unknown[]) => (list.length && list.every((x) => typeof x === "string" && /^[0-9a-f]{7,64}$/i.test(x)) ? (list as string[]).map((x) => x.toLowerCase()).sort().join(",") : undefined);
/**
 * What a request changes, as a key two requests share only when their content is identical: the commits (push, PR), the
 * PR heads (merge), the fleet commit (apply), a module kind's or tool call's digest. Never a branch name or PR number.
 */
export function requestKey(action: string, s: any): string | undefined {
  if (action === "push" || action === "pr") return keyOf((s.branches ?? s.only ?? []).map((b: any) => b.sha));
  if (action === "merge") return keyOf((s.prs ?? []).map((p: any) => p.head));
  if (action === "apply") return s.sha ? `apply:${s.sha}` : undefined;
  if (action === "create_repo") return s.repo ? `create_repo:${String(s.repo).toLowerCase()}` : undefined;
  return s.digest ? `digest:${s.digest}` : undefined;
}
/** The same key for an approval record (its args; a module kind's digest is its content). */
export const recordKey = (r: Prior) => requestKey(r.action, { ...(r.args ?? {}), only: r.args?.only ?? [], prs: r.args?.prs ?? [], digest: r.digest });
/** The owner's own decision (not the reviewer's, code's or a stale close). */
const byOwner = (r: Prior) => Boolean(r.decidedBy) && !/^(reviewer|auto|stale):/.test(r.decidedBy!);

/**
 * Earlier decisions on a task for a request, from its decided records of the action:
 * - ownerVeto: the owner's latest decision on it was a no (their later yes withdraws that), or the owner rejected exactly
 *   this content and hasn't approved that same content since.
 */
export function priorDecisions(records: Prior[], action: string, key?: string) {
  const mine = (records ?? []).filter((r) => ["approved", "used", "expired", "rejected"].includes(r.state) && Boolean(r.decidedBy) && carried(r).includes(action)).sort((a, b) => String(a.decidedAt ?? "").localeCompare(String(b.decidedAt ?? "")));
  const sameContent = (r: Prior) => key !== undefined && recordKey(r) === key;
  const approvedLater = (r: Prior, who: (y: Prior) => boolean = () => true) => mine.some((y) => who(y) && y.state !== "rejected" && sameContent(y) && String(y.decidedAt) > String(r.decidedAt));
  const ownerNo = mine.some((r) => byOwner(r) && r.state === "rejected" && sameContent(r) && !approvedLater(r, byOwner));
  return { ownerVeto: mine.filter(byOwner).at(-1)?.state === "rejected" || ownerNo };
}

/** What earlier decisions do to a request: the owner's veto (his card). Only the owner's no binds; a reviewer's reject never does. */
export function priorPart(p: ReturnType<typeof priorDecisions> | undefined): Part | undefined {
  if (!p) return undefined;
  if (p.ownerVeto) return T(2, "owner-veto", "the owner rejected this action on this task, and only their own yes lifts it");
  return undefined;
}

// ------------------------------------------------------------------ the reviewer's verdict on a record

/** A failed review (the reviewer unreachable, failing or slow) is tried once more after this wait, then approved (fail open). */
export const RETRY_MS = 60_000;
/** The wait before try `n` (1-based) of an approved record's pre-run reads, never more than 15 minutes. */
export const RETRY_CAP_MS = 15 * 60_000;
export const retryWait = (n: number) => Math.min(60_000 * 2 ** (n - 1), RETRY_CAP_MS);
/**
 * The owner's own autonomy below full (the instance's tier0, or a routine's cap on the record): the reviewer only comments, so
 * its verdict goes to the owner as a note.
 */
export const shadowed = (v: Verdict, mode: Autonomy): Verdict =>
  mode === "full" || v.decision === "escalate" ? v : { ...v, decision: "escalate", code: "shadow", reason: `Shadow (autonomy: ${mode}): the reviewer would ${v.decision} this. ${v.reason}` };
