// "Explain this decision" on a write (a card, or a write in an agent's Activity): who decided, why, what was asked and
// what it would change, read on demand (src/explain.ts). The reviewer's note, the request and the diff are other people's
// text: plain text in fenced blocks, never markdown.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { SkeletonLines } from "./Skeleton";
import { Tag, type TagTone } from "./ui";
import type { DeciderKind, Explanation } from "../../src/explain";
import "./explain.css";

const WHO: Record<DeciderKind, { label: string; tone: TagTone }> = {
  code: { label: "Code rule", tone: "neutral" },
  reviewer: { label: "AI reviewer", tone: "accent" },
  owner: { label: "You", tone: "ok" },
  "pending-reviewer": { label: "AI reviewer (deciding)", tone: "needs" },
  "pending-owner": { label: "You (waiting)", tone: "needs" },
  none: { label: "Nobody", tone: "neutral" },
};

export function Explain({ id, onSignIn }: { id: string; onSignIn?: () => void }) {
  const [x, setX] = useState<Explanation | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.explain(id).then(
      (r) => live && setX(r.explanation),
      (e) => (e instanceof SignInRequired ? onSignIn?.() : live && setError((e as Error).message)),
    );
    return () => void (live = false);
  }, [id, onSignIn]);
  if (error) return <div className="xp"><p className="xp-note">Couldn't explain this: {error}</p></div>;
  if (!x) return <div className="xp" aria-busy="true"><SkeletonLines lines={4} /></div>;
  const who = WHO[x.decider.kind];
  return (
    <div className="xp" role="region" aria-label="Why this was decided">
      <div className="xp-who">
        <span className="xp-k">Decided by</span>
        <Tag tone={who.tone}>{who.label}</Tag>
        {x.decider.models.map((m) => <code key={m} className="xp-model" title={m}>{m.split("/").pop()}</code>)}
        {!["reviewer", "owner"].includes(x.decider.kind) && <span className="xp-words">{x.decider.words}</span>}
      </div>
      <ol className="xp-path" aria-label="What happened">
        {x.path.map((p, i) => <li key={i}>{p}</li>)}
      </ol>
      <div className="xp-grid">
        <section className="xp-block">
          <h5>Why this tier</h5>
          <p>
            <b>Tier {x.tier.tier}</b>
            {x.tier.merit != null && x.tier.merit !== x.tier.tier && <span className="muted"> (Tier {x.tier.merit} on its merits)</span>}
          </p>
          {x.tier.rule && (
            <p>
              <code className="xp-code">{x.tier.rule}</code> {x.tier.ruleWords ?? ""}
            </p>
          )}
          {x.tier.reason && <p className="muted">{x.tier.reason}</p>}
          {x.tier.cap && <p className="muted">{x.tier.cap}</p>}
          {!x.tier.rule && !x.tier.reason && !x.tier.cap && <p className="muted">Its kind's own tier; nothing raised it.</p>}
        </section>
        {x.review && (
          <section className="xp-block">
            <h5>Reviewer's note</h5>
            {x.review.code && (
              <p>
                <code className="xp-code">{x.review.code}</code> {x.review.codeWords ?? ""}
              </p>
            )}
            {x.review.note && <pre className="xp-fence" data-label="The reviewer's words">{x.review.note}</pre>}
          </section>
        )}
        {x.ownerReason && (
          <section className="xp-block">
            <h5>Your reason</h5>
            <pre className="xp-fence" data-label="Your words">{x.ownerReason}</pre>
          </section>
        )}
      </div>
      <section className="xp-block">
        <h5>What was asked <span className="muted">(the task as it reads now, as the reviewer reads it)</span></h5>
        {x.asked ? <pre className="xp-fence xp-scroll" data-label="The task's words">{x.asked}</pre> : <p className="muted">The task couldn't be read.</p>}
      </section>
      <section className="xp-block">
        <h5>What it would change</h5>
        {x.changes && <pre className="xp-fence" data-label="The card">{x.changes}</pre>}
        {x.details && (
          <details className="xp-diff">
            <summary>The whole change</summary>
            <pre className="xp-fence xp-scroll" data-label="The change">{x.details}</pre>
          </details>
        )}
        {!x.changes && !x.details && <p className="muted">The card names no change.</p>}
      </section>
    </div>
  );
}
