import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { SkeletonLines } from "./Skeleton";
import type { RunTrace } from "./types";
import { ago, clockOpts, stampOpts } from "./util";

const dur = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const tok = (n: number | null | undefined) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n: number | null) => (n == null ? "—" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/**
 * One run (a kernel job) as a trace (a drawer at #/r/<job id>): its plan, the steps it reported and its last words, why it
 * ended, its tokens, the usage ledger's rows with cost against the run cap, and the rev with its product and instance shas.
 * Everything the agent produced is shown as plain text (never through the markdown renderer).
 */
export function RunPage({ id, onClose, onSignIn }: { id: string; onClose: () => void; onSignIn: () => void }) {
  const [run, setRun] = useState<RunTrace | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.run(id).then(
      (r) => live && setRun(r),
      (e) => (e instanceof SignInRequired ? onSignIn() : live && setError(e.message)),
    );
    return () => void (live = false);
  }, [id, onSignIn]);
  return (
    <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer run-page" role="dialog" aria-label="Run">
        <header className="drawer-head">
          <span className="ident">{run ? `${run.agent} · ${run.engine} · ${run.status}` : "Run"}</span>
          {run?.issue && <a href={`#/t/${run.issue.identifier}`} className="run-task">{run.issue.identifier}</a>}
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="drawer-scroll">
          {error && <p className="run-note">{error}</p>}
          {!run && !error && <SkeletonLines lines={6} />}
          {run && (
            <>
              <dl className="run-facts">
                <dt>Started</dt><dd>{run.startedAt ? `${new Date(run.startedAt).toLocaleString(undefined, stampOpts())} (${ago(run.startedAt)} ago)` : "—"}</dd>
                <dt>Duration</dt><dd>{dur(run.durationMs)}</dd>
                <dt>Rev</dt>
                <dd>{run.rev ? <code>{run.rev.rev}</code> : "—"}{run.rev && <span className="faint"> product {run.rev.productSha?.slice(0, 7) ?? "?"} · instance {run.rev.instanceSha?.slice(0, 7) ?? "?"}{run.rev.from === "revs" ? " (latest before the start)" : ""}</span>}</dd>
                <dt>Tokens</dt>
                <dd>{run.tokens ? `${tok(run.tokens.input)} in (${tok(run.tokens.cached)} cached) · ${tok(run.tokens.output)} out` : "—"}</dd>
                <dt>Cost</dt>
                <dd>{usd(run.ledger.usd)}{!run.ledger.rows.length && <span className="faint"> (no ledger rows for this run)</span>}</dd>
              </dl>
              {run.error && <p className="run-note bad">{run.error}</p>}
              {run.plan.length > 0 && (
                <section>
                  <h4>Plan</h4>
                  <ol className="run-timeline">
                    {run.plan.map((p, i) => (
                      <li key={i} className={p.state === "done" ? "faint" : ""}>
                        <span className="run-name">{p.state}</span>
                        <span className="run-text">{p.text}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section>
                <h4>Timeline</h4>
                {run.timeline.length ? (
                  <ol className="run-timeline">
                    {run.timeline.map((e, i) => (
                      <li key={i} className={e.ok ? "" : "bad"}>
                        <time>{e.at ? new Date(e.at).toLocaleTimeString(undefined, { ...clockOpts(), second: "2-digit" }) : ""}</time>
                        <span className="run-name">{e.kind}</span>
                        <span className="run-text">{e.text}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="run-note">No steps reported.</p>
                )}
              </section>
              {run.ledger.rows.length > 0 && (
                <section>
                  <h4>Model calls (usage ledger)</h4>
                  <table className="run-table">
                    <tbody>
                      {run.ledger.rows.map((r, i) => (
                        <tr key={i} className={r.status && r.status !== "ok" ? "bad" : ""}>
                          <td>{r.kind ?? r.model}</td><td>{r.model.split("/").pop()}</td><td>{tok(r.input + r.cached)} in</td><td>{tok(r.output)} out</td><td>{usd(r.costUsd)}</td><td>{r.ms != null ? dur(r.ms) : ""}</td><td>{r.status && r.status !== "ok" ? r.status : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
