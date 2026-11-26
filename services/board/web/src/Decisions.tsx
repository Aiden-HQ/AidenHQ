// Insight › Decisions (#/insight/decisions): every write record's history. What waits on the AI reviewer, what was decided
// and what failed, live claimed records with their wait, Tier 0 tool calls behind a toggle, each row opening its full
// cards. What waits for the owner is on Home (Needs you), never here.
import { useState, type ReactNode } from "react";
import { ApprovalCard, forOwner, withAI } from "./ApprovalCard";
import { useLive } from "./events";
import { QUERIES, useQuery } from "./queries";
import { inFilter, outcomeOf, type ApprovalFilter } from "./conversation";
import { CardListSkeleton, Updating } from "./Skeleton";
import type { Approval } from "./types";
import { StatusDot } from "./ui/StatusDot";
import { ago } from "./util";

const toolCall = (a: Approval) => a.state === "auto" && a.action.includes(".");
const FILTERS: [ApprovalFilter, string][] = [["pending", "Pending"], ["done", "Done"], ["failed", "Failed"], ["all", "All"]];
const open = (identifier: string) => (location.hash = `#/t/${identifier}`);

/** Retries of one request (same chat, action and target) as one group, newest first. */
function groups(list: Approval[]): Approval[][] {
  const by = new Map<string, Approval[]>();
  for (const a of [...list].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const k = `${a.identifier}|${a.action}|${a.target}`;
    by.set(k, [...(by.get(k) ?? []), a]);
  }
  return [...by.values()];
}

export function DecisionsView({ onSignIn }: { onSignIn: () => void }) {
  const approvalsQ = useQuery(QUERIES.approvals, onSignIn);
  const [filter, setFilter] = useState<ApprovalFilter | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  // Live: refetched when a card is filed or decided anywhere (Telegram too); polled every 5s only without the stream.
  useLive(["approvals"], approvalsQ.reload, 5_000);
  const cards = approvalsQ.data?.approvals;
  const all = (cards ?? []).filter((a) => !forOwner(a));
  const reviewing = all.filter(withAI);
  const f: ApprovalFilter = filter ?? (reviewing.length ? "pending" : "all");
  const calls = all.filter(toolCall).length;
  const past = groups(all.filter((a) => !withAI(a) && (showCalls || !toolCall(a))));
  const history = past.filter((g) => inFilter(g[0]!, f));
  const count = (k: ApprovalFilter) => (k === "pending" ? reviewing.length : k === "all" ? reviewing.length + past.length : past.filter((g) => inFilter(g[0]!, k)).length);
  return (
    <main className="page wide approvals-page">
      <header className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="page-sub">
            Every write your agents asked for, and who decided it. What waits for you is on <a href="#/">Home</a>.
            <Updating on={approvalsQ.stale} />
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
      {approvalsQ.error && <div className="alert">{approvalsQ.error}</div>}
      {!cards ? (
        !approvalsQ.error && <CardListSkeleton />
      ) : (
        <>
          {(f === "pending" || f === "all") && reviewing.length > 0 && (
            <section>
              <header className="section-head">
                <h2>AI reviewing</h2>
                <span className="count">{reviewing.length}</span>
              </header>
              <ul className="history">
                {reviewing.map((a) => (
                  <HistoryRow key={a.id} group={[a]} state={<span className="history-state wide"><StatusDot tone="working">AI reviewing</StatusDot></span>} />
                ))}
              </ul>
            </section>
          )}
          {f === "pending" && !reviewing.length && <p className="empty-state">Nothing waits on the AI reviewer.</p>}
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
                    <HistoryRow key={g[0]!.id} group={g} />
                  ))}
                </ul>
              ) : (
                <p className="empty-state">{f === "failed" ? "Nothing failed." : "All clear. When an agent asks to write something, its record lands here."}</p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** One request in the history (or under AI reviewing, with its `state`): its latest attempt in a line (earlier tries counted), the full cards a tap away. */
function HistoryRow({ group, state }: { group: Approval[]; state?: ReactNode }) {
  const [shown, setShown] = useState(false);
  const a = group[0]!;
  const o = outcomeOf(a);
  return (
    <li className={shown ? "open" : ""}>
      <button className="history-row" aria-expanded={shown} onClick={() => setShown(!shown)} title={`${a.sentence}\n${a.target}`}>
        {state ?? (
          <span className="history-state">
            <span className={`run-status run-${o.tone}`}>{o.text}</span>
          </span>
        )}
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
