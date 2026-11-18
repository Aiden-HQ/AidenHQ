// An agent's page (#/agents/<key>/<tab>): who it is and what it is doing, what waits on you, its tasks (each opens its
// thread), its week, its general chats and its settings. Reads: agent-page.ts; writes: the settings editor's (SettingsAgents AgentDetails).
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { load } from "./cache";
import { agentOpenQuery, agentProfileQuery, QUERIES, scorecardQuery, useQuery } from "./queries";
import { AgentHandbook } from "./AgentHandbook";
import { AgentSettings } from "./AgentSettings";
import { SkeletonLines } from "./Skeleton";
import type { AgentProfile, Scorecard, TaskRow } from "./types";
import { ago, agoLabel } from "./util";
import { EmptyState } from "./ui/EmptyState";
import { hueClass } from "./ui/hue";
import { ListRow, ListRows } from "./ui/ListRow";
import { Menu } from "./ui/Menu";
import { PageHeader } from "./ui/PageHeader";
import { Section } from "./ui/Section";
import { Segmented } from "./ui/Segmented";
import { StatBlock } from "./ui/StatBlock";
import { StatusDot } from "./ui/StatusDot";
import "./settings.css";
import "./ui/ui.css";
import "./agent-page.css";

export type AgentTab = "overview" | "chats" | "handbook" | "settings";
const TABS: [AgentTab, string][] = [["overview", "Overview"], ["chats", "Chats"], ["handbook", "Handbook"], ["settings", "Settings"]];

/** When the agent last finished a task (the newest done task), for the idle status line. */
const lastDoneQuery = (key: string) => ({ key: `agents.${key}.last-done`, fetch: () => api.agentHistory(key, { status: "done" }).then((r) => r.rows.reduce<string | null>((a, x) => (!a || x.updatedAt > a ? x.updatedAt : a), null)), persist: false as const });

export function AgentPage({ agentKey, tab, go, onSignIn }: { agentKey: string; tab: AgentTab; go: (hash: string) => void; onSignIn: () => void }) {
  const profileQ = useQuery(agentProfileQuery(agentKey), onSignIn);
  const open = useQuery(agentOpenQuery(agentKey), onSignIn);
  const lastDone = useQuery(lastDoneQuery(agentKey), onSignIn).data;
  const [pausing, setPausing] = useState(false);
  const [note, setNote] = useState("");
  const profile = profileQ.data;
  if (!profile) {
    if (profileQ.error)
      return (
        <main className="page wide agp">
          <EmptyState action={<a className="btn" href="#/agents">Back to Agents</a>}>{/no such agent/.test(profileQ.error) ? `No agent called ${agentKey}.` : `Couldn't load this agent: ${profileQ.error}`}</EmptyState>
        </main>
      );
    return <main className="page wide agp" aria-busy="true"><SkeletonLines lines={6} /></main>;
  }
  const needs = open.data?.needs ?? [];
  const ongoing = open.data?.ongoing ?? [];
  const working = ongoing.find((r) => r.state === "working");
  const paused = profile.status === "paused";
  const status = paused ? (
    <StatusDot tone="idle">Paused</StatusDot>
  ) : needs.length ? (
    <><StatusDot tone="needs">Needs you</StatusDot><span className="agp-ctx">{needs.length === 1 ? "1 task is waiting on you" : `${needs.length} tasks are waiting on you`}</span></>
  ) : profile.status === "running" || working ? (
    <><StatusDot tone="hue">Working</StatusDot>{working && <a className="agp-ctx" href={`#/t/${working.identifier}`} title={working.title}>on {working.title}</a>}</>
  ) : (
    <>
      <StatusDot tone="idle">Idle</StatusDot>
      <span className="agp-ctx">{ongoing.length ? `${ongoing.length} open task${ongoing.length === 1 ? "" : "s"} waiting to start` : lastDone ? `last finished a task ${agoLabel(lastDone)}` : ""}</span>
    </>
  );
  const chat = `#/c/?to=${encodeURIComponent(profile.id)}`;
  const task = <a className="btn primary" href={chat}>Give it a task</a>;
  const pause = async (body: { paused: boolean; stop?: boolean }) => {
    try {
      const r = await api.pauseAgent(agentKey, body);
      setNote(body.stop ? (r.stopped ? `Stopped ${r.stopped} running task${r.stopped === 1 ? "" : "s"}.` : "Nothing was running in Paperclip; an Engineer job already under way finishes.") : "");
      setPausing(false);
      const p = agentProfileQuery(agentKey);
      void load(p.key, p.fetch, p.persist, true).catch(() => {});
      void load(QUERIES.roster.key, QUERIES.roster.fetch, QUERIES.roster.persist, true).catch(() => {});
    } catch (e) {
      setPausing(false);
      if (e instanceof SignInRequired) onSignIn();
      else setNote(`Couldn't ${body.paused ? "pause" : "resume"} ${profile.name}: ${(e as Error).message}`);
    }
  };
  return (
    <main className={`page wide agp ${hueClass(profile.name)}`}>
      <PageHeader
        crumb={<><a href="#/agents">Agents</a> / {profile.name}</>}
        face={<AgentAvatar name={profile.name} portrait={profile.avatar} size={56} />}
        title={profile.name}
        status={status}
        sub={profile.title}
        actions={
          <>
            <a className="btn" href={chat}>Chat</a>
            {task}
            <Menu label={`More for ${profile.name}`} items={[paused ? { label: `Resume ${profile.name}`, onSelect: () => void pause({ paused: false }) } : { label: `Pause ${profile.name}…`, onSelect: () => setPausing(true) }]} />
          </>
        }
      />
      {note && <p className="agp-note" role="status">{note}</p>}
      {pausing && <PauseDialog name={profile.name} onCancel={() => setPausing(false)} onPause={pause} />}
      <nav className="agp-tabs" role="tablist" aria-label={`${profile.name} sections`}>
        {TABS.map(([t, name]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => go(`#/agents/${agentKey}${t === "overview" ? "" : `/${t}`}`)}>{name}</button>
        ))}
      </nav>
      {tab === "overview" && (
        <div className="agp-grid">
          <div className="agp-main">
            {needs.length > 0 && <Section title="Needs you" count={needs.length}><Rows rows={needs} /></Section>}
            {ongoing.length > 0 && <Section title="Working now" count={ongoing.length}><Rows rows={ongoing} /></Section>}
            <Tasks agentKey={agentKey} name={profile.name} task={task} hasOpen={needs.length + ongoing.length > 0} onSignIn={onSignIn} />
          </div>
          <Week id={profile.id} />
        </div>
      )}
      {tab === "chats" && <ChatsTab profile={profile} onSignIn={onSignIn} />}
      {tab === "handbook" && <AgentHandbook agentKey={agentKey} onSignIn={onSignIn} />}
      {tab === "settings" && <AgentSettings agentKey={agentKey} profile={profile} onSignIn={onSignIn} />}
    </main>
  );
}

const Rows = ({ rows }: { rows: TaskRow[] }) => (
  <ListRows>
    {rows.map((r) => <ListRow key={r.identifier} href={`#/t/${r.identifier}`} state={r.state} title={r.title} id={r.identifier} from={r.from} time={ago(r.updatedAt)} timeTitle={new Date(r.updatedAt).toLocaleString()} />)}
  </ListRows>
);

/** The agent's finished tasks: filter, search, page through. */
function Tasks({ agentKey, name, task, hasOpen, onSignIn }: { agentKey: string; name: string; task: React.ReactNode; hasOpen: boolean; onSignIn: () => void }) {
  const [status, setStatus] = useState<"" | "done" | "cancelled">("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  // Only the newest request may change what is shown: a slow answer to an old search, or a Load more begun before the term changed, is dropped.
  const load = useCallback(
    (offset?: number) => {
      const mine = ++seq.current;
      return api.agentHistory(agentKey, { q, ...(status ? { status } : {}), ...(offset ? { offset } : {}) }).then(
        (r) => {
          if (mine !== seq.current) return;
          setError("");
          setRows((old) => (offset && old ? [...old, ...r.rows] : r.rows));
          setNext(r.next);
        },
        (e) => {
          if (mine !== seq.current) return;
          if (e instanceof SignInRequired) onSignIn();
          else setError((e as Error).message);
        },
      );
    },
    [agentKey, q, status, onSignIn],
  );
  useEffect(() => {
    void load();
    return () => void seq.current++;
  }, [load]);
  const filtered = Boolean(status || q);
  return (
    <Section
      title="Tasks"
      aside={
        <>
          <Segmented label="Show" options={[["", "All"], ["done", "Done"], ["cancelled", "Stopped"]] as const} value={status} onChange={setStatus} />
          <input className="agp-search" type="search" placeholder="Search tasks" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search finished tasks" />
        </>
      }
    >
      {error ? (
        <EmptyState>Couldn't load tasks: {error}</EmptyState>
      ) : !rows ? (
        <SkeletonLines lines={3} />
      ) : !rows.length ? (
        filtered ? <EmptyState>No tasks match.</EmptyState> : hasOpen ? <EmptyState>No finished tasks yet.</EmptyState> : <EmptyState action={task}>No tasks yet. Give {name} something to do and it shows up here.</EmptyState>
      ) : (
        <Rows rows={rows} />
      )}
      {next !== null && <button className="btn agp-more" onClick={() => void load(next)}>Load more</button>}
    </Section>
  );
}

/** The week at a glance: tasks done and cost per day, and the counts worth a look. Diagnostics, not a ranking. */
function Week({ id }: { id: string }) {
  const { data: s, error } = useQuery(scorecardQuery(id));
  const info = "Diagnostics, not a ranking: agents have different jobs.";
  if (!s) return <Section title="This week" info={info} className="agp-rail">{error ? <EmptyState>Couldn't load this week's numbers.</EmptyState> : <SkeletonLines lines={5} />}</Section>;
  const day = (d: string) => new Date(`${d}T12:00:00`);
  const bars = (f: (d: Scorecard["daily"][number]) => number, say: (n: number) => string) =>
    s.daily.map((d) => ({ label: day(d.day).toLocaleDateString(undefined, { weekday: "narrow" }), value: f(d), title: `${day(d.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${say(f(d))}` }));
  const dash = (title: string) => <span title={title}>—</span>;
  return (
    <Section title="This week" info={info} className="agp-rail">
      <div className="agp-week">
        <StatBlock label="Tasks done" value={s.done.count} sub={`${s.done.prior} the week before`} bars={bars((d) => d.done, (n) => `${n} done`)} />
        <StatBlock
          label="Cost"
          value={usd(s.cost.usd)}
          sub={`${s.cost.perDone !== null ? `${usd(s.cost.perDone)} per finished task` : "No finished tasks"}${s.cost.usd > 0 && !s.cost.billed ? ", some calls unbilled" : ""}`}
          bars={bars((d) => d.costUsd, usd)}
        />
        <div className="agp-counts">
          <StatBlock label="Sent back" value={s.reopen.graded ? <span title={`${s.reopen.reopened} of ${s.reopen.graded} graded tasks${s.reopen.escalated ? `, ${s.reopen.escalated} escalated` : ""}`}>{s.reopen.reopened}</span> : dash("No graded tasks this week")} tone={s.reopen.reopened ? "bad" : undefined} />
          <StatBlock label="Cards rejected" value={s.approvals.filed ? <span title={`${s.approvals.rejected} of ${s.approvals.filed} filed`}>{s.approvals.rejected}</span> : dash("No cards filed this week")} tone={s.approvals.rejected ? "bad" : undefined} />
          <StatBlock label="Runs failed" value={s.runsFailed} tone={s.runsFailed ? "bad" : undefined} />
        </div>
      </div>
    </Section>
  );
}
const usd = (n: number) => `$${n > 0 && n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

function ChatsTab({ profile, onSignIn }: { profile: AgentProfile; onSignIn: () => void }) {
  const { data } = useQuery(QUERIES.chats, onSignIn);
  // A chat's agent `key` is the Paperclip id; `from` marks work handed out of a chat, which is a task, not a chat.
  const mine = (data?.chats ?? []).filter((c) => c.agent.key === profile.id && !c.from).sort((a, b) => Number(b.open) - Number(a.open));
  const start = <a className="btn" href={`#/c/?to=${encodeURIComponent(profile.id)}`}>New chat</a>;
  return (
    <Section title="Chats" count={mine.length || undefined} aside={start}>
      {!data ? (
        <SkeletonLines lines={2} />
      ) : !mine.length ? (
        <EmptyState>No chats with {profile.name} yet.</EmptyState>
      ) : (
        <ListRows>
          {mine.map((c) => <ListRow key={c.identifier} href={`#/c/${c.identifier}`} state={c.state} title={c.title} id={c.identifier} time={ago(c.updatedAt)} timeTitle={new Date(c.updatedAt).toLocaleString()} />)}
        </ListRows>
      )}
    </Section>
  );
}

/** Pausing asks what to do with a running task: let it finish, or stop it now. */
function PauseDialog({ name, onCancel, onPause }: { name: string; onCancel: () => void; onPause: (body: { paused: boolean; stop?: boolean }) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const send = (stop: boolean) => {
    setBusy(true);
    void onPause({ paused: true, ...(stop ? { stop } : {}) }).finally(() => setBusy(false));
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onCancel]);
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="help agp-dialog" role="dialog" aria-modal="true" aria-label={`Pause ${name}`}>
        <h2>Pause {name}?</h2>
        <p>It takes no new work while paused. What about the task it is on now?</p>
        <div className="agp-dialog-actions">
          <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={() => send(true)}>Stop it now</button>
          <button className="btn primary" autoFocus disabled={busy} onClick={() => send(false)}>Let it finish</button>
        </div>
      </div>
    </div>
  );
}
