// An agent's page (#/team/agents/<key>/<tab>): who it is and what it is doing, what waits on you, its tasks (each opens its
// thread), its week, what it did run by run (Activity), its handbook and its settings. A teammate's chats are on its own page. Reads: agent-page.ts; writes: the settings editor's (SettingsAgents AgentDetails).
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentActivity } from "./AgentActivity";
import { SignInRequired, api } from "./api";
import { load } from "./cache";
import { agentOpenQuery, agentProfileQuery, QUERIES, scorecardQuery, useQuery } from "./queries";
import { AgentHandbook } from "./AgentHandbook";
import { AgentSettings } from "./AgentSettings";
import { SkeletonLines } from "./Skeleton";
import type { AgentProfile, Scorecard, TaskRow } from "./types";
import { ago, agoLabel, stampOpts } from "./util";
import { EmptyState } from "./ui/EmptyState";
import { hueClass } from "./ui/hue";
import { ListRow, ListRows } from "./ui/ListRow";
import { Menu } from "./ui/Menu";
import { PageHeader } from "./ui/PageHeader";
import { Section } from "./ui/Section";
import { Segmented } from "./ui/Segmented";
import { StatBlock } from "./ui/StatBlock";
import { StatusDot } from "./ui/StatusDot";
import { TaskState } from "./ui/TaskState";
import "./settings.css";
import "./agent-page.css";
import { Face, Tabs, faceProps } from "./ui";

export type AgentTab = "overview" | "activity" | "handbook" | "settings";
const TABS: [AgentTab, string][] = [["overview", "Overview"], ["activity", "Activity"], ["handbook", "Handbook"], ["settings", "Settings"]];

/** When the agent last finished a task (the newest done task), for the idle status line. */
const lastDoneQuery = (key: string) => ({ key: `agents.${key}.last-done`, fetch: () => api.agentHistory(key, { status: "done" }).then((r) => r.rows.reduce<string | null>((a, x) => (!a || x.updatedAt > a ? x.updatedAt : a), null)), persist: false as const });

export function AgentPage({ agentKey, tab, go, onSignIn }: { agentKey: string; tab: AgentTab; go: (hash: string) => void; onSignIn: () => void }) {
  const profileQ = useQuery(agentProfileQuery(agentKey), onSignIn);
  const open = useQuery(agentOpenQuery(agentKey), onSignIn);
  const lastDone = useQuery(lastDoneQuery(agentKey), onSignIn).data;
  const [note, setNote] = useState("");
  const profile = profileQ.data;
  if (!profile) {
    if (profileQ.error)
      return (
        <main className="page wide agp">
          <EmptyState action={<a className="btn" href="#/team/agents">Back to All agents</a>}>{/no such agent/.test(profileQ.error) ? `No agent called ${agentKey}.` : `Couldn't load this agent: ${profileQ.error}`}</EmptyState>
        </main>
      );
    return <main className="page wide agp" aria-busy="true"><SkeletonLines lines={6} /></main>;
  }
  const needs = open.data?.needs ?? [];
  const ongoing = [...(open.data?.ongoing ?? [])].sort((a, b) => Number(b.state?.kind === "working") - Number(a.state?.kind === "working"));
  const working = ongoing.find((r) => r.state?.kind === "working");
  const paused = profile.state === "paused";
  const status = paused ? (
    <StatusDot tone="idle">Paused</StatusDot>
  ) : needs.length ? (
    <><StatusDot tone="needs">Needs you</StatusDot><span className="agp-ctx">{needs.length === 1 ? "1 task is waiting on you" : `${needs.length} tasks are waiting on you`}</span></>
  ) : profile.state === "working" || working ? (
    <><StatusDot tone="hue">Working</StatusDot>{working && <a className="agp-ctx" href={`#/t/${working.identifier}`} title={working.title}>on {working.title}</a>}</>
  ) : profile.state === "failing" ? (
    <><StatusDot tone="failed">Failing</StatusDot>{profile.stateNote && <span className="agp-ctx">{profile.stateNote}</span>}</>
  ) : (
    <>
      <StatusDot tone="idle">Idle</StatusDot>
      <span className="agp-ctx">{ongoing.length ? `${ongoing.length} open task${ongoing.length === 1 ? "" : "s"} waiting to start` : lastDone ? `last finished a task ${agoLabel(lastDone)}` : ""}</span>
    </>
  );
  // Only a teammate takes chats and tasks from the owner (on its own page); a hidden agent works through its teammate.
  const mate = profile.teammate ? `#/team/${agentKey}` : null;
  const task = mate ? <a className="btn primary" href={mate}>Give it a task</a> : null;
  const pause = async (body: { paused: boolean; stop?: boolean }) => {
    try {
      await api.pauseAgent(agentKey, body);
      setNote("");
      const p = agentProfileQuery(agentKey);
      void load(p.key, p.fetch, p.persist, true).catch(() => {});
      void load(QUERIES.roster.key, QUERIES.roster.fetch, QUERIES.roster.persist, true).catch(() => {});
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setNote(`Couldn't ${body.paused ? "pause" : "resume"} ${profile.name}: ${(e as Error).message}`);
    }
  };
  return (
    <main className={`page wide agp ${hueClass(profile.name)}`}>
      <PageHeader
        crumb={<><a href="#/team/agents">All agents</a> / {profile.name}</>}
        face={<Face seed={profile.key} {...faceProps(profile.teammate?.face)} state={profile.state === "working" || profile.state === "queued" ? "working" : "idle"} size={56} label={profile.name} />}
        title={profile.name}
        status={status}
        sub={profile.title}
        actions={
          <>
            {mate && <a className="btn" href={mate}>Chat</a>}
            {task}
            <Menu label={`More for ${profile.name}`} items={[paused ? { label: `Resume ${profile.name}`, onSelect: () => void pause({ paused: false }) } : { label: `Pause ${profile.name}`, onSelect: () => void pause({ paused: true }) }, ...(paused ? [] : [{ label: `Pause and stop ${profile.name} now`, onSelect: () => void pause({ paused: true, stop: true }) }])]} />
          </>
        }
      />
      {note && <p className="agp-note" role="status">{note}</p>}
      <Tabs label={`${profile.name} sections`} tabs={TABS} value={tab} href={(t) => `#/team/agents/${agentKey}${t === "overview" ? "" : `/${t}`}`} />
      {tab === "overview" && (
        <div className="agp-grid">
          <div className="agp-main">
            {needs.length > 0 && <Section title="Needs you" count={needs.length}><Rows rows={needs} /></Section>}
            {ongoing.length > 0 && <Section title="Open tasks" count={ongoing.length}><Rows rows={ongoing} /></Section>}
            <Tasks agentKey={agentKey} name={profile.name} task={task} hasOpen={needs.length + ongoing.length > 0} onSignIn={onSignIn} />
          </div>
          <Week id={profile.id} />
        </div>
      )}
      {tab === "activity" && <AgentActivity agentKey={agentKey} onSignIn={onSignIn} />}
      {tab === "handbook" && <AgentHandbook agentKey={agentKey} onSignIn={onSignIn} />}
      {tab === "settings" && <AgentSettings agentKey={agentKey} profile={profile} onSignIn={onSignIn} />}
    </main>
  );
}

const Rows = ({ rows }: { rows: TaskRow[] }) => (
  <ListRows>
    {rows.map((r) => <ListRow key={r.identifier} href={`#/t/${r.identifier}`} status={<TaskState state={r.state} />} title={r.title} id={r.identifier} from={r.from} time={ago(r.updatedAt)} timeTitle={new Date(r.updatedAt).toLocaleString(undefined, stampOpts())} />)}
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
          <StatBlock label="Cards rejected" value={s.approvals.filed ? <span title={`${s.approvals.rejected} of ${s.approvals.filed} filed`}>{s.approvals.rejected}</span> : dash("No cards filed this week")} tone={s.approvals.rejected ? "bad" : undefined} />
          <StatBlock label="Runs failed" value={s.runsFailed} tone={s.runsFailed ? "bad" : undefined} />
        </div>
      </div>
    </Section>
  );
}
const usd = (n: number) => `$${n > 0 && n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

