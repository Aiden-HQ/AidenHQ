// K5, the tier formula (spec §5.1) and the generic tier rules every requester shares: every term raises, none lowers. Tier 0
// runs at once (still a record), Tier 1 is the reviewer's, Tier 2 the owner's. A record headed for the reviewer carries how
// the owner follows it (`reviewFirst`): null, the reviewer decides; "final", its approve goes on to the owner and its reject
// is final; "owner", Tier 2 on its merits, every verdict goes on to the owner (code's own refusals aside). Pure.
// The requesters' own rules (which repo, file or module change is which tier) stay with them: a module's executor plan
// (the code host's plan.ts) and the kernel's apply planner propose a raise. The kernel tiers every write with computeTier: floors,
// raises, the owner's veto, then the caps (the instance's autonomy off, a routine's). What else they share is here:
// combining parts, earlier decisions on a task, and what a review-first record does with the reviewer's verdict.
import { createHash } from "node:crypto";

export type Tier = 0 | 1 | 2;
export type Autonomy = "off" | "tier0" | "full";
export type ReviewFirst = "final" | "owner";
/**
 * `ownerOnly`: the owner's own authority, Tier 2 under every autonomy: loosening autonomy, raising spend, new authority from a
 * module that isn't official. Every other Tier 2 raise is the panel's under full autonomy (computeTier).
 */
export type Raise = { tier: 1 | 2; panel?: boolean; reason?: string; rule?: string; ownerOnly?: boolean };
/** The cap a write was tiered under, kept on its record: the instance's autonomy off, or a routine's (`routine`: its id; absent when the trace couldn't be read). */
export type Cap = { by: "autonomy" | "routine"; value: Autonomy; routine?: string };
/** A task's routine cap, as the kernel traces it (taskRoutineCap). */
export type RoutineCap = { cap: Autonomy; routine?: string };
/** One part of a request's tier, as the requesters' rules build it. */
export type Part = { tier: number; rule?: string; reason?: string; panel?: boolean; reject?: boolean; reviewFirst?: boolean; byMerit?: boolean; ownerOnly?: boolean; cap?: Cap | null; [k: string]: unknown };
/** A model's verdict, or code's in its place. */
/** `second_unsure`: an approval whose other reviewer was unsure (owner, 2026-11-20): recorded apart from `second`, which only ever names a second approval. */
export type Verdict = { decision: "approve" | "reject" | "escalate"; reason: string; model: string; second?: string; second_unsure?: string; whole?: boolean; code?: string };

/** What a cap says, for a card's reason and the reviewer's label. */
export const capText = (c: Cap) => (c.by === "autonomy" ? `autonomy is ${c.value}` : c.routine ? `a routine's run (${c.routine}) started this task and its autonomy is ${c.value}` : "the task's routine trace couldn't be read, so it counts as a routine set to off");

/**
 * The one tier function every write goes through (writes.ts: module kinds, conn.tool, the runner's kinds). The merit tier
 * is the highest of the floors, raises and the owner's veto. Under full autonomy (and no routine cap) the owner approves
 * only their own authority: a raise marked `ownerOnly` (loosening autonomy, raising spend, new authority from a module that
 * isn't official, an owner path: a supply-chain source exception), a kind's own floor (kernel.raise_cap) and their veto; any other Tier 2 raise is Tier 1 for the panel
 * (owner, 2026-11-19: "full autonomy mode should not bug me for approval almost ever"). A Tier 2 merit is reviewed first and the owner's
 * (`reviewFirst`, "owner" unless the requester says how: "final" for new module authority, null for the owner's tap alone).
 * Then the caps: the instance's autonomy off, or a routine's tier0 or off (`routine`; an unreadable trace is off). off lifts
 * Tier 0 to the owner's tap (rule autonomy-off or routine-autonomy) and makes Tier 1 review-first (the reviewer's reject is
 * final, its approve goes on to the owner); a routine's tier0 does the latter only. The instance's tier0 isn't a cap here:
 * it shadows the reviewer's verdict at review. `cap`: the cap that changed the tier, for the record.
 * `ownerSave`: the owner's own settings change from a signed-in board session (settings-change.ts, verified by the kernel):
 * his Save is his approval, so the record is his (Tier 2, no reviewer) and the kernel decides it as his account at filing.
 */
export function computeTier({ floor, instanceFloor = 0, raise, checkRaises = [], priorVeto = false, reviewFirst = "owner", autonomy, routine, panel = false, uncapped = false, ownerSave = false }: {
  floor: Tier; instanceFloor?: Tier; raise?: Raise; checkRaises?: Raise[]; priorVeto?: boolean; reviewFirst?: ReviewFirst | null; autonomy?: Autonomy; routine?: RoutineCap; panel?: boolean;
  /** The release updater's own filing (records.ts isUpdater): it acts on an owner setting's standing authority (auto_update), so the caps don't hold it. Every other requester is capped. */
  uncapped?: boolean;
  ownerSave?: boolean;
}): { tier: Tier; merit: Tier; panel: boolean; reviewFirst: ReviewFirst | null; cap?: Cap; rule?: string; state: "claimed" | "review" | "owner" } {
  const full = autonomy === "full" && (!routine || routine.cap === "full");
  if (uncapped) { autonomy = undefined; routine = undefined; }
  const raises = [...(raise ? [raise] : []), ...checkRaises];
  const relaxed = full && raises.some((r) => r.tier === 2 && !r.ownerOnly);
  const merit = Math.max(floor, instanceFloor, ...raises.map((r) => (full && r.tier === 2 && !r.ownerOnly ? 1 : r.tier)), priorVeto ? 2 : 0) as Tier;
  if (ownerSave) return { tier: 2, merit, panel: false, reviewFirst: null, state: "owner" };
  // The caps that hold, the routine's first (its label names it when both do).
  const caps = [routine && routine.cap !== "full" ? { by: "routine", value: routine.cap, ...(routine.routine ? { routine: routine.routine } : {}) } : undefined, autonomy === "off" ? { by: "autonomy", value: "off" } : undefined].filter(Boolean) as Cap[];
  const off = caps.find((c) => c.value === "off");
  const out = { panel: panel || relaxed || raises.some((r) => r.panel === true) };
  if (merit === 2) return { ...out, tier: 2, merit, reviewFirst: priorVeto ? "owner" : reviewFirst, state: priorVeto || reviewFirst ? "review" : "owner" };
  if (merit === 1 && caps[0]) return { ...out, tier: 2, merit, reviewFirst: "final", cap: caps[0], state: "review" };
  if (merit === 0 && off) return { ...out, tier: 2, merit, reviewFirst: null, cap: off, rule: off.by === "autonomy" ? "autonomy-off" : "routine-autonomy", state: "owner" };
  return { ...out, tier: merit, merit, reviewFirst: null, state: merit === 0 ? "claimed" : "review" };
}

export const T = (tier: number, rule: string, reason: string): Part => ({ tier, rule, reason });
export const REJECT = (rule: string, reason: string): Part => ({ tier: 2, rule, reason, reject: true });
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

const rank = (p: Part) => p.tier * 4 + (p.ownerOnly ? 2 : 0) + (p.panel ? 1 : 0);
/**
 * The highest part (a reject beats everything; at Tier 2 the owner's own authority (`ownerOnly`) beats the rest, so a mixed
 * request keeps it; Tier 1 with the panel beats plain Tier 1); no parts is Tier 2.
 */
export function highest(parts: Part[]): Part {
  if (!parts.length) return T(2, "unrecognised", "nothing recognised in the request");
  const top = parts.find((p) => p.reject) ?? parts.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  // A module change is always reviewed first, whatever else the request carries; the review is a panel if any part is. A
  // part that is the owner's on its merits keeps the reviewer's reject from being final.
  if (!top.reject && top.tier === 2 && parts.some((p) => p.reviewFirst)) return { ...top, reviewFirst: true, ...(parts.some((p) => p.panel) ? { panel: true } : {}), ...(parts.some((p) => p.tier === 2 && (p.byMerit || !p.reviewFirst)) ? { byMerit: true } : {}) };
  return top;
}

/**
 * Tier 2 on its merits (the owner's veto, a spend-cap raise, an owner-approval record, unknown repos, nothing recognised):
 * the owner's tap decides, but the AI reviewer reads it first (owner, 2026-11-16: every write is reviewed before it reaches
 * the owner). Its approve and its reject both go on to the owner with the verdict on the card (`byMerit`).
 */
export const meritOwner = (t: Part): Part => (!t.reject && t.tier === 2 && !t.reviewFirst ? { ...t, reviewFirst: true, byMerit: true } : t);

/** Code's own refusals that stay final on any card: the change moved, or code refused it (a closed task, a rejected copy). */
export const FINAL_CODES = ["stale_head", "refused_by_code"];

/**
 * What a review-first card posts after the reviewer: an approve goes to the owner with the verdict on the card; a reject is
 * final (new module authority, autonomy off, a routine's cap: Tier 1 semantics), except on a card that is the owner's on its
 * merits (`byMerit`), where every verdict but code's own refusals goes on to the owner with the reject shown. An escalate
 * stays one. Any other card posts the verdict as it is.
 */
export function afterReview(input: Part, v: Verdict): Verdict {
  if (!input?.reviewFirst) return v;
  const by = `${v.model}${v.second ? ` and ${v.second}` : ""}`;
  if (input.byMerit && v.decision === "reject" && !FINAL_CODES.includes(v.code ?? "")) return { ...v, decision: "escalate", code: "owner_tier", reason: `The AI reviewer rejected (${by}${v.code ? `, ${v.code}` : ""}): ${v.reason} It is Tier 2 on its merits, so the owner decides: ${input.reason}` };
  if (v.decision !== "approve") return v;
  const [code, why] = input.byMerit ? ["owner_tier", "It is Tier 2 on its merits"] : input.cap?.by === "routine" ? ["routine_autonomy", `A routine's autonomy is ${input.cap.value}`] : input.cap?.by === "autonomy" ? ["autonomy_off", "Autonomy is off"] : ["new_authority", "New module authority"];
  return { ...v, decision: "escalate", code, reason: `The AI reviewer approved (${by}): ${v.reason} ${why}, so the owner decides: ${input.reason}` };
}

/** How a review-first card is held: "owner" (byMerit: the reviewer may only escalate), "final" (it may escalate or reject). */
export const reviewFirstOf = (...ts: (Part | undefined)[]): ReviewFirst | undefined => (ts.some((t) => t && !t.reject && t.byMerit) ? "owner" : ts.some((t) => t && !t.reject && t.reviewFirst) ? "final" : undefined);

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

/**
 * A task's approval record as tiering reads it. `answered`: who decided on the task after this rejection (review-loop.ts
 * answered): "owner", their own typed reply; "agent", a comment by the task's delegator or the chief of staff (never the
 * requester). An answered rejection no longer refuses the same content nor counts toward MAX_REJECTS; agents' answers lift
 * a target's park once (AGENT_LIFTS), the owner's every time.
 */
export type Prior = { id?: string; action: string; args?: any; state: string; decidedBy?: string | null; decidedAt?: string | null; reviewCode?: string | null; review?: string | null; requestChain?: string; digest?: string; answered?: "owner" | "agent"; /** No agent filed it (a module's own write). */ service?: boolean };
/** The actions a record carries: a product PR card with `args.merge` is also a merge, so neither dodges the other's no. */
const carried = (r: Prior) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
/** A no on a stale or duplicate card (decided_by `stale:account:<id>`) judged nothing: neither a veto nor a rejection. */
const STALE = (r: Prior) => /^stale:/.test(r.decidedBy ?? "");

/**
 * The rebuild path's check (an earlier yes is never replayed over a later no; the request gets a fresh card instead):
 * whether a no outranks the approvals being replayed. The owner's veto on the task does; so does a judged rejection (not
 * code's refusal) of the action, or of one the request carries, decided after the earliest of those approvals (`since`),
 * that names one of these branches, is a merge card, or carries the same patch under another name (`samePatch`: record ids
 * the runner matched by content; one it couldn't read counts as the same). A rejection of another branch on the same task never does: it
 * disabled the carry-over for every later rebase (PR #36, WOR-4253).
 */
export function rejectedSince(records: Prior[], action: string, also: string[] = [], branches: { repo: string; branch: string }[] = [], since = "", samePatch: Set<string> = new Set()): boolean {
  if (priorDecisions(records, action, also).ownerVeto) return true;
  const mine = (b: { repo: string; branch: string }) => branches.some((x) => same(x.repo, b.repo) && x.branch === b.branch);
  return laterRejections(records, action, also, since).some((r) => r.action === "merge" || (r.args?.only ?? []).some(mine) || samePatch.has(r.id!));
}

/**
 * The judged rejections (not code's refusals) of the action, or of one the request carries, decided at or after `since`.
 * The runner checks those on other branches by patch (rebuild): the same change renamed and rebased is still rejected.
 */
export function laterRejections(records: Prior[], action: string, also: string[] = [], since = ""): Prior[] {
  const want = [action, ...also];
  return (records ?? []).filter((r) => r.state === "rejected" && !r.answered && !STALE(r) && carried(r).some((x) => want.includes(x)) && !CODE_REJECTS.includes(r.reviewCode ?? "") && String(r.decidedAt ?? "") >= String(since));
}

const keyOf = (list: unknown[]) => (list.length && list.every((x) => typeof x === "string" && /^[0-9a-f]{7,64}$/i.test(x)) ? (list as string[]).map((x) => x.toLowerCase()).sort().join(",") : undefined);
/**
 * What a request changes, as a key two requests share only when their content is identical: the commits (push, PR), the
 * PR heads (merge), the fleet commit (apply), a module kind's digest. Never a branch name or PR number: renaming a branch
 * doesn't make a rejected change new.
 */
export function requestKey(action: string, s: any): string | undefined {
  if (action === "push" || action === "pr") return keyOf((s.branches ?? s.only ?? []).map((b: any) => b.sha));
  if (action === "merge") return keyOf((s.prs ?? []).map((p: any) => p.head));
  if (action === "apply") return s.sha ? `apply:${s.sha}` : undefined;
  if (action === "create_repo") return s.repo ? `create_repo:${String(s.repo).toLowerCase()}` : undefined;
  return s.digest ? `digest:${s.digest}` : undefined;
}
/**
 * A branch or PR request's patch keys (each branch's or PR's change, git.mjs patchKey), sorted and joined: the same however
 * the commits are rebased or the branch named. null when any is missing (fails closed against an owner veto); undefined for
 * actions keyed otherwise.
 */
export function requestPatches(action: string, s: any): string | null | undefined {
  const list = action === "push" || action === "pr" ? (s.branches ?? s.only) : action === "merge" ? s.prs : undefined;
  if (!list) return undefined;
  return list.length && list.every((x: any) => typeof x.patch === "string") ? list.map((x: any) => x.patch).sort().join(",") : null;
}
const recordPatches = (r: Prior) => requestPatches(r.action, { branches: r.args?.only ?? [], prs: r.args?.prs ?? [] }) ?? undefined;
/** The same key for an approval record (its args; a module kind's digest is its content). */
export function recordKey(r: Prior): string | undefined {
  if (r.action === "push" || r.action === "pr") return keyOf((r.args?.only ?? []).map((b: any) => b.sha));
  if (r.action === "merge") return keyOf((r.args?.prs ?? []).map((p: any) => p.head));
  if (r.action === "apply") return r.args?.sha ? `apply:${r.args.sha}` : undefined;
  if (r.action === "create_repo") return r.args?.repo ? `create_repo:${String(r.args.repo).toLowerCase()}` : undefined;
  return r.digest ? `digest:${r.digest}` : undefined;
}

/** One branch or PR a request changes, as the retry bound counts it, and its patch key (the change's content key). */
export type Target = { key: string; patch?: string; /** A run's own: other records' rejections and notes on the task are not this request's (reviewInput scopes them). */ own?: true };
/** The arguments that say where a connection tool call is aimed (never its text): an issue, a PR, a channel, a thread. */
const AIM = ["repo", "number", "issue_number", "pull_number", "channel", "thread_ts", "id"];
/**
 * Where a request is aimed, for MAX_REJECTS: every branch (`repo|branch`, its patch key) or PR (`repo#number`, its patch
 * key) it changes, and a label for the agent. `s` is either the verified request state (`branches`, `prs`) or an approval
 * record's args (`only`, `prs`). A connection tool call (conn.tool) is aimed at its tool and the AIM arguments it names, so
 * rejected comments on one issue never park a close on another. A service-filed request whose args carry a `run` is aimed at that run. A request of an action that names none of these (apply,
 * create_repo, a module digest) has the task as its target.
 */
export function requestTargets(action: string, s: any, service = false): { targets: Target[]; label: string } | undefined {
  if (action === "conn.tool" && s?.connection && s?.tool) {
    const aim = AIM.filter((k) => ["string", "number"].includes(typeof s.arguments?.[k])).map((k) => `${k}=${String(s.arguments[k]).toLowerCase()}`);
    const label = `${s.connection}.${s.tool}${aim.length ? ` (${aim.join(", ")})` : ""}`;
    return { targets: [{ key: label }], label };
  }
  const of = (x: any, key: string): Target => ({ key, ...(typeof x?.patch === "string" ? { patch: x.patch } : {}) });
  const branches = action === "push" || action === "pr" ? (s?.branches ?? s?.only ?? []).filter((b: any) => b?.repo && b?.branch) : [];
  if (branches.length) return { targets: branches.map((b: any) => of(b, `${String(b.repo).toLowerCase()}|${b.branch}`)), label: `branch${branches.length > 1 ? "es" : ""} ${branches.map((b: any) => `\`${b.branch}\``).join(", ")}` };
  const prs = action === "merge" ? (s?.prs ?? []).filter((p: any) => p?.repo && p?.number !== undefined) : [];
  if (prs.length) return { targets: prs.map((p: any) => of(p, `${String(p.repo).toLowerCase()}#${p.number}`)), label: `PR${prs.length > 1 ? "s" : ""} ${prs.map((p: any) => `#${p.number}`).join(", ")}` };
  // A record no agent filed (`service`: a module's own write) that names the run it reports on (a review's post, one per run) is
  // aimed at that run: sibling runs of a task are different requests, never retries of each other. An agent's request never
  // is: it could mint fresh run ids to dodge the park.
  if (service && typeof s?.run === "string" && s.run) return { targets: [{ key: `${action}|run=${s.run}`, own: true }], label: `run ${s.run}` };
  return undefined;
}
/** The targets a record was raised against (its card's args), for a rejection to be counted on. */
const recordTargets = (r: Prior): Target[] => requestTargets(r.action, r.args, r.service)?.targets ?? [];

/** Reviewer rejections one target's retries are bounded by: past this many (since the owner's last yes), it is parked. */
export const MAX_REJECTS = 5;
/**
 * The parks agents' answers lift on one target (the delegator's or the chief of staff's decision on the task): once
 * MAX_REJECTS * (AGENT_LIFTS + 1) rejections stand there, only the owner's own reply or yes moves it, so two agents never
 * retry a reviewer without end.
 */
export const AGENT_LIFTS = 1;
/** Whether the agents' lifts (the delegator's or the chief of staff's) are spent on a target: only the owner moves it then. */
export const liftsSpent = (held: number) => held >= MAX_REJECTS * (AGENT_LIFTS + 1);
/** The key of what the reviewer read as the request: the chain and the agents' task comments (an unsure or a split lifts once it changes). */
export const requestHash = (chain: string | undefined, comments?: string) => (chain ? createHash("sha256").update(comments ? `${chain}\n\n${comments}` : chain).digest("hex").slice(0, 32) : "");
/** Panel splits (approve + reject) sent back to the agent on one target before the next goes to the owner (owner, 2026-11-20). */
export const MAX_SPLITS = 3;
/** Rejections code made without judging the change (it moved, couldn't be read, too large): they are never findings. */
export const CODE_REJECTS = ["refused_by_code", "stale_head", "check_failed", "files_not_shown", "no_diff", "reviewer_failed"];
const byOwner = (r: Prior) => Boolean(r.decidedBy) && !/^(reviewer|auto|stale):/.test(r.decidedBy!);
// An approved card a newer request replaced is `expired`, still decided (a yes).
const decided = (r: Prior) => ["approved", "used", "expired", "rejected"].includes(r.state) && Boolean(r.decidedBy);

/**
 * Earlier decisions on a task for a request (owner, 2026-11-14), from its approval records of the action (or of one the
 * request also carries; only decided records, never a Tier 0 one):
 * - ownerVeto: the owner's latest decision on it was a no (their later yes withdraws that), or the owner rejected exactly
 *   this content and hasn't approved that same content since (an approval of other content doesn't lift it).
 * - rejects: the AI reviewer's unanswered rejections (Prior.answered) since the owner's last yes of the busiest of the branches or PRs `targets` names
 *   (tier.ts requestTargets), counted per target: a rejection belongs to a target by its name, or by the change's content key
 *   (a rebased or renamed resubmission on another branch), and never to a target it wasn't raised against, so three spread
 *   across three branches park none of them. At MAX_REJECTS a target is parked; without `targets` (an action that names
 *   neither branch nor PR) the task is the target, as before.
 * - same: one of those rejected exactly this content (requestKey, or the same patch keys: an amended, rebased or renamed
 *   resubmission of the same change; a conn.tool call's or module kind's digest): it stays rejected (its note), refused by
 *   code before any review (owner, 2026-11-18: refile only after a fix). Two reviewers' unsure lifts once, after the request
 *   chain changed (`chain`: the current chain's hash); a panel split lifts each time the chain changed since every split of
 *   that content. A conn.tool call whose arguments can't change (a close, a label) is
 *   refused unchanged on this task once rejected: the agent reports back instead.
 * - splits: the most panel splits (approve + reject, panel_split) on one target, counted apart from `rejects` (they never
 *   park it): after MAX_SPLITS of them the next goes to the owner (splitToOwner).
 * - findings: every one of those notes, attached to the next review.
 */
export function priorDecisions(records: Prior[], action: string, also: string[] = [], key?: string, patches?: string | null, chain?: string, targets?: { targets: Target[]; label: string }) {
  const want = [action, ...(also ?? [])];
  const mine = (records ?? []).filter((r) => decided(r) && carried(r).some((x) => want.includes(x))).sort((a, b) => String(a.decidedAt ?? "").localeCompare(String(b.decidedAt ?? "")));
  const lastOwner = mine.filter(byOwner).at(-1);
  const ownerYes = mine.filter((r) => byOwner(r) && r.state !== "rejected").at(-1);
  const approvedLater = (r: Prior) => mine.some((y) => y.state !== "rejected" && String(y.decidedAt) > String(r.decidedAt) && recordKey(y) !== undefined && recordKey(y) === recordKey(r));
  const judged = mine.filter((r) => r.state === "rejected" && r.decidedBy!.startsWith("reviewer:") && !CODE_REJECTS.includes(r.reviewCode ?? "") && (!ownerYes || String(r.decidedAt) > String(ownerYes.decidedAt)) && !approvedLater(r));
  // The retry bound is per target: each rejection is counted on the branch or PR it was raised against (by name), or on this
  // request's target whose content key it carries. `rejects` is the busiest target's count: three rejections spread one each
  // across three branches park none of them, and a multi-branch request is parked when any one of its branches is.
  const asked = new Map((targets?.targets ?? []).filter((t) => typeof t.patch === "string").map((t) => [t.key, t.patch!]));
  // `count`: the unanswered rejections; `held`: those plus the ones only an agent answered, which hold the park again once
  // agents have lifted it AGENT_LIFTS times (the owner's answer lifts it whatever the count).
  const count = new Map<string, number>();
  const held = new Map<string, number>();
  const splitCount = new Map<string, number>();
  for (const r of targets?.targets.length ? judged : []) {
    // Each rejection counts once per target: the branch it names, and this request's target carrying its patch key. A record
    // matching both is still one rejection on that branch (the Set).
    const named = new Set(recordTargets(r).map((t) => t.key).filter((k) => targets!.targets.some((x) => x.key === k)));
    const byPatch = new Set<string>((r.args?.only ?? r.args?.prs ?? []).flatMap((x: any) => (typeof x?.patch === "string" ? [...asked].filter(([, p]) => p === x.patch).map(([k]) => k) : [])));
    // The same content as this whole request (its commits, or its patch keys) counts on every target it names, so renaming
    // the branch never resets the bound, even when a patch key couldn't be computed.
    const byContent = (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches) ? targets!.targets.map((t) => t.key) : [];
    // A panel split (approve + reject) has its own bound (MAX_SPLITS), never the park bound's.
    const bounds = r.reviewCode === "panel_split" ? [splitCount] : [...(r.answered ? [] : [count]), ...(r.answered === "owner" ? [] : [held])];
    for (const k of new Set([...named, ...byPatch, ...byContent])) for (const bound of bounds) bound.set(k, (bound.get(k) ?? 0) + 1);
  }
  const parks = (n: number[]) => Math.max(0, ...n);
  const unanswered = judged.filter((r) => r.reviewCode !== "panel_split");
  const [open, agentHeld] = targets?.targets.length ? [parks([...count.values()]), parks([...held.values()])] : [unanswered.filter((r) => !r.answered).length, unanswered.filter((r) => r.answered !== "owner").length];
  const rejects = agentHeld >= MAX_REJECTS * (AGENT_LIFTS + 1) ? agentHeld : open;
  const splits = targets?.targets.length ? Math.max(0, ...splitCount.values()) : judged.filter((r) => r.reviewCode === "panel_split").length;
  // Two reviewers unsure (reviewer_unsure) is about the request: the fix is often the brief or an authorisation, so the
  // same commits may come back once, after the request chain changed (`chain`, its hash now; `requestChain`, its hash
  // when they were unsure). The chain is agent-editable, so that lift happens at most once per content: unsure again there
  // is a second rejection of the same content, which stays rejected. Unchanged or unknown chain, or any other rejection of
  // the content, and it stays rejected. It still counts toward MAX_REJECTS (on the branch
  // it was raised against). Content is judged task-wide: this is about what was written, not where it was aimed.
  const rejectedSame = key || typeof patches === "string" ? judged.filter((r) => !r.answered).filter((r) => (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches)) : [];
  const [only] = rejectedSame;
  // A panel split (approve + reject) is often the brief's fault too (WOR-8812: the code was right, the brief contradicted
  // itself): the same commits come back each time the chain changed since every split of them (each re-review that splits
  // again is the next split, MAX_SPLITS). The same chain stays refused.
  const unsureLift = rejectedSame.length === 1 && only!.reviewCode === "reviewer_unsure" && Boolean(only!.requestChain) && Boolean(chain) && only!.requestChain !== chain;
  const splitLift = rejectedSame.length > 0 && Boolean(chain) && rejectedSame.every((r) => r.reviewCode === "panel_split" && Boolean(r.requestChain) && r.requestChain !== chain);
  const lifted = unsureLift || splitLift;
  const sameOne = lifted ? undefined : rejectedSame[0];
  // The owner's no on this exact content holds until they approve that same content, whatever else they approved since.
  // Same content: the commits, or the patch keys (a rebased or renamed resubmission). Patch keys that couldn't be computed
  // (null) fail closed: any owner rejection of the action on the task makes it theirs.
  const sameContent = (r: Prior) => (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches);
  const ownerNo = mine.some((r) => byOwner(r) && r.state === "rejected" && (patches === null || (sameContent(r) && !mine.some((y) => byOwner(y) && y.state !== "rejected" && sameContent(y) && String(y.decidedAt) > String(r.decidedAt)))));
  // `held` too: the rejections that stand including the ones only an agent answered, which the park notice and the rejection
  // note read to know when the agents' once-lift is spent (review-loop.ts).
  return { ownerVeto: lastOwner?.state === "rejected" || ownerNo, same: sameOne ? sameOne.review || "no note" : undefined, rejects, held: agentHeld, splits, findings: judged.filter((r) => !r.answered).map((r) => r.review).filter(Boolean) as string[], ...(targets?.targets.length ? { scope: targets.label } : {}) };
}

/** What earlier decisions do to a request: the owner's veto (their card), a rejected change resent, a retry past the bound. */
export function priorPart(p: ReturnType<typeof priorDecisions> | undefined): Part | undefined {
  if (!p) return undefined;
  if (p.ownerVeto) return T(2, "owner-veto", "the owner rejected this action on this task, and only their own yes lifts it");
  if (p.same !== undefined) return REJECT("rejected-content", `the AI reviewer already rejected exactly this request on this task, so it isn't reviewed again unchanged (its note: ${String(p.same).slice(0, 400)}). Change what it found and file the changed request, or report back to whoever asked why it can't change`);
  if (p.rejects >= MAX_REJECTS) {
    const scope = (p as { scope?: string }).scope ?? "this task";
    // The agents' once-lift is spent at MAX_REJECTS * (AGENT_LIFTS + 1): saying "once; after that, only the owner" then offers
    // a lift that no longer works (AidenHQ#1256).
    if (liftsSpent(p.rejects)) return REJECT("retries-exhausted", `parked: the AI reviewer rejected this action ${p.rejects} times on ${scope}, so it isn't reviewed again here. The agents' lift is spent (whoever delegated the task, or the chief of staff, lifts a park once), so only the owner's own reply or yes moves it now. A different branch, PR or tool target of the task is reviewed on its own; report what it found to whoever asked for this work, or change the request`);
    return REJECT("retries-exhausted", `parked: the AI reviewer rejected this action ${p.rejects} times on ${scope}, so it isn't reviewed again here until a decision on the task lifts it (whoever delegated the task, or the chief of staff, once; after that, only the owner). A different branch, PR or tool target of the task is reviewed on its own; report what it found to whoever asked for this work`);
  }
  return undefined;
}

// ------------------------------------------------------------------ the reviewer's verdict on a record

/** The requester's tier input for a review (its classify() now, or code's refusal), with the record's review-first kept. */
/** `splits`: the panel splits (approve + reject) already on the record's busiest target (priorDecisions). */
export type ReviewInput = Part & { error?: string; lasting?: boolean; stale?: boolean; splits?: number };
/** A record filed review-first stays so, whatever the tier input says now (raise only). */
export function heldInput(input: ReviewInput, reviewFirst: ReviewFirst | null | undefined): ReviewInput {
  if (reviewFirst && !input.error && !input.reject && (input.tier < 2 || input.reviewFirst)) return { ...input, reviewFirst: true, ...(reviewFirst === "owner" ? { byMerit: true } : {}) };
  return input;
}
/** Code's verdict, when no model is asked: the input couldn't be computed, code refuses it, or it is the owner's now. */
export function codeVerdict(input: ReviewInput, model: string): Verdict | undefined {
  if (input.error) return input.lasting ? { decision: "reject", code: input.stale ? "stale_head" : "refused_by_code", reason: `${input.error}. Ask again.`, model } : { decision: "escalate", code: "reviewer_failed", reason: `couldn't check the change (${input.error})`, model };
  if (input.reject) return { decision: "reject", code: input.rule === "head-moved" ? "stale_head" : "refused_by_code", reason: `${input.reason}.`, model };
  if (input.tier > 1 && !input.reviewFirst) return { decision: "escalate", code: "tier_raised", reason: `code now puts it at Tier 2: ${input.reason}`, model };
  return undefined;
}
/** A failed review (the reviewer unreachable, failing or slow) waits 1, 2, 4 … minutes, never more than this, and is never rejected for it. */
export const RETRY_CAP_MS = 15 * 60_000;
/** Failed reviews of a record that is Tier 2 on its merits before the owner's card, with the failure on it, replaces the retries. */
export const OWNER_AFTER_TRIES = 6;
export const ownerAfterFailure = (input: ReviewInput, v: Verdict, n: number): Verdict =>
  ({ ...v, decision: "escalate", code: "owner_tier", reason: `The AI reviewer couldn't read it (${v.reason}, ${n} times). It is Tier 2 on its merits, so the owner decides: ${input.reason}` });
/** The wait before try `n` (1-based) of a failed review or of an approved record's pre-run reads. */
export const retryWait = (n: number) => Math.min(60_000 * 2 ** (n - 1), RETRY_CAP_MS);
/**
 * The panel's approve + reject (reject, panel_split) goes back to the agent with both notes, up to MAX_SPLITS times on its
 * target; the next one goes to the owner (owner, 2026-11-20: "go back for fix up to 3 times and only then escalate"). Splits
 * never count toward the park bound (MAX_REJECTS).
 */
export const splitToOwner = (input: ReviewInput, v: Verdict): Verdict =>
  v.decision === "reject" && v.code === "panel_split" && (input.splits ?? 0) >= MAX_SPLITS
    ? { ...v, decision: "escalate", reason: `The two AI reviewers split again after ${MAX_SPLITS} send-backs on this target, so the owner decides. ${v.reason}`.slice(0, 1990) }
    : v;
/** autonomy tier0: the reviewer only comments, so its approve or reject goes to the owner as a note; off keeps a reject final. */
export const shadowed = (v: Verdict, mode: Autonomy): Verdict =>
  mode === "full" || v.decision === "escalate" || (mode === "off" && v.decision === "reject") ? v : { ...v, decision: "escalate", code: "shadow", reason: `Shadow (autonomy: tier0): the reviewer would ${v.decision} this. ${v.reason}` };
