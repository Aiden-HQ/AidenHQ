import { useCallback, useState } from "react";
import { api } from "./api";
import { useLive } from "./events";
import { Markdown } from "./markdown";
import { QUERIES, useQuery } from "./queries";
import { deciderOf, foldsInChat, outcomeOf, shownDecision } from "./conversation";
import { CardListSkeleton, SkeletonLines, Updating } from "./Skeleton";
import type { Approval, ChatState } from "./types";
import { ago } from "./util";

const STATE_CLASS: Record<ChatState, string> = {
  working: "st-working",
  queued: "st-queued",
  "waiting for you": "st-you",
  "waiting for approval": "st-you",
  "in review": "st-queued",
  done: "st-done",
  failed: "st-failed",
  idle: "st-done",
};

export function StateChip({ state, reason }: { state: ChatState; reason?: string }) {
  return (
    <span className={`state-chip ${STATE_CLASS[state]}`} title={reason ?? state}>
      {state}
      {reason ? `: ${reason}` : ""}
    </span>
  );
}

const OUTCOME: Record<Approval["state"], string> = {
  pending: "",
  approved: "Approved: applying…",
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
/** The most cards one batch decides (the board refuses more). */
const BATCH_MAX = 10;

/**
 * One approval card: one sentence, what it reads and changes, the cost, Details, Approve / Reject; the outcome stays here.
 * An expired card (timed out or replaced by a newer request) folds to one muted line; a tap shows it whole.
 */
export function ApprovalCard({ a: card, open, decided, inline, prefix = "", unfold, pick, hold }: { a: Approval; open: (identifier: string) => void; decided: () => Promise<void>; inline?: boolean; prefix?: string; unfold?: boolean; pick?: { on: boolean; full: boolean; toggle: () => void }; hold?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unfolded, setUnfolded] = useState(Boolean(unfold));
  // A tap shows at once (shownDecision); refused, the card goes back to pending with the reason.
  const [tapped, setTapped] = useState<"approve" | "reject" | null>(null);
  const a = shownDecision(card, tapped);
  // In a conversation a decided card is one line; one decided while on screen stays open (it doesn't jump under the tap).
  const [seenPending] = useState(a.state === "pending");
  const [shown, setShown] = useState(false);
  const act = async (d: "approve" | "reject") => {
    setBusy(true);
    setTapped(d);
    setError("");
    await api.decide(a.id, d).then(decided, (e: Error) => (setTapped(null), setError(e.message)));
    setBusy(false);
  };
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
  // `hold`: this card is an earlier copy while the current one loads; it's decided on fresh server state only.
  const why = hold ? "Checking it hasn't changed…" : undefined;
  const buttons = (
    <div className="approval-actions">
      <button className="btn" disabled={busy || hold} title={why} onClick={() => void act("reject")}>
        Reject
      </button>
      <button className="btn primary approve" disabled={busy || hold} title={why} onClick={() => void act("approve")}>
        Approve
      </button>
    </div>
  );
  const top = !inline && forOwner(a);
  const label = a.outcome === "applied" ? "Applied." : a.outcome === "failed" ? "Failed:" : OUTCOME[a.state];
  const text = a.outcome === "applied" ? (a.outcomeText ?? "") : a.outcome === "failed" ? (a.outcomeText ?? "no reason given") : "";
  return (
    <li className={`approval-card ap-${a.outcome ?? a.state}${inline ? " inline" : ""}`}>
      <div className="approval-head">
        {pick && <input type="checkbox" className="approval-pick" aria-label={`Select ${a.id}`} checked={pick.on} disabled={!pick.on && pick.full} onChange={pick.toggle} />}
        <button className="chat-open" onClick={() => open(a.identifier)}>
          <span className="chat-agent">{a.requestedBy}</span>
          <span className="chat-title">{!inline ? "Open the chat" : a.state === "auto" ? "ran it at once (Tier 0)" : a.tier === 1 && a.state === "pending" ? "asks the AI reviewer" : "asks for your approval"}</span>
        </button>
        <span className="muted small">{a.id}</span>
        {inline && shown && (
          <button className="link-btn small" onClick={() => setShown(false)} aria-label="Fold this card to one line">
            Fold
          </button>
        )}
        {top && buttons}
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
      {a.state === "pending" ? (
        !top && <div className="row-end">{buttons}</div>
      ) : (
        <div className={`approval-outcome ${a.outcome === "failed" || a.state === "unknown" ? "bad" : ""}`}>
          {label && <b>{label}</b>}
          {a.decidedByName && <span className="by">by {a.decidedByName}</span>}
          {text &&<Markdown text={text} prefix={prefix} />}
        </div>
      )}
      {error && <div className="alert">{error}</div>}
    </li>
  );
}

type Filter = "pending" | "done" | "failed" | "all";
const FILTERS: [Filter, string][] = [["pending", "Pending"], ["done", "Done"], ["failed", "Failed"], ["all", "All"]];
const inFilter = (a: Approval, f: Filter) => f === "all" || (f === "pending" ? forOwner(a) : f === "failed" ? outcomeOf(a).tone === "bad" : !forOwner(a) && outcomeOf(a).tone !== "bad");

/** Retries of one request (same chat, action and target) as one group, newest first. */
function groups(list: Approval[]): Approval[][] {
  const by = new Map<string, Approval[]>();
  for (const a of [...list].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const k = `${a.identifier}|${a.action}|${a.target}`;
    by.set(k, [...(by.get(k) ?? []), a]);
  }
  return [...by.values()];
}

/** Approvals: what waits for you first, big; then the history as one line per request, open to the full card. */
export function ApprovalsView({ open, onSignIn }: { open: (identifier: string) => void; onSignIn: () => void }) {
  // The cards (the board's own store: fast) show first; what else waits on you (Paperclip: slower) fills in after.
  // Both are kept in memory only; a card shown from an earlier visit can't be decided until the fresh copy lands.
  const approvalsQ = useQuery(QUERIES.approvals, onSignIn);
  const needsQ = useQuery(QUERIES.needsYou, onSignIn);
  const [filter, setFilter] = useState<Filter | null>(null);
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
  // Batch: the cards ticked, as shown (id → digest); a card that changed or left drops out of the selection.
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [batchBusy, setBatchBusy] = useState(false);
  // Kept apart from the view's error, which each refetch clears: why a batch was refused stays until the next batch.
  const [batchError, setBatchError] = useState("");
  const chosen = pending.filter((a) => picked.get(a.id) === a.digest);
  const full = chosen.length >= BATCH_MAX;
  const toggle = (a: Approval) => setPicked((p) => {
    const next = new Map(p);
    if (next.get(a.id) === a.digest) next.delete(a.id);
    else next.set(a.id, a.digest);
    return next;
  });
  const pickAll = () => setPicked(chosen.length ? new Map() : new Map(pending.slice(0, BATCH_MAX).map((a) => [a.id, a.digest])));
  const decideChosen = async (d: "approve" | "reject") => {
    if (!window.confirm(`${d === "approve" ? "Approve" : "Reject"} these ${chosen.length} requests?\n\n${chosen.map((a) => `• ${a.identifier}: ${a.sentence}`).join("\n")}`)) return;
    setBatchBusy(true);
    setBatchError("");
    await api.decideBatch(chosen.map((a) => ({ id: a.id, digest: a.digest })), d).then(() => setPicked(new Map()), (e: Error) => setBatchError(e.message));
    setBatchBusy(false);
    await load();
  };
  const f: Filter = filter ?? (pending.length ? "pending" : "all");
  const others = (data?.items ?? []).filter((i) => i.state !== "waiting for approval");
  const past = groups(all.filter((a) => !forOwner(a)));
  const history = past.filter((g) => inFilter(g[0]!, f));
  const count = (k: Filter) => (k === "pending" ? pending.length : k === "all" ? pending.length + past.length : past.filter((g) => inFilter(g[0]!, k)).length);
  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="page-sub">
            {!cards ? "Checking what waits for you…" : pending.length ? `${pending.length} waiting for you` : "Nothing waiting for you"}
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
      {!cards ? (
        !error && <CardListSkeleton />
      ) : (
        <>
          {(f === "pending" || f === "all") && pending.length > 1 && (
            <div className="batch-bar">
              <label>
                <input type="checkbox" checked={chosen.length > 0} onChange={pickAll} /> {chosen.length ? `${chosen.length} selected` : `Select ${pending.length > BATCH_MAX ? `the first ${BATCH_MAX}` : "all"}`}
              </label>
              <span className="muted small">All or nothing: if any changed since you saw it, nothing is decided.</span>
              <span className="spacer" />
              <button className="btn" disabled={!chosen.length || batchBusy || hold} onClick={() => void decideChosen("reject")}>
                Reject selected
              </button>
              <button className="btn primary approve" disabled={!chosen.length || batchBusy || hold} onClick={() => void decideChosen("approve")}>
                Approve selected
              </button>
            </div>
          )}
          {batchError && <div className="alert">{batchError}</div>}
          {(f === "pending" || f === "all") && pending.length > 0 && (
            <ul className="approval-list pending-grid">
              {pending.map((a) => (
                <ApprovalCard key={a.id} a={a} open={open} decided={load} hold={hold} pick={pending.length > 1 ? { on: picked.get(a.id) === a.digest, full, toggle: () => toggle(a) } : undefined} />
              ))}
            </ul>
          )}
          {(f === "pending" || f === "all") && others.length > 0 && (
            <section>
              <header className="section-head">
                <h2>Also waiting on you</h2>
                <span className="count">{others.length}</span>
              </header>
              <ul className="history">
                {others.map((i) => (
                  <li key={i.identifier}>
                    <button className="history-row" onClick={() => open(i.identifier)}>
                      <StateChip state={i.state} reason={i.reason} />
                      <span className="history-who">{i.agent}</span>
                      <span className="history-what">{i.title}</span>
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
          {f === "pending" && data && !pending.length && !others.length && <p className="empty-state">You're all caught up. New requests from your agents show here and in Telegram.</p>}
          {f !== "pending" && (
            <section>
              <header className="section-head">
                <h2>History</h2>
                <span className="count">{history.length}</span>
              </header>
              {history.length ? (
                <ul className="history">
                  {history.map((g) => (
                    <HistoryRow key={g[0]!.id} group={g} open={open} decided={load} />
                  ))}
                </ul>
              ) : (
                <p className="empty-state">Nothing here yet.</p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** One request in the history: its latest attempt in a line (earlier tries counted), the full cards a tap away. */
function HistoryRow({ group, open, decided }: { group: Approval[]; open: (identifier: string) => void; decided: () => Promise<void> }) {
  const [shown, setShown] = useState(false);
  const a = group[0]!;
  const o = outcomeOf(a);
  return (
    <li className={shown ? "open" : ""}>
      <button className="history-row" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <span className={`run-status run-${o.tone}`}>{o.text}</span>
        <span className="history-who">{a.requestedBy}</span>
        <span className="history-what">{a.sentence}</span>
        <span className="history-target">{a.target}</span>
        {group.length > 1 && <span className="recent-count" title="Earlier attempts at the same request">{group.length} tries</span>}
        <span className="time">{ago(a.createdAt)}</span>
      </button>
      {shown && (
        <ul className="approval-list history-cards">
          {group.map((x) => (
            <ApprovalCard key={x.id} a={x} open={open} decided={decided} unfold />
          ))}
        </ul>
      )}
    </li>
  );
}
