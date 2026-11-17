// The kernel's records, read-only (kernel/src/records.ts keeps them; the board keeps no approval store). Cards are decided
// on the kernel's approval page or in a channel; the board lists them with the board's key (gateway_board_key) and shows them.
import type { ReviewCode } from "./reason-codes.js";

/** auto: a Tier 0 run, made at once with no decision (an audit row only). */
export type State = "pending" | "approved" | "rejected" | "stale" | "expired" | "used" | "auto";
export type Tier = 0 | 1 | 2;

/** A record as the board shows it (and agents read it: task_approvals), mapped from the kernel's. */
export interface Approval {
  id: string;
  /** The Paperclip task id, and its identifier (the id again when the filer didn't know it). */
  issueId: string;
  identifier: string;
  /** The kind as people read it: push, pr, merge, apply, create_repo, raise_cap, deploy_app, app_run, or a module's kind whole. */
  action: string;
  target: string;
  digest: string;
  args: unknown;
  sentence: string;
  reads: string;
  changes: string;
  cost: string;
  details: string;
  requestedBy: string;
  requesterId: string | null;
  tier: Tier;
  reason: string;
  reasonCode: string | null;
  review: string | null;
  reviewCode: ReviewCode | null;
  state: State;
  decidedBy: string | null;
  decidedAt: string | null;
  usedAt: string | null;
  outcome: "applied" | "failed" | null;
  outcomeText: string | null;
  createdAt: string;
  replaced: boolean;
  panel: boolean;
  reviewFirst: "final" | "owner" | null;
}

/** What GET /v1/writes returns: the kernel's record, its state already as a person sees it. */
type KernelRecord = {
  id: string; kind: string; args: unknown; digest: string; tier: Tier; panel: boolean; task: string; identifier?: string | null; state: string; review: string | null;
  review_code?: string | null; review_first?: "final" | "owner" | null; rule?: string | null; decided_by: string | null; decided_at?: string | null; replaced?: boolean;
  outcome: { ok: boolean; text: string } | null; created_at: string; updated_at: string;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string }; requester: { agent: string; key: string; name: string };
};
const KIND: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
const STATE: Record<string, State> = { review: "pending", owner: "pending", approved: "approved", claimed: "used", done: "used", failed: "used", unknown: "used", rejected: "rejected", stale: "stale", cancelled: "expired" };
const RAN = ["claimed", "done", "failed", "unknown"];

/** What a record acts on when its card doesn't say: a tool call's connection.tool, else the args' name, else its kind. */
function targetOf(r: KernelRecord): string {
  const a = (r.args ?? {}) as { name?: unknown; connection?: unknown; tool?: unknown };
  return r.kind === "conn.tool" && a.connection && a.tool ? `${a.connection}.${a.tool}` : String(a.name ?? r.kind);
}

export function recordApproval(r: KernelRecord): Approval {
  return {
    id: r.id, issueId: r.task, identifier: r.identifier || r.task, action: KIND[r.kind] ?? r.kind.replace(/^(runner|kernel)\./, ""), target: r.card.target ?? targetOf(r),
    digest: r.digest, args: r.args, sentence: r.card.sentence, reads: r.card.reads, changes: r.card.changes, cost: r.card.cost, details: r.card.details, requestedBy: r.requester.name || r.requester.key,
    requesterId: r.requester.agent || null, tier: r.state === "review" ? 1 : r.state === "owner" ? 2 : r.tier, reason: r.card.reason ?? "", reasonCode: r.rule ?? null, review: r.review,
    reviewCode: (r.review_code as ReviewCode | null | undefined) ?? null, state: r.tier === 0 && ["approved", ...RAN].includes(r.state) ? "auto" : (STATE[r.state] ?? "expired"), decidedBy: r.decided_by, decidedAt: r.decided_at ?? null,
    usedAt: RAN.includes(r.state) ? r.updated_at : null, outcome: r.state === "done" ? "applied" : r.state === "failed" || r.state === "unknown" ? "failed" : null, outcomeText: r.outcome?.text ?? null,
    createdAt: r.created_at, replaced: r.replaced === true, panel: r.panel, reviewFirst: r.review_first ?? null,
  };
}

/** What the board reads: the kernel's lists by state (owner, pending = owner or reviewer, recent = any, finished), newest first. */
export type Records = {
  /**
   * [] when the kernel is unreachable or not configured (logged once until it answers again): a page never fails on it.
   * `tier0`: Tier 0 runs too (the history's audit rows), else only the records that went to the reviewer or the owner.
   */
  list(state: "owner" | "pending" | "recent" | "finished", opts?: { task?: string; limit?: number; tier0?: boolean }): Promise<Approval[]>;
  /** The ids of the tasks with a record waiting on the owner. */
  awaiting(): Promise<Set<string>>;
  /** Marketplace advisories open against installed modules (plan unit 4e): Settings > Modules shows them as a banner. [] when unreachable. */
  advisories(): Promise<Advisory[]>;
};
export type Advisory = { id: string; module: string; severity: string; fixed: string; summary: string; url: string };

export function kernelRecords(k: { url: string; token: string } | undefined, log?: { warn(o: object, m: string): void }): Records {
  let down = false;
  const list: Records["list"] = async (state, { task, limit, tier0 } = {}) => {
    if (!k) return [];
    try {
      const res = await fetch(`${k.url}/v1/writes?state=${state}${task ? `&task=${encodeURIComponent(task)}` : ""}${limit ? `&limit=${limit}` : ""}${tier0 ? "&tier0=1" : ""}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
      const { records } = (await res.json()) as { records: KernelRecord[] };
      down = false;
      return records.map(recordApproval);
    } catch (err) {
      if (!down) log?.warn({ err: String(err) }, "kernel records unavailable");
      down = true;
      return [];
    }
  };
  const advisories = async (): Promise<Advisory[]> => {
    if (!k) return [];
    const res = await fetch(`${k.url}/v1/advisories`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    return res?.ok ? (((await res.json()) as { advisories: Advisory[] }).advisories ?? []) : [];
  };
  return { list, awaiting: async () => new Set((await list("owner")).map((a) => a.issueId)), advisories };
}
