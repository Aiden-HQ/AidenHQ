// An approval card (the exact request, its outcome on the same card), its Approve and Reject, and the batch bar for
// several cards picked on Home's Needs you. Shown on Home, in chats, in the lineage list and on Insight › Decisions.
import { useState } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";
import { deciderOf, headOf, foldsInChat, outcomeOf } from "./conversation";
import { Explain } from "./Explain";
import type { Approval } from "./types";
import { Button, Input } from "./ui";
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
export const TIER_WORDS = ["Tier 0: ran at once", "Tier 1: the AI reviewer decides", "Tier 2: yours to decide"];
/** Waiting for the owner: a pending Tier 2 card. A pending Tier 1 card is with the AI reviewer. */
export const forOwner = (a: Approval) => a.state === "pending" && a.tier === 2;
/** A card the AI reviewer has not decided yet (Tier 1): in progress, not waiting on the owner. */
export const withAI = (a: Approval) => a.state === "pending" && !forOwner(a);

/**
 * A pending Tier 2 card's Approve and Reject (a reason is optional with a reject: the agent is told). The board forwards the
 * signed-in admin's session; the kernel checks it and decides against the digest this card shows, so a card that changed
 * meanwhile fails alone and says so. A decision sent stays sent: the buttons come back only if it failed.
 */
export function Decide({ a, hold, size, onDecided }: { a: Approval; hold?: boolean; size?: "sm"; /** Called once the decision is in (Home collapses the row to a receipt). */ onDecided?: (d: "approve" | "reject") => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    setError(null);
    try {
      await api.decide(a.id, a.digest, d, d === "reject" ? reason.trim() || undefined : undefined);
      onDecided?.(d);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const off = busy !== null || Boolean(hold);
  return (
    <div className="approval-decide" title={hold ? "Refreshing this card: it can be decided once the fresh copy lands" : undefined}>
      {rejecting ? (
        <form className="approval-actions" onSubmit={(e) => (e.preventDefault(), void decide("reject"))}>
          <Input className="decide-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why not? (optional, the agent is told)" aria-label="Reason for rejecting" autoFocus />
          <Button type="submit" variant="danger" disabled={off}>{busy === "reject" ? "Rejecting…" : "Reject"}</Button>
          <Button variant="quiet" onClick={() => setRejecting(false)} disabled={busy !== null}>Cancel</Button>
        </form>
      ) : (
        <div className="approval-actions">
          <Button size={size} variant="primary" className="approve" onClick={() => void decide("approve")} disabled={off}>{busy === "approve" ? "Approving…" : "Approve"}</Button>
          <Button size={size} onClick={() => setRejecting(true)} disabled={off}>Reject…</Button>
        </div>
      )}
      {error && <p className="decide-error" role="alert" title={error}>{error}</p>}
    </div>
  );
}

/**
 * The batch bar for the cards picked on Home's Needs you: Approve n, or Reject n with one reason. Each card is decided on its
 * own against the digest it showed (as a single card is), so one that changed meanwhile fails alone and is named here.
 */
export function BatchBar({ cards, done, busy, setBusy, hold }: { cards: Approval[]; /** The cards not decided (each card's id, and why), once the batch has run. */ done: (failed: { id: string; why: string }[]) => void; /** The running batch's decision: the list holds it, so hiding the bar never unlocks a batch still running. */ busy: "approve" | "reject" | null; setBusy: (b: "approve" | "reject" | null) => void; /** The cards are an earlier visit's copy: nothing is decided until the fresh one lands. */ hold: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const n = cards.length;
  const off = busy !== null || hold;
  const decide = async (d: "approve" | "reject") => {
    setBusy(d);
    const bad: { id: string; why: string }[] = [];
    for (const a of cards) {
      try {
        await api.decide(a.id, a.digest, d, d === "reject" ? reason.trim() || undefined : undefined);
      } catch (e) {
        bad.push({ id: a.id, why: `${a.identifier}: ${(e as Error).message}` });
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
          <Button type="submit" variant="danger" disabled={off}>{busy === "reject" ? "Rejecting…" : `Reject ${n}`}</Button>
          <Button variant="quiet" onClick={() => setRejecting(false)} disabled={busy !== null}>Cancel</Button>
        </form>
      ) : (
        <div className="batch-actions">
          <Button onClick={() => setRejecting(true)} disabled={off}>Reject {n}…</Button>
          <Button variant="primary" onClick={() => void decide("approve")} disabled={off}>{busy === "approve" ? "Approving…" : `Approve ${n}`}</Button>
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
export function ApprovalCard({ a, open, inline, prefix = "", unfold, pick, hold }: { a: Approval; open: (identifier: string) => void; inline?: boolean; prefix?: string; unfold?: boolean; /** On the Approvals list: the card's box in a batch decision. */ pick?: { on: boolean; toggle: () => void }; /** The card is an earlier visit's cached copy: it can't be decided until the fresh one lands. */ hold?: boolean }) {
  const [unfolded, setUnfolded] = useState(Boolean(unfold));
  // In a conversation a decided card is one line; one decided while on screen stays open.
  const [seenPending] = useState(a.state === "pending");
  const [shown, setShown] = useState(false);
  const [explained, setExplained] = useState(false);
  const by = deciderOf(a);
  if (inline && !shown && foldsInChat(a, seenPending)) {
    const o = outcomeOf(a);
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
  const buttons = forOwner(a) && <Decide a={a} hold={hold} />;
  const label = a.outcome === "applied" ? "Applied." : a.outcome === "failed" ? "Failed:" : OUTCOME[a.state];
  const text = a.outcome === "applied" ? (a.outcomeText ?? "") : a.outcome === "failed" ? (a.outcomeText ?? "no reason given") : a.state === "running" ? (a.wait ?? "") : "";
  return (
    <li className={`approval-card ap-${a.outcome ?? a.state}${inline ? " inline" : ""}${pick?.on ? " picked" : ""}`}>
      <div className="approval-head">
        {pick && (
          <label className="approval-pick" title="Select for a batch decision">
            <input type="checkbox" checked={pick.on} onChange={pick.toggle} disabled={hold} aria-label={`Select ${a.identifier}: ${a.sentence}`} />
          </label>
        )}
        <button className="chat-open" onClick={() => open(a.identifier)}>
          <span className="chat-agent">{a.requestedBy}</span>
          <span className="chat-title">{inline ? headOf(a) : "Open the chat"}</span>
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
        <dt>Tier</dt>
        <dd>
          {TIER_WORDS[a.tier] ?? `Tier ${a.tier}`}
          {a.reason && <span className="muted"> ({a.reason})</span>}
          {a.baseTier != null && a.baseTier < a.tier && <span className="muted"> · Tier {a.baseTier} on its merits</span>}
        </dd>
        {by && (
          <>
            <dt>Decided by</dt>
            <dd>{by}</dd>
          </>
        )}
        {a.review && (
          <>
            <dt>Reviewer's note</dt>
            <dd className="pre">
              {a.reviewCode === "reviewer_unsure" && <strong>{a.state === "rejected" ? "Two reviewers weren't sure, so it went back to the agent: " : "The reviewer wasn't sure, so it's yours: "}</strong>}
              {a.review}
            </dd>
          </>
        )}
      </dl>
      {a.replaced && a.state === "pending" && <p className="muted small">This replaces an earlier request in this chat.</p>}
      <details className="approval-more">
        <summary>Details</summary>
        <dl className="approval-facts">
          <dt>Exact request</dt>
          <dd className="mono">{a.digest.slice(0, 12)}</dd>
          {a.reasonCode && (
            <>
              <dt>Tier reason</dt>
              <dd className="mono">{a.reasonCode}</dd>
            </>
          )}
          {a.reviewCode && (
            <>
              <dt>Review code</dt>
              <dd className="mono">{a.reviewCode}</dd>
            </>
          )}
        </dl>
        {a.details && <pre className="approval-details">{a.details}</pre>}
      </details>
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

