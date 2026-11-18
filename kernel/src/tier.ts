// K5, the tier formula (spec §5.1) and the generic tier rules every requester shares: every term raises, none lowers. Tier 0
// runs at once (still a record), Tier 1 is the reviewer's, Tier 2 the owner's. A record headed for the reviewer carries how
// the owner follows it (`reviewFirst`): null, the reviewer decides; "final", its approve goes on to the owner and its reject
// is final; "owner", Tier 2 on its merits, every verdict goes on to the owner (code's own refusals aside). Pure.
// The requesters' own rules (which repo, file or module change is which tier) stay with them: a module's executor plan
// (the code host's plan.mjs) and the kernel's apply planner propose a raise. The kernel tiers every write with computeTier: floors,
// raises, the owner's veto, then the caps (the instance's autonomy off, a routine's). What else they share is here:
// combining parts, earlier decisions on a task, and what a review-first record does with the reviewer's verdict.
export type Tier = 0 | 1 | 2;
export type Autonomy = "off" | "tier0" | "full";
export type ReviewFirst = "final" | "owner";
export type Raise = { tier: 1 | 2; panel?: boolean; reason?: string; rule?: string };
/** The cap a write was tiered under, kept on its record: the instance's autonomy off, or a routine's (`routine`: its id; absent when the trace couldn't be read). */
export type Cap = { by: "autonomy" | "routine"; value: Autonomy; routine?: string };
/** A task's routine cap, as the kernel traces it (taskRoutineCap). */
export type RoutineCap = { cap: Autonomy; routine?: string };
/** One part of a request's tier, as the requesters' rules build it. */
export type Part = { tier: number; rule?: string; reason?: string; panel?: boolean; reject?: boolean; reviewFirst?: boolean; byMerit?: boolean; cap?: Cap | null; [k: string]: unknown };
/** A model's verdict, or code's in its place. */
export type Verdict = { decision: "approve" | "reject" | "escalate"; reason: string; model: string; second?: string; code?: string };

/** What a cap says, for a card's reason and the reviewer's label. */
export const capText = (c: Cap) => (c.by === "autonomy" ? `autonomy is ${c.value}` : c.routine ? `a routine's run (${c.routine}) started this task and its autonomy is ${c.value}` : "the task's routine trace couldn't be read, so it counts as a routine set to off");

/**
 * The one tier function every write goes through (writes.ts: module kinds, conn.tool, the runner's kinds). The merit tier
 * is the highest of the floors, raises and the owner's veto. A Tier 2 merit is reviewed first and the owner's
 * (`reviewFirst`, "owner" unless the requester says how: "final" for new module authority, null for the owner's tap alone).
 * Then the caps: the instance's autonomy off, or a routine's tier0 or off (`routine`; an unreadable trace is off). off lifts
 * Tier 0 to the owner's tap (rule autonomy-off or routine-autonomy) and makes Tier 1 review-first (the reviewer's reject is
 * final, its approve goes on to the owner); a routine's tier0 does the latter only. The instance's tier0 isn't a cap here:
 * it shadows the reviewer's verdict at review. `cap`: the cap that changed the tier, for the record.
 */
export function computeTier({ floor, instanceFloor = 0, raise, checkRaises = [], priorVeto = false, reviewFirst = "owner", autonomy, routine, panel = false, requester }: {
  floor: Tier; instanceFloor?: Tier; raise?: Raise; checkRaises?: Raise[]; priorVeto?: boolean; reviewFirst?: ReviewFirst | null; autonomy?: Autonomy; routine?: RoutineCap; panel?: boolean;
  /** The requester's kind: the caps limit what agents do on their own, so a write the kernel itself requests (kind `kernel`, which no token yields; it acts on an owner setting's standing authority) isn't capped. */
  requester?: string;
}): { tier: Tier; merit: Tier; panel: boolean; reviewFirst: ReviewFirst | null; cap?: Cap; rule?: string; state: "claimed" | "review" | "owner" } {
  if (requester === "kernel") { autonomy = undefined; routine = undefined; }
  const merit = Math.max(floor, instanceFloor, raise?.tier ?? 0, ...checkRaises.map((r) => r.tier), priorVeto ? 2 : 0) as Tier;
  // The caps that hold, the routine's first (its label names it when both do).
  const caps = [routine && routine.cap !== "full" ? { by: "routine", value: routine.cap, ...(routine.routine ? { routine: routine.routine } : {}) } : undefined, autonomy === "off" ? { by: "autonomy", value: "off" } : undefined].filter(Boolean) as Cap[];
  const off = caps.find((c) => c.value === "off");
  const out = { panel: panel || raise?.panel === true || checkRaises.some((r) => r.panel === true) };
  if (merit === 2) return { ...out, tier: 2, merit, reviewFirst: priorVeto ? "owner" : reviewFirst, state: priorVeto || reviewFirst ? "review" : "owner" };
  if (merit === 1 && caps[0]) return { ...out, tier: 2, merit, reviewFirst: "final", cap: caps[0], state: "review" };
  if (merit === 0 && off) return { ...out, tier: 2, merit, reviewFirst: null, cap: off, rule: off.by === "autonomy" ? "autonomy-off" : "routine-autonomy", state: "owner" };
  return { ...out, tier: merit, merit, reviewFirst: null, state: merit === 0 ? "claimed" : "review" };
}

export const T = (tier: number, rule: string, reason: string): Part => ({ tier, rule, reason });
export const REJECT = (rule: string, reason: string): Part => ({ tier: 2, rule, reason, reject: true });
const same = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

const rank = (p: Part) => p.tier * 2 + (p.panel ? 1 : 0);
/** The highest part (a reject beats everything; Tier 1 with the panel beats plain Tier 1); no parts is Tier 2. */
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
 * control plane returns them: its parents, and through each one's `originRunId` (its record of the run that created it,
 * which no agent sets) the issue that run worked on, and so on. So an unparented task a routine's run created keeps the
 * cap. `complete`: the trace finished; `routines`: the grants table's {<routine id>: autonomy}. The strictest routine found
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
 * Every issue a task traces back to, for its routine cap (routineCap): its parents, and through each one's
 * originRunId (Paperclip records the run that created an issue; agents never set it) the issue that run worked on, then
 * theirs. So a parent the agent picked, or none, can't shed a routine's cap. `runIssue` caches run id → issueId (a run's
 * issue never changes). Past ORIGIN_MAX issues the trace is incomplete (the cap is then the strictest).
 */
export async function origins(pc: Trace, full: any, runIssue: Map<string, string | null> = new Map()): Promise<{ issues: any[]; complete: boolean; recorded: RoutineCap[] }> {
  const seen = new Map<string, any>();
  const recorded: RoutineCap[] = [];
  const queue: any[] = [full];
  while (queue.length) {
    const i = queue.shift();
    if (!i || seen.has(i.id)) continue;
    if (seen.size >= ORIGIN_MAX) return { issues: [...seen.values()], complete: false, recorded };
    seen.set(i.id, i);
    // Every issue on the trace, not only the task: a run's child of a job-created task reaches it through originRunId.
    const p = pc.provenance(i);
    if (p) recorded.push(p === "pending" ? { cap: "off" } : p);
    if (i.parentId) queue.push(await pc.issue(i.parentId));
    // A routine run task is the root: its originRunId is the routine run (not a heartbeat run) and nothing created it.
    if (i.originRunId && i.originKind !== "routine_execution") {
      if (!runIssue.has(i.originRunId)) runIssue.set(i.originRunId, (await pc.run(i.originRunId))?.issueId ?? null);
      const from = runIssue.get(i.originRunId);
      if (from && !seen.has(from)) queue.push(await pc.issue(from));
    }
  }
  return { issues: [...seen.values()], complete: true, recorded };
}
/** What the routine trace reads: the control plane's issues and runs, and kernel provenance for an issue (provenance.ts trace: its row's cap, "pending" for a marked task with no row yet). */
export type Trace = { issue(id: string): Promise<any>; run(id: string): Promise<any>; provenance(issue: any): RoutineCap | "pending" | undefined };
/** A task's routine cap: kernel provenance first, then the control plane; a trace that fails (a read that throws) is incomplete: "off". Never throws. */
export const taskRoutineCap = (pc: Trace, task: string, routines: Record<string, string> | null = {}, runIssue?: Map<string, string | null>): Promise<RoutineCap | undefined> =>
  pc.issue(task).then((full) => (full?.id ? origins(pc, full, runIssue) : { issues: [], complete: false, recorded: [] })).then(({ issues, complete, recorded }) => routineCap(issues, complete, routines, recorded), () => routineCap([], false, routines));

// ------------------------------------------------------------------ earlier decisions on a task

/** A task's approval record as tiering reads it (the runner's view of a kernel record). */
/** `answered`: the owner replied on the task after this rejection (answered.ts): it no longer blocks or attaches its note, but still counts toward MAX_REJECTS. */
export type Prior = { id?: string; action: string; args?: any; state: string; decidedBy?: string | null; decidedAt?: string | null; reviewCode?: string | null; review?: string | null; requestChain?: string; digest?: string; answered?: boolean };
/** The actions a record carries: a product PR card with `args.merge` is also a merge, so neither dodges the other's no. */
const carried = (r: Prior) => [r.action, ...(r.action === "pr" && r.args?.merge ? ["merge"] : [])];
/** A watcher's no on a stale or duplicate card (decided_by `stale:watcher`) judged nothing: neither a veto nor a rejection. */
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
  if (action === "push" || action === "pr") return keyOf((s.branches ?? []).map((b: any) => b.sha));
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
  const list = action === "push" || action === "pr" ? s.branches : action === "merge" ? s.prs : undefined;
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
export type Target = { key: string; patch?: string };
/** The arguments that say where a connection tool call is aimed (never its text): an issue, a PR, a channel, a thread. */
const AIM = ["repo", "number", "issue_number", "pull_number", "channel", "thread_ts", "id"];
/**
 * Where a request is aimed, for MAX_REJECTS: every branch (`repo|branch`, its patch key) or PR (`repo#number`, its patch
 * key) it changes, and a label for the agent. `s` is either the verified request state (`branches`, `prs`) or an approval
 * record's args (`only`, `prs`). A connection tool call (conn.tool) is aimed at its tool and the AIM arguments it names, so
 * rejected comments on one issue never park a close on another. A request of an action that names none of these (apply,
 * create_repo, a module digest) has the task as its target.
 */
export function requestTargets(action: string, s: any): { targets: Target[]; label: string } | undefined {
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
  return undefined;
}
/** The targets a record was raised against (its card's args), for a rejection to be counted on. */
const recordTargets = (r: Prior): Target[] => requestTargets(r.action, r.args)?.targets ?? [];

/** Reviewer rejections one target's retries are bounded by: past this many (since the owner's last yes), it is parked. */
export const MAX_REJECTS = 3;
/** Rejections code made without judging the change (it moved, couldn't be read, too large): they are never findings. */
export const CODE_REJECTS = ["refused_by_code", "stale_head", "check_failed", "too_large", "files_not_shown", "no_diff", "reviewer_failed"];
const byOwner = (r: Prior) => Boolean(r.decidedBy) && !/^(reviewer|auto|stale):/.test(r.decidedBy!);
// An approved card a newer request replaced is `expired`, still decided (a yes).
const decided = (r: Prior) => ["approved", "used", "expired", "rejected"].includes(r.state) && Boolean(r.decidedBy);

/**
 * Earlier decisions on a task for a request (owner, 2026-11-14), from its approval records of the action (or of one the
 * request also carries; only decided records, never a Tier 0 one):
 * - ownerVeto: the owner's latest decision on it was a no (their later yes withdraws that), or the owner rejected exactly
 *   this content and hasn't approved that same content since (an approval of other content doesn't lift it).
 * - rejects: the AI reviewer's rejections since the owner's last yes of the busiest of the branches or PRs `targets` names
 *   (tier.ts requestTargets), counted per target: a rejection belongs to a target by its name, or by the change's content key
 *   (a rebased or renamed resubmission on another branch), and never to a target it wasn't raised against, so three spread
 *   across three branches park none of them. At MAX_REJECTS a target is parked; without `targets` (an action that names
 *   neither branch nor PR) the task is the target, as before.
 * - same: one of those rejected exactly this content (requestKey, or the same patch keys: an amended, rebased or renamed
 *   resubmission of the same change; a conn.tool call's or module kind's digest): it stays rejected (its note), refused by
 *   code before any review (owner, 2026-11-18: refile only after a fix). Two reviewers' unsure lifts once, after the request
 *   chain changed (`chain`: the current chain's hash). A conn.tool call whose arguments can't change (a close, a label) is
 *   refused unchanged on this task once rejected: the agent reports back instead.
 * - relift: that lift's earlier note: the re-review's unsure goes to the owner, not back to the agent.
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
  const count = new Map<string, number>();
  for (const r of targets?.targets.length ? judged : []) {
    // Each rejection counts once per target: the branch it names, and this request's target carrying its patch key. A record
    // matching both is still one rejection on that branch (the Set).
    const named = new Set(recordTargets(r).map((t) => t.key).filter((k) => targets!.targets.some((x) => x.key === k)));
    const byPatch = new Set<string>((r.args?.only ?? r.args?.prs ?? []).flatMap((x: any) => (typeof x?.patch === "string" ? [...asked].filter(([, p]) => p === x.patch).map(([k]) => k) : [])));
    // The same content as this whole request (its commits, or its patch keys) counts on every target it names, so renaming
    // the branch never resets the bound, even when a patch key couldn't be computed.
    const byContent = (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches) ? targets!.targets.map((t) => t.key) : [];
    for (const k of new Set([...named, ...byPatch, ...byContent])) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const rejects = targets?.targets.length ? Math.max(0, ...count.values()) : judged.length;
  // Two reviewers unsure (reviewer_unsure) is about the request: the fix is often the brief or an authorisation, so the
  // same commits may come back once, after the request chain changed (`chain`, its hash now; `requestChain`, its hash
  // when they were unsure). The chain is agent-editable, so that relift happens at most once per content: the re-review
  // gets `relift` (the first round's note), and unsure again there goes to the owner (the reviewer module). Unchanged or unknown
  // chain, or any other rejection of the content, and it stays rejected. It still counts toward MAX_REJECTS (on the branch
  // it was raised against). Content is judged task-wide: this is about what was written, not where it was aimed.
  const rejectedSame = key || typeof patches === "string" ? judged.filter((r) => !r.answered).filter((r) => (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches)) : [];
  const [only] = rejectedSame;
  const lifted = rejectedSame.length === 1 && only!.reviewCode === "reviewer_unsure" && Boolean(only!.requestChain) && Boolean(chain) && only!.requestChain !== chain;
  const sameOne = lifted ? undefined : rejectedSame[0];
  // The owner's no on this exact content holds until they approve that same content, whatever else they approved since.
  // Same content: the commits, or the patch keys (a rebased or renamed resubmission). Patch keys that couldn't be computed
  // (null) fail closed: any owner rejection of the action on the task makes it theirs.
  const sameContent = (r: Prior) => (key !== undefined && recordKey(r) === key) || (typeof patches === "string" && recordPatches(r) === patches);
  const ownerNo = mine.some((r) => byOwner(r) && r.state === "rejected" && (patches === null || (sameContent(r) && !mine.some((y) => byOwner(y) && y.state !== "rejected" && sameContent(y) && String(y.decidedAt) > String(r.decidedAt)))));
  return { ownerVeto: lastOwner?.state === "rejected" || ownerNo, same: sameOne ? sameOne.review || "no note" : undefined, relift: lifted ? only!.review || "no note" : undefined, rejects, findings: judged.filter((r) => !r.answered).map((r) => r.review).filter(Boolean) as string[], ...(targets?.targets.length ? { scope: targets.label } : {}) };
}

/** What earlier decisions do to a request: the owner's veto (their card), a rejected change resent, a retry past the bound. */
export function priorPart(p: ReturnType<typeof priorDecisions> | undefined): Part | undefined {
  if (!p) return undefined;
  if (p.ownerVeto) return T(2, "owner-veto", "the owner rejected this action on this task, and only their own yes lifts it");
  if (p.same !== undefined) return REJECT("rejected-content", `the AI reviewer already rejected exactly this request on this task, so it isn't reviewed again unchanged (its note: ${String(p.same).slice(0, 400)}). Change what it found and file the changed request, or report back to whoever asked why it can't change`);
  if (p.rejects >= MAX_REJECTS) return REJECT("retries-exhausted", `parked: the AI reviewer rejected this action ${p.rejects} times on ${(p as { scope?: string }).scope ?? "this task"}, so it isn't reviewed again here. A different branch, PR or tool target of the task is reviewed on its own; report what it found to whoever asked for this work`);
  return undefined;
}

// ------------------------------------------------------------------ the reviewer's verdict on a record

/** The requester's tier input for a review (its classify() now, or code's refusal), with the record's review-first kept. */
export type ReviewInput = Part & { error?: string; lasting?: boolean; stale?: boolean };
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
/** How many failed reviews (the reviewer unreachable, failing or slow) a record waits out before it goes back. */
export const REVIEW_TRIES = 6;
/** The last failed try: the owner's card on its merits still reaches them, with the failure on it; anything else goes back. */
export const failedVerdict = (input: ReviewInput, v: Verdict, n: number): Verdict =>
  input.byMerit ? { ...v, decision: "escalate", code: "owner_tier", reason: `The AI reviewer couldn't read it (${v.reason}, ${n} times). It is Tier 2 on its merits, so the owner decides: ${input.reason}` } : { ...v, decision: "reject", reason: `${v.reason}, ${n} times: ask again later.` };
/** autonomy tier0: the reviewer only comments, so its approve or reject goes to the owner as a note; off keeps a reject final. */
export const shadowed = (v: Verdict, mode: Autonomy): Verdict =>
  mode === "full" || v.decision === "escalate" || (mode === "off" && v.decision === "reject") ? v : { ...v, decision: "escalate", code: "shadow", reason: `Shadow (autonomy: tier0): the reviewer would ${v.decision} this. ${v.reason}` };
