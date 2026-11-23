// The kernel's records, read-only (kernel/src/records.ts keeps them; the board keeps no approval store). Cards are decided
// on the kernel's approval page or in a channel; the board lists them with the board's key (gateway_board_key) and shows them.
import type { ReviewCode } from "./reason-codes.js";
import type { Probe } from "./settings.js";
import { explain, type Explanation, type RecordWhole } from "./explain.js";

/** auto: a Tier 0 run, made at once with no decision (an audit row only); running: claimed, in flight, its wait reason on `wait` until it ends. */
export type State = "pending" | "approved" | "rejected" | "stale" | "expired" | "running" | "used" | "auto";
export type Tier = 0 | 1 | 2;
/** The owner's sign-in a settings change was made in, forwarded for the kernel to check: his board session token, or his MCP client's bearer with the resource it was minted for. */
export type SettingsCredential = { board: string } | { mcp: { token: string; resource: string } };

/** A record as the board shows it (and agents read it: task_approvals), mapped from the kernel's. */
export interface Approval {
  id: string;
  /** The Paperclip task id, and its identifier (the id again when the filer didn't know it). */
  issueId: string;
  identifier: string;
  /** The kind as people read it: push, pr, merge, apply, create_repo, deploy_app, app_run, or a module's kind whole. */
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
  /** Why the claimed record is still running (its executor's, from the kernel): null once it leaves `claimed`. */
  wait: string | null;
  createdAt: string;
  /** The kernel's `updated_at`: two snapshots of one card are reconciled by which the kernel wrote later, never by state name. */
  updatedAt: string;
  /** The owner's own typed reason when they reject a card (the kernel's `owner_reason`): untrusted words, and what a run needs
   * to change a rejected request. Null when the owner gave none. */
  ownerReason: string | null;
  replaced: boolean;
  panel: boolean;
  reviewFirst: "final" | "owner" | null;
  /** Whether its outcome is posted to the task: a decided record (a rejection and a stale close notify too), or one a module
   * filed for its agent. A Tier 0 record an agent filed itself answers that call inline and wakes nobody; a card still waiting
   * on the reviewer or owner, one expired or replaced (`cancelled`), and one the kernel recovers as `unknown` after a restart
   * are all closed by the code with no notice (kernel/src/writes.ts reconcile, records.ts expire), so none of those is a
   * wake. */
  wakes: boolean;
  /** Still able to act: waiting on the reviewer or owner, approved, or claimed. A Tier 0 record shows `auto` both while it is
   * queued and once it ended, so its state alone can't say; this can. */
  live: boolean;
}

/** What GET /v1/writes returns: the kernel's record, its state already as a person sees it. */
type KernelRecord = {
  id: string; kind: string; args: unknown; digest: string; tier: Tier; panel: boolean; task: string; identifier?: string | null; state: string; review: string | null;
  review_code?: string | null; review_first?: "final" | "owner" | null; rule?: string | null; decided_by: string | null; decided_at?: string | null; replaced?: boolean;
  outcome: { ok: boolean; text: string } | null; wait?: string | null; created_at: string; updated_at: string;
  card: { sentence: string; changes: string; reads: string; cost: string; details: string; reason?: string; target?: string }; requester: { agent: string; key: string; name: string; filed_by?: string };
  owner_reason?: string | null;
};
const KIND: Record<string, string> = { "apps-platform.deploy": "deploy_app", "apps-platform.run": "app_run" };
// `claimed` has a state of its own: it is live, and `used` is only ever an end (done/failed/unknown).
const STATE: Record<string, State> = { review: "pending", owner: "pending", approved: "approved", claimed: "running", done: "used", failed: "used", unknown: "used", rejected: "rejected", stale: "stale", cancelled: "expired" };
/** A record that has run: `used` is only ever an end, so only these carry `usedAt` (a claimed one is in flight, not used). */
const RAN = ["done", "failed", "unknown"];
/** A record an executor has taken (claimed): its state is `running` and it is live. */
const CLAIMED = "claimed";
/** A card's wait on the wire: bounded whatever the kernel keeps (its own cap is 200_000), while the record keeps it whole. */
const WAIT_SHOWN = 3000;
export const shownWait = (wait: string | null | undefined): string | null => {
  if (wait == null) return null;
  const t = String(wait);
  return t.length > WAIT_SHOWN ? `${t.slice(0, WAIT_SHOWN - 1).trimEnd()}…` : t;
};
/** A record in flight: claimed by its executor, non-terminal (the fleet's open cards and a settings apply's "applying"). */
export const LIVE = ["approved", "running"];
export const isLive = (state: State) => LIVE.includes(state);

/** What a record acts on when its card doesn't say: a tool call's connection.tool, else the args' name, else its kind. */
function targetOf(r: KernelRecord): string {
  const a = (r.args ?? {}) as { name?: unknown; connection?: unknown; tool?: unknown };
  return r.kind === "conn.tool" && a.connection && a.tool ? `${a.connection}.${a.tool}` : String(a.name ?? r.kind);
}

/** An open record past the kernel's cutoff is shown as `expired` (its own shownState), which expires it with no notice. The
 * kernel answers only its shown state, so a state of `approved` here means it has not yet been swept: a card at that cutoff is
 * about to be closed by the code, not by its executor. */
const CUTOFF_MS = 7 * 86_400_000;
const expired = (r: KernelRecord) => Date.parse(r.state === "review" || r.state === "owner" ? r.decided_at ?? r.created_at : r.created_at) <= Date.now() - CUTOFF_MS;

export function recordApproval(r: KernelRecord): Approval {
  return {
    id: r.id, issueId: r.task, identifier: r.identifier || r.task, action: KIND[r.kind] ?? r.kind.replace(/^(runner|kernel)\./, ""), target: r.card.target ?? targetOf(r),
    digest: r.digest, args: r.args, sentence: r.card.sentence, reads: r.card.reads, changes: r.card.changes, cost: r.card.cost, details: r.card.details, requestedBy: r.requester.name || r.requester.key,
    requesterId: r.requester.agent || null, tier: r.state === "review" ? 1 : r.state === "owner" ? 2 : r.tier, reason: r.card.reason ?? "", reasonCode: r.rule ?? null, review: r.review,
    // A claimed record is `running` whatever its tier: Tier 0 is only the audit word for one that has ended (or is approved
    // and not yet claimed), never for one in flight, whose wait the owner is shown while it holds.
    reviewCode: (r.review_code as ReviewCode | null | undefined) ?? null, state: r.state === CLAIMED ? "running" : r.tier === 0 && ["approved", CLAIMED, ...RAN].includes(r.state) ? "auto" : (STATE[r.state] ?? "expired"), decidedBy: r.decided_by, decidedAt: r.decided_at ?? null,
    ownerReason: r.owner_reason ?? null, usedAt: RAN.includes(r.state) ? r.updated_at : null, outcome: r.state === "done" ? "applied" : r.state === "failed" || r.state === "unknown" ? "failed" : null, outcomeText: r.outcome?.text ?? null,
    wait: r.state === CLAIMED ? r.wait ?? null : null, createdAt: r.created_at, updatedAt: r.updated_at, replaced: r.replaced === true, panel: r.panel, reviewFirst: r.review_first ?? null, wakes: (r.tier > 0 || r.requester.filed_by !== undefined) && !["review", "owner", "unknown", "cancelled"].includes(r.state) && !(r.state === "approved" && expired(r)), live: LIVE.includes(STATE[r.state] ?? "") || ["review", "owner"].includes(r.state),
  };
}

/** What the board reads: the kernel's lists by state (owner, pending = owner or reviewer, recent = any, finished), newest first. */
export type Records = {
  /**
   * [] when the kernel is unreachable or not configured (logged once until it answers again): a page never fails on it.
   * `tier0`: Tier 0 runs too (the history's audit rows), else only the records that went to the reviewer or the owner.
   */
  list(state: "owner" | "pending" | "recent" | "finished" | "approved" | "live", opts?: { task?: string; limit?: number; tier0?: boolean; strict?: boolean; after?: string; kinds?: string[] }): Promise<Approval[]>;
  /**
   * Every live record (`approved`, and `claimed` ones an executor holds), whatever its tier: the kernel's page size is its own
   * cap, so this walks the pages (`after`) rather than treating the largest one as the whole set. A Tier 0 merge held on review
   * ages out of no list this way, however many newer writes follow it. A page that fails throws rather than returning the pages
   * read so far: a caller must not mistake a timeout for "no more live records".
   */
  live(): Promise<Approval[]>;
  /** Every page of a state (`live` is every state a record can still act in), for one task and optionally one kind: a card
   * moving between states mid-read is never missed, and it is never behind the page cap, however many records follow it. */
  allOf(state: "pending" | "approved" | "live" | "recent", kinds?: string[], task?: string, maxPages?: number): Promise<Approval[]>;
  /** Marketplace advisories open against installed modules (plan unit 4e): Settings > Modules shows them as a banner. [] when unreachable. */
  advisories(): Promise<Advisory[]>;
  /** Every connection's /healthz as the kernel reaches it (the one place connection health is probed). {} when the kernel can't be asked. */
  connectionHealth(): Promise<Record<string, Probe>>;
  /** A sign-in or setup flow finished: the kernel clears that module's down state and wakes the tasks waiting on it (kernel connection-state.ts). */
  connectionOk(module: string): Promise<void>;
  /** The owner's typed settings change on their settings task: the kernel writes it and files its apply (kernel/src/settings-change.ts). `session`: the signed-in board session it was saved in, whose account the kernel checks and decides the record as. Throws the kernel's reason. */
  settingsChange(task: string, changes: unknown[], credential?: SettingsCredential): Promise<{ record: string; tier: number; state: string }>;
  /** A module's own check of settings about to be filed (module.yaml `validate:`, kernel/src/module-validate.ts). Throws the kernel's reason. */
  validate(module: string, settings: Record<string, unknown>): Promise<Validation>;
  /** A card's "Explain" (explain.ts): the record whole and its task's request chain. Throws the kernel's answer (404 for no such record). */
  explain(id: string): Promise<Explanation>;
};
/** What a module's validate hook said: fine (`unchecked`: it couldn't be asked, so it went unchecked), or each field's error. */
export type Validation = { ok: true; unchecked?: string } | { ok: false; errors: { field: string; message: string }[] };
export type Advisory = { id: string; module: string; severity: string; fixed: string; summary: string; url: string };

type Cause = { code?: string; errors?: Cause[] };
/** A connect failure on every address tried: the request never reached the kernel. */
const neverConnected = (c?: Cause): boolean => !!c && (c.errors?.length ? c.errors.every(neverConnected) : c.code === "ECONNREFUSED" || c.code === "ENOTFOUND");

export function kernelRecords(k: { url: string; token: string } | undefined, log?: { warn(o: object, m: string): void }): Records {
  let down = false;
  const list: Records["list"] = async (state, { task, limit, tier0, strict, after, kinds } = {}) => {
    if (!k) return [];
    try {
      const res = await fetch(`${k.url}/v1/writes?state=${state}${task ? `&task=${encodeURIComponent(task)}` : ""}${limit ? `&limit=${limit}` : ""}${tier0 ? "&tier0=1" : ""}${kinds?.length ? `&kinds=${encodeURIComponent(kinds.join(","))}` : ""}${after ? `&after=${encodeURIComponent(after)}` : ""}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`the kernel answered ${res.status}`);
      const { records } = (await res.json()) as { records: KernelRecord[] };
      down = false;
      return records.map(recordApproval);
    } catch (err) {
      if (!down) log?.warn({ err: String(err) }, "kernel records unavailable");
      down = true;
      if (strict) throw err;
      return [];
    }
  };
  /** The page size the kernel honours: its own cap (backplane.ts GET /v1/writes). */
  const PAGE = 1000;
  /** Hard bound on pages walked in one read: 1,000 pages is a million live records, past any real queue. */
  const PAGES_MAX = 1000;
  /**
   * Every page of a state, walked with `after`: a bounded read that must not lose a record behind the page cap. `live` is the
   * kernel's own read of every approved and claimed record, one query, so a card moving between the states mid-read is not missed.
   */
  const allOf = async (state: "pending" | "approved" | "live" | "recent", kinds?: string[], task?: string, maxPages = PAGES_MAX): Promise<Approval[]> => {
    const out: Approval[] = [];
    const seen = new Set<string>();
    let after = "";
    for (let i = 0; i < maxPages; i++) {
      // The kernel's live list is one read of both states; the page params still apply (its default page is 100).
      const page = await list(state, { limit: PAGE, tier0: true, strict: true, ...(task ? { task } : {}), ...(kinds?.length ? { kinds } : {}), ...(after ? { after } : {}) });
      const fresh = page.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.add(a.id);
      out.push(...fresh);
      if (page.length < PAGE || !fresh.length) break;
      after = page[page.length - 1]!.id;
    }
    return out;
  };
  const live: Records["live"] = async () => {
    const all: Approval[] = [];
    const seen = new Set<string>();
    let after = "";
    for (let i = 0; i < PAGES_MAX; i++) {
      // A page that failed must not look like the last one: the non-strict read answers [] for a timeout or an HTTP error, and
      // stopping there would silently return a partial live list (an old claimed merge gone from Approvals). `strict` makes the
      // failure throw, so the caller can keep its previous list rather than publish a short one.
      const page = await list("approved", { limit: PAGE, tier0: true, strict: true, ...(after ? { after } : {}) });
      const fresh = page.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.add(a.id);
      all.push(...fresh);
      // A short page is the last one; a full page that adds nothing new means the kernel ignored the cursor, so stop rather than
      // read the same page again.
      if (page.length < PAGE || !fresh.length) break;
      after = page[page.length - 1]!.id;
    }
    return all;
  };
  const advisories = async (): Promise<Advisory[]> => {
    if (!k) return [];
    const res = await fetch(`${k.url}/v1/advisories`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    return res?.ok ? (((await res.json()) as { advisories: Advisory[] }).advisories ?? []) : [];
  };
  const connectionHealth = async (): Promise<Record<string, Probe>> => {
    if (!k) return {};
    const res = await fetch(`${k.url}/v1/connections/health`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    return res?.ok ? (((await res.json()) as { probes: Record<string, Probe> }).probes ?? {}) : {};
  };
  const connectionOk = async (module: string): Promise<void> => {
    if (!k) return;
    const res = await fetch(`${k.url}/v1/connections/${encodeURIComponent(module)}/ok`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`POST /v1/connections/${module}/ok -> ${res.status}`);
  };
  const settingsChange: Records["settingsChange"] = async (task, changes, credential) => {
    if (!k) throw Object.assign(new Error("the board has no kernel to write the change"), { refused: true });
    // Only the kernel's own 4xx says nothing was written; a refused connection never reached it, but a lost response, a timeout or a 5xx may follow a write.
    const res = await fetch(`${k.url}/v1/settings/change`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify({ task, changes, ...(credential ? { credential } : {}) }), signal: AbortSignal.timeout(180_000) }).catch((e: Error & { cause?: Cause }) => { throw Object.assign(e, { refused: neverConnected(e.cause) }); });
    const j = (await res.json().catch(() => ({}))) as { record?: string; tier?: number; state?: string; message?: string; error?: string };
    if (!res.ok) throw Object.assign(new Error(String(j.message ?? j.error ?? `the kernel answered ${res.status}`)), { refused: res.status < 500 });
    return { record: String(j.record), tier: Number(j.tier), state: String(j.state) };
  };
  const validate: Records["validate"] = async (module, settings) => {
    if (!k) return { ok: true };
    const res = await fetch(`${k.url}/v1/validate`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify({ module, settings }), signal: AbortSignal.timeout(20_000) });
    const j = (await res.json().catch(() => ({}))) as Validation & { message?: string; error?: string };
    if (!res.ok) throw new Error(String(j.message ?? j.error ?? `the kernel answered ${res.status}`));
    return j;
  };
  const explainOf: Records["explain"] = async (id) => {
    if (!k) throw new Error("the board has no kernel to read the record from");
    const get = (path: string) => fetch(`${k.url}${path}`, { headers: { authorization: `Bearer ${k.token}` }, signal: AbortSignal.timeout(15_000) });
    const [rec, chain] = await Promise.all([get(`/v1/writes/${encodeURIComponent(id)}`), get(`/v1/writes/${encodeURIComponent(id)}/chain`).catch(() => undefined)]);
    if (!rec.ok) throw Object.assign(new Error(rec.status === 404 ? "no such record" : `the kernel answered ${rec.status}`), { status: rec.status === 404 ? 404 : 502 });
    // The chain is the task as it reads now: a task that is gone (or a kernel without the read) explains without it.
    const asked = chain?.ok ? String(((await chain.json()) as { chain?: unknown }).chain ?? "") : null;
    return explain((await rec.json()) as RecordWhole, asked);
  };
  return { list, live, allOf, connectionHealth, connectionOk, explain: explainOf, advisories, settingsChange, validate };
}
