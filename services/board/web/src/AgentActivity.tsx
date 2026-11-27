// The agent page's Activity tab: what the agent did, newest first. Each job with what woke it and its task, how it ended
// (an error as plain text), what it cost and the writes it filed (each with Explain); its steps load when opened. Reads:
// src/timeline.ts (one kernel read); the steps are the run page's (GET /api/runs/:id). Agent text is never rendered as markdown.
import { useState } from "react";
import { SignInRequired, api } from "./api";
import { Explain } from "./Explain";
import { agentTimelineQuery, useQuery } from "./queries";
import { SkeletonLines } from "./Skeleton";
import type { RunTrace } from "./types";
import { EmptyState, Section, StatusDot, Tag, type StatusTone, type TagTone } from "./ui";
import type { TimelineEntry, TimelineWrite } from "../../src/timeline";
import { clockOpts, stampOpts } from "./util";

const TONE: Record<TimelineEntry["outcome"], { tone: StatusTone; word: string }> = {
  running: { tone: "working", word: "Running" },
  done: { tone: "done", word: "Done" },
  failed: { tone: "failed", word: "Failed" },
  stopped: { tone: "idle", word: "Stopped" },
};
const ENDED: Record<string, string> = { timeout: "Timed out", lost: "Lost" };
const WRITE_TONE: Record<TimelineWrite["state"], TagTone> = { pending: "needs", approved: "accent", ran: "ok", failed: "failed", rejected: "failed", closed: "neutral" };
const WRITE_WORD: Record<TimelineWrite["state"], string> = { pending: "pending", approved: "approved", ran: "ran", failed: "failed", rejected: "rejected", closed: "closed" };

export const usd = (n: number | null) => (n == null ? "—" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const dur = (a: string | null, b: string | null) => {
  const ms = a ? Date.parse(b ?? new Date().toISOString()) - Date.parse(a) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
};
const dayOf = (iso: string | null) => {
  if (!iso) return "Not started";
  const d = new Date(iso), today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};

export function AgentActivity({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const { data, error } = useQuery(agentTimelineQuery(agentKey), onSignIn);
  const info = "Its last 50 runs: what woke it, how each ended, what it cost and the writes it asked for.";
  if (!data) return <Section title="Activity" info={info}>{error ? <EmptyState>Couldn't load the activity: {error}</EmptyState> : <SkeletonLines lines={6} />}</Section>;
  if (!data.length) return <Section title="Activity" info={info}><EmptyState>No runs yet. Each time it wakes up, the run shows up here.</EmptyState></Section>;
  const spent = data.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const failed = data.filter((e) => e.outcome === "failed").length;
  const writes = data.reduce((s, e) => s + e.writes.length, 0);
  const days: [string, TimelineEntry[]][] = [];
  for (const e of data) {
    const d = dayOf(e.startedAt);
    if (days.at(-1)?.[0] === d) days.at(-1)![1].push(e);
    else days.push([d, [e]]);
  }
  return (
    <Section title="Activity" count={data.length} info={info} hint={<span className="tl-sum">{usd(spent)} spent · {writes} write{writes === 1 ? "" : "s"} · {failed} failed</span>}>
      <div className="tl">
        {days.map(([day, list]) => (
          <section key={day} className="tl-day" aria-label={day}>
            <h3 className="tl-day-head">{day}</h3>
            <ol className="tl-list">
              {list.map((e) => <Entry key={e.id} e={e} onSignIn={onSignIn} />)}
            </ol>
          </section>
        ))}
      </div>
    </Section>
  );
}

function Entry({ e, onSignIn }: { e: TimelineEntry; onSignIn: () => void }) {
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<RunTrace | null>(null);
  const [err, setErr] = useState("");
  const s = TONE[e.outcome];
  const toggle = () => {
    setOpen(!open);
    if (!open && !run) api.run(e.id).then(setRun, (x) => (x instanceof SignInRequired ? onSignIn() : setErr((x as Error).message)));
  };
  const task = e.task.title ?? e.task.identifier ?? "a task";
  return (
    <li className={`tl-item tl-${e.outcome}`}>
      <span className="tl-node" aria-hidden />
      <div className="tl-card">
        <div className="tl-head">
          <time className="tl-time" dateTime={e.startedAt ?? undefined} title={e.startedAt ? new Date(e.startedAt).toLocaleString(undefined, stampOpts()) : undefined}>
            {e.startedAt ? new Date(e.startedAt).toLocaleTimeString(undefined, { ...clockOpts() }) : "—"}
          </time>
          <StatusDot tone={s.tone}>{ENDED[e.state] ?? s.word}</StatusDot>
          <span className="tl-trigger">{e.trigger}</span>
          <span className="tl-arrow" aria-hidden>→</span>
          {e.task.identifier ? (
            <a className="tl-task" href={`#/t/${e.task.identifier}`} title={task}>{task}</a>
          ) : (
            <span className="tl-task">{task}</span>
          )}
          <span className="tl-meta">
            {e.task.identifier && e.task.title && <span className="tl-id">{e.task.identifier}</span>}
            <span title="How long it ran">{dur(e.startedAt, e.endedAt)}</span>
            <span title={e.costUsd == null ? (e.outcome === "running" ? "Billed when it ends" : "Not known") : "What the model gateway billed for this run"} className="tl-cost">{usd(e.costUsd)}</span>
          </span>
        </div>
        {e.error && <pre className={`tl-error${e.outcome === "stopped" ? " tl-stopped" : ""}`} aria-label="How it ended (the agent's words)">{e.error}</pre>}
        {e.writes.length > 0 && (
          <ul className="tl-writes" aria-label="Writes it asked for">
            {e.writes.map((w) => <Write key={w.id} w={w} />)}
          </ul>
        )}
        <div className="tl-foot">
          <button className="link-btn small" onClick={toggle} aria-expanded={open}>{open ? "Hide steps" : `${e.steps} step${e.steps === 1 ? "" : "s"}`}</button>
          <a className="link-btn small" href={`#/r/${e.id}`}>Open run</a>
        </div>
        {open && (
          <div className="tl-steps">
            {err ? <p className="muted small">Couldn't load the steps: {err}</p> : !run ? <SkeletonLines lines={3} /> : run.timeline.length ? (
              <ol>
                {run.timeline.map((x, i) => (
                  <li key={i} className={x.ok ? "" : "bad"}>
                    <time>{x.at ? new Date(x.at).toLocaleTimeString(undefined, { ...clockOpts(), second: "2-digit" }) : ""}</time>
                    <span className="tl-step">{x.text}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="muted small">No steps reported.</p>}
          </div>
        )}
      </div>
    </li>
  );
}

function Write({ w }: { w: TimelineWrite }) {
  const [shown, setShown] = useState(false);
  return (
    <li className="tl-write">
      <div className="tl-write-row">
        <Tag>{w.action}</Tag>
        <span className="tl-write-tier">Tier {w.tier}</span>
        <Tag tone={WRITE_TONE[w.state]}>{WRITE_WORD[w.state]}</Tag>
        <span className="tl-write-by">{w.decidedBy ? `by ${w.decidedBy}` : w.tier === 0 ? "ran at once" : ""}</span>
        <button className="link-btn small" onClick={() => setShown(!shown)} aria-expanded={shown}>{shown ? "Hide" : "Explain"}</button>
      </div>
      {shown && <Explain id={w.id} />}
    </li>
  );
}
