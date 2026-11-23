import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useLive } from "./events";
import { Markdown } from "./markdown";
import { QUERIES, useQuery } from "./queries";
import { inFilter, deciderOf, foldsInChat, outcomeOf, type ApprovalFilter } from "./conversation";
import { Explain } from "./Explain";
import { CardListSkeleton, SkeletonLines, Updating } from "./Skeleton";
import type { Approval, ShownState } from "./types";
import { StatusDot } from "./ui/StatusDot";
import { Banner, Button, EmptyState, Input } from "./ui";
import { TaskState } from "./ui/TaskState";
import { ago } from "./util";

const OUTCOME: Record<Approval["state"], string> = {
  pending: "",
  approved: "Approved: applying…",
  running: "Running…",
  used: "Applying…",
  rejected: "Rejected: nothing ran.",
  stale: "Closed: its head moved before review, so nothing ran.",
  expired: "Expired: nothing ran.",
  unknown: "Unknown: the apply stopped without reporting back. Check the task; it is never retried.",
  auto: "Ran at once (Tier 0).",
};
const TIER_WORDS = ["Tier 0: ran at once", "Tier 1: the AI reviewer decides", "Tier 2: yours to decide"];
/** Waiting for the owner: a pending Tier 2 card. A pending Tier 1 card is with the AI reviewer. */
const forOwner = (a: Approval) => a.state === "pending" && a.tier === 2;
/** A card the AI reviewer has not decided yet (Tier 1): in progress, not waiting on the owner. */
const withAI = (a: Approval) => a.state === "pending" && !forOwner(a);

/**
 * A pending Tier 2 card's Approve and Reject (a reason is optional with a reject: the agent is told). The board forwards the
 * signed-in admin's session; the kernel checks it and decides against the digest this card shows, so a card that changed
 * meanwhile fails alone and says so.
 */
function Decide({ a }: { a: Approval }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    setError(null);
    try {
      await api.decide(a.id, a.digest, d, d === "reject" ? reason.trim() || undefined : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="approval-decide">
      {rejecting ? (
        <form className="approval-actions" onSubmit={(e) => (e.preventDefault(), void decide("reject"))}>
          <Input className="decide-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why not? (optional, the agent is told)" aria-label="Reason for rejecting" autoFocus />
          <Button type="submit" variant="danger" disabled={busy !== null}>{busy === "reject" ? "Rejecting…" : "Reject"}</Button>
          <Button variant="quiet" onClick={() => setRejecting(false)} disabled={busy !== null}>Cancel</Button>
        </form>
      ) : (
        <div className="approval-actions">
          <Button variant="primary" className="approve" onClick={() => void decide("approve")} disabled={busy !== null}>{busy === "approve" ? "Approving…" : "Approve"}</Button>
          <Button onClick={() => setRejecting(true)} disabled={busy !== null}>Reject…</Button>
        </div>
      )}
      {error && <p className="decide-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The batch bar for the cards picked on the Approvals list: Approve n, or Reject n with one reason. Each card is decided on its
 * own against the digest it showed (as a single card is), so one that changed meanwhile fails alone and is named here.
 */
function BatchBar({ cards, done }: { cards: Approval[]; /** The cards not decided (each with why), once the batch has run. */ done: (failed: string[]) => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const n = cards.length;
  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    const bad: string[] = [];
    for (const a of cards) {
      try {
        await api.decide(a.id, a.digest, d, d === "reject" ? reason.trim() || undefined : undefined);
      } catch (e) {
        bad.push(`${a.identifier}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (!bad.length) (setRejecting(false), setReason(""));
    done(bad);
  };
  return (
    <div className="batch-bar" role="region" aria-label="Decide the selected cards">
      <span className="batch-count">
        <b>{n}</b> selected
      </span>
      {rejecting ? (
        <form className="batch-actions" onSubmit={(e) => (e.preventDefault(), void decide("reject"))}>
          <Input className="decide-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why not? (optional, each agent is told)" aria-label="Reason for rejecting" autoFocus />
          <Button type="submit" variant="danger" disabled={busy !== null}>{busy === "reject" ? "Rejecting…" : `Reject ${n}`}</Button>
          <Button variant="quiet" onClick={() => setRejecting(false)} disabled={busy !== null}>Cancel</Button>
        </form>
      ) : (
        <div className="batch-actions">
          <Button onClick={() => setRejecting(true)} disabled={busy !== null}>Reject {n}…</Button>
          <Button variant="primary" onClick={() => void decide("approve")} disabled={busy !== null}>{busy === "approve" ? "Approving…" : `Approve ${n}`}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * One approval card: one sentence, what it reads and changes, the cost, Details; the outcome stays here. A pending Tier 2 card
 * is decided here (Decide); its id opens it alone (#/approvals/<id>).
 * An expired card (timed out or replaced by a newer request) folds to one muted line; a tap shows it whole.
 */
export function ApprovalCard({ a, open, inline, prefix = "", unfold, pick }: { a: Approval; open: (identifier: string) => void; inline?: boolean; prefix?: string; unfold?: boolean; /** On the Approvals list: the card's box in a batch decision. */ pick?: { on: boolean; toggle: () => void } }) {
  const [unfolded, setUnfolded] = useState(Boolean(unfold));
  // In a conversation a decided card is one line; one decided while on screen stays open.
  const [seenPending] = useState(a.state === "pending");
  const [shown, setShown] = useState(false);
  const [explained, setExplained] = useState(false);
  if (inline && !shown && foldsInChat(a, seenPending)) {
    const o = outcomeOf(a);
    const by = deciderOf(a);
    return (
      <li className={`approval-folded inline tone-${o.tone}`}>
        <button className="folded-line" onClick={() => setShown(true)} aria-expanded={false} title={`${a.sentence} (${a.id}): show the whole card`}>
          <span className="folded-mark" aria-hidden>
            {o.tone === "ok" ? "✓" : o.tone === "bad" ? "✕" : "–"}
          </span>
          <b className="folded-outcome">{o.text}</b>
          <span className="folded-sentence">{a.sentence}</span>
          <span className="folded-meta">
            {a.requestedBy}
            {by ? ` · by ${by}` : ""}
          </span>
          <span className="folded-more">details ▸</span>
        </button>
      </li>
    );
  }
  if (!inline && a.state === "expired" && !unfolded) {
    const replaced = /replaced/.test(a.outcomeText ?? "");
    return (
      <li className={`approval-folded${inline ? " inline" : ""}`}>
        <button className="folded-line" onClick={() => setUnfolded(true)} title={a.sentence}>
          {replaced ? "Replaced" : "Expired"} request {a.id}: {a.sentence}
        </button>
      </li>
    );
  }
  const buttons = forOwner(a) && <Decide a={a} />;
  const label = a.outcome === "applied" ? "Applied." : a.outcome === "failed" ? "Failed:" : OUTCOME[a.state];
  const text = a.outcome === "applied" ? (a.outcomeText ?? "") : a.outcome === "failed" ? (a.outcomeText ?? "no reason given") : a.state === "running" ? (a.wait ?? "") : "";
  return (
    <li className={`approval-card ap-${a.outcome ?? a.state}${inline ? " inline" : ""}${pick?.on ? " picked" : ""}`}>
      <div className="approval-head">
        {pick && (
          <label className="approval-pick" title="Select for a batch decision">
            <input type="checkbox" checked={pick.on} onChange={pick.toggle} aria-label={`Select ${a.identifier}: ${a.sentence}`} />
          </label>
        )}
        <button className="chat-open" onClick={() => open(a.identifier)}>
          <span className="chat-agent">{a.requestedBy}</span>
          <span className="chat-title">{!inline ? "Open the chat" : a.state === "auto" ? "ran it at once (Tier 0)" : a.state === "running" ? "is running" : a.tier === 1 && a.state === "pending" ? "asks the AI reviewer" : "asks for your approval"}</span>
        </button>
        <a className="muted small approval-id" href={`#/approvals/${a.id}`} title="Open this card alone">{a.id}</a>
        {inline && shown && (
          <button className="link-btn small" onClick={() => setShown(false)} aria-label="Fold this card to one line">
            Fold
          </button>
        )}
      </div>
      <p className="approval-sentence">{a.sentence}</p>
      <dl className="approval-facts">
        <dt>Reads</dt>
        <dd>{a.reads}</dd>
        <dt>Changes</dt>
        <dd className="pre">{a.changes}</dd>
        <dt>Cost</dt>
        <dd>{a.cost}</dd>
        <dt>Exact request</dt>
        <dd className="mono">{a.digest.slice(0, 12)}</dd>
        <dt>Tier</dt>
        <dd>
          {TIER_WORDS[a.tier] ?? `Tier ${a.tier}`}
          {a.reason && <span className="muted"> ({a.reason})</span>}
          {a.reasonCode && <span className="mono muted"> · {a.reasonCode}</span>}
          {a.baseTier != null && a.baseTier < a.tier && <span className="muted"> · Tier {a.baseTier} on its merits</span>}
        </dd>
        {a.decidedBy && (
          <>
            <dt>Decided by</dt>
            <dd className={a.decidedByName ? "" : "mono"}>{a.decidedByName ?? a.decidedBy}</dd>
          </>
        )}
        {a.review && (
          <>
            <dt>Reviewer's note</dt>
            <dd className="pre">
              {a.reviewCode === "reviewer_unsure" && <strong>{a.state === "rejected" ? "Two reviewers weren't sure, so it went back to the agent: " : "The reviewer wasn't sure, so it's yours: "}</strong>}
              {a.review}
              {a.reviewCode && <span className="mono muted"> · {a.reviewCode}</span>}
            </dd>
          </>
        )}
      </dl>
      {a.replaced && a.state === "pending" && <p className="muted small">This replaces an earlier request in this chat.</p>}
      {a.details && (
        <details className="approval-more">
          <summary>Details</summary>
          <pre className="approval-details">{a.details}</pre>
        </details>
      )}
      <button className="link-btn small approval-explain" onClick={() => setExplained(!explained)} aria-expanded={explained}>
        {explained ? "Hide the explanation" : a.state === "pending" ? "Explain: who decides this, and why" : "Explain this decision"}
      </button>
      {explained && <Explain id={a.id} />}
      {a.state === "pending" ? (
        buttons
      ) : (
        <div className={`approval-outcome ${a.outcome === "failed" || a.state === "unknown" ? "bad" : ""}`}>
          {label && <b>{label}</b>}
          {a.decidedByName && <span className="by">by {a.decidedByName}</span>}
          {text && (a.state === "running" ? <pre className="pre">{text}</pre> : <Markdown text={text} prefix={prefix} />)}
        </div>
      )}
    </li>
  );
}

/**
 * A tool call that ran at once (Tier 0): a module's or connection's kind (conn.tool, apps-platform.api_write), mostly task
 * bookkeeping (task_finish, task_comment, task_block). Policy let it run, so it's audit, not something to decide; a
 * failed one is its agent's to retry. Hidden from the history unless asked for; pushes, PRs, merges, applies and deploys stay.
 */
/**
 * A task that needs the owner for more than a card (a card is already listed above, whole) or an agent's question: questions
 * are answered in the conversation they were asked in, never on Approvals.
 */
export const onYouBeyondCards = (i: { state: ShownState }) => i.state.attention.some((a) => a.who === "owner" && a.why !== "card" && a.why !== "owner_wait");
const toolCall = (a: Approval) => a.state === "auto" && a.action.includes(".");

type Filter = ApprovalFilter;
const FILTERS: [Filter, string][] = [["pending", "Pending"], ["done", "Done"], ["failed", "Failed"], ["all", "All"]];

/** Retries of one request (same chat, action and target) as one group, newest first. */
function groups(list: Approval[]): Approval[][] {
  const by = new Map<string, Approval[]>();
  for (const a of [...list].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const k = `${a.identifier}|${a.action}|${a.target}`;
    by.set(k, [...(by.get(k) ?? []), a]);
  }
  return [...by.values()];
}

/** The Approvals page, or one card alone. */
export function ApprovalsView({ open, onSignIn, card }: { open: (identifier: string) => void; onSignIn: () => void; /** One card alone (#/approvals/<id>). */ card?: string }) {
  if (card) return <OneApproval key={card} id={card} open={open} />;
  return <AllApprovals open={open} onSignIn={onSignIn} />;
}

/** One card alone (#/approvals/<id>), read by its id whatever its age, decided here; it follows the card live. */
function OneApproval({ id, open }: { id: string; open: (identifier: string) => void }) {
  const [a, setA] = useState<Approval | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.approval(id).then((r) => (setA(r.approval), setError(null)), (e: Error & { status?: number }) => (e.status === 404 ? setA(null) : setError(e.message))), [id]);
  useEffect(() => void load(), [load]);
  useLive(["approvals"], load, 5_000);
  return (
    <main className="page wide approvals-page approval-one">
      <header className="page-head">
        <div>
          <p className="ui-crumb"><a href="#/approvals">Approvals</a></p>
          <h1>{a ? (forOwner(a) ? "Waiting for you" : outcomeOf(a).text) : "Approval"}</h1>
          <p className="page-sub">{a ? `${a.requestedBy} on ${a.identifier}` : id}</p>
        </div>
      </header>
      {error && <div className="alert">{error}</div>}
      {a === undefined ? (
        !error && <CardListSkeleton />
      ) : a ? (
        <ul className="approval-list pending-grid">
          <ApprovalCard a={a} open={open} unfold />
        </ul>
      ) : (
        <EmptyState action={<a className="btn" href="#/approvals">All approvals</a>}>There is no card {id}.</EmptyState>
      )}
    </main>
  );
}

/** Approvals: what waits for you first, big; then the history as one line per request, open to the full card. */
function AllApprovals({ open, onSignIn }: { open: (identifier: string) => void; onSignIn: () => void }) {
  // The cards (the board's own store: fast) show first; what else waits on you (Paperclip: slower) fills in after.
  // Both are kept in memory only; a card shown from an earlier visit can't be decided until the fresh copy lands.
  const approvalsQ = useQuery(QUERIES.approvals, onSignIn);
  const needsQ = useQuery(QUERIES.needsYou, onSignIn);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // A batch's cards that weren't decided, each with why: kept here, past the refresh that clears the selection.
  const [unbatched, setUnbatched] = useState<string[]>([]);
  const load = useCallback(async () => {
    await Promise.all([approvalsQ.reload(), needsQ.reload()]);
  }, [approvalsQ.reload, needsQ.reload]);
  // Live: refetched when a card is filed or decided anywhere (Telegram too); polled every 5s only without the stream.
  useLive(["approvals"], load, 5_000);
  const cards = approvalsQ.data?.approvals;
  const data = needsQ.data;
  const hold = approvalsQ.stale;
  const error = approvalsQ.error || needsQ.error;
  const all = cards ?? [];
  // Only Tier 2 waits for you; Tier 1 (with the reviewer) and Tier 0 runs (audit rows) are history lines.
  const pending = all.filter(forOwner);
  const reviewing = all.filter(withAI);
  // Everything else waiting on you (the server's needs-you: work handed to you); a task with
  // a Tier 2 card is already one of the cards above.
  const others = (data?.items ?? []).filter(onYouBeyondCards);
  const waitingCount = pending.length + others.length;
  const f: Filter = filter ?? (waitingCount ? "pending" : "all");
  const calls = all.filter(toolCall).length;
  const past = groups(all.filter((a) => !forOwner(a) && !withAI(a) && (showCalls || !toolCall(a))));
  const history = past.filter((g) => inFilter(g[0]!, f));
  const count = (k: Filter) => (k === "pending" ? waitingCount : k === "all" ? waitingCount + past.length : past.filter((g) => inFilter(g[0]!, k)).length);
  // The cards picked for a batch decision that still wait for you (a card decided elsewhere drops out of the selection).
  const chosen = pending.filter((a) => picked.includes(a.id));
  return (
    <main className="page wide approvals-page">
      <header className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="page-sub">
            {!cards ? "Checking what waits for you…" : waitingCount ? `${waitingCount} waiting for you` : !data && !needsQ.error ? "Checking what waits for you…" : "Nothing waiting for you"}
            <Updating on={hold || needsQ.stale} />
          </p>
        </div>
        <span className="spacer" />
        <div className="seg-tabs" role="tablist" aria-label="Show">
          {FILTERS.map(([k, name]) => (
            <button key={k} role="tab" aria-selected={f === k} className={f === k ? "on" : ""} onClick={() => setFilter(k)}>
              {name}
              <span className="seg-count">{count(k)}</span>
            </button>
          ))}
        </div>
      </header>
      {error && <div className="alert">{error}</div>}
      {unbatched.length > 0 && (
        <Banner tone="danger" action={<Button size="sm" variant="quiet" onClick={() => setUnbatched([])}>Dismiss</Button>}>
          Not decided: {unbatched.join("; ")}
        </Banner>
      )}
      {!cards ? (
        !error && <CardListSkeleton />
      ) : (
        <>
          {(f === "pending" || f === "all") && pending.length > 1 && (
            <div className="batch-select">
              <label className="approval-pick">
                <input type="checkbox" checked={chosen.length === pending.length} ref={(el) => void (el && (el.indeterminate = chosen.length > 0 && chosen.length < pending.length))} onChange={() => setPicked(chosen.length === pending.length ? [] : pending.map((a) => a.id))} />
                <span>{chosen.length ? `${chosen.length} of ${pending.length} selected` : `Select all ${pending.length}`}</span>
              </label>
              {chosen.length > 0 && <button className="link-btn small" onClick={() => setPicked([])}>Clear</button>}
            </div>
          )}
          {(f === "pending" || f === "all") && pending.length > 0 && (
            <ul className="approval-list pending-grid">
              {pending.map((a) => (
                <ApprovalCard key={a.id} a={a} open={open} pick={{ on: picked.includes(a.id), toggle: () => setPicked((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id])) }} />
              ))}
            </ul>
          )}
          {(f === "pending" || f === "all") && chosen.length > 0 && <BatchBar cards={chosen} done={(failed) => (setUnbatched(failed), setPicked([]), void load())} />}
          {(f === "pending" || f === "all") && others.length > 0 && (
            <section>
              <header className="section-head">
                <h2>Also waiting on you</h2>
                <span className="count">{others.length}</span>
              </header>
              <ul className="history">
                {others.map((i) => (
                  <li key={i.identifier}>
                    <button className="history-row" onClick={() => open(i.identifier)} title={`${i.identifier}: ${i.title}`}>
                      <span className="history-state wide">
                        <TaskState state={i.state} />
                      </span>
                      <span className="history-who">{i.agent}</span>
                      <span className="history-what">{i.title}</span>
                      <span className="history-target">{i.identifier}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(f === "pending" || f === "all") && !data && !needsQ.error && (
            <section aria-label="Also waiting on you">
              <SkeletonLines lines={2} />
            </section>
          )}
          {(f === "pending" || f === "all") && reviewing.length > 0 && (
            <section>
              <header className="section-head">
                <h2>AI reviewing</h2>
                <span className="count">{reviewing.length}</span>
              </header>
              <ul className="history">
                {reviewing.map((a) => (
                  <li key={a.id}>
                    <button className="history-row" onClick={() => open(a.identifier)} title={`${a.sentence}\n${a.target}`}>
                      <span className="history-state wide">
                        <StatusDot tone="working">AI reviewing</StatusDot>
                      </span>
                      <span className="history-who">{a.requestedBy}</span>
                      <span className="history-what">{a.sentence}</span>
                      <span className="history-target">{a.identifier}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {f === "pending" && data && !pending.length && !others.length && <p className="empty-state">You're all caught up. New requests from your agents show here and in Telegram.</p>}
          {f !== "pending" && (
            <section>
              <header className="section-head">
                <h2>History</h2>
                <span className="count">{history.length}</span>
                <span className="spacer" />
                {calls > 0 && (
                  <button className={`tag toggle${showCalls ? " on" : ""}`} aria-pressed={showCalls} onClick={() => setShowCalls(!showCalls)} title="Tool calls that ran at once (Tier 0), mostly task bookkeeping">
                    {showCalls ? "Hide" : "Show"} {calls} Tier 0 tool call{calls === 1 ? "" : "s"}
                  </button>
                )}
              </header>
              {history.length ? (
                <ul className="history">
                  {history.map((g) => (
                    <HistoryRow key={g[0]!.id} group={g} open={open} />
                  ))}
                </ul>
              ) : (
                <p className="empty-state">{f === "failed" ? "Nothing failed." : waitingCount ? "Nothing here yet." : "All clear. When a write needs your say, its card lands here."}</p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** One request in the history: its latest attempt in a line (earlier tries counted), the full cards a tap away. */
function HistoryRow({ group, open }: { group: Approval[]; open: (identifier: string) => void }) {
  const [shown, setShown] = useState(false);
  const a = group[0]!;
  const o = outcomeOf(a);
  return (
    <li className={shown ? "open" : ""}>
      <button className="history-row" aria-expanded={shown} onClick={() => setShown(!shown)} title={`${a.sentence}\n${a.target}`}>
        <span className="history-state">
          <span className={`run-status run-${o.tone}`}>{o.text}</span>
        </span>
        <span className="history-who">{a.requestedBy}</span>
        <span className="history-what">{a.sentence}</span>
        <span className="history-target">{a.target}</span>
        {group.length > 1 && <span className="recent-count" title="Earlier attempts at the same request">{group.length} tries</span>}
        <span className="time" title={new Date(a.createdAt).toLocaleString()}>{ago(a.createdAt)}</span>
      </button>
      {shown && (
        <ul className="approval-list history-cards">
          {group.map((x) => (
            <ApprovalCard key={x.id} a={x} open={open} unfold />
          ))}
        </ul>
      )}
    </li>
  );
}
