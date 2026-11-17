// An agent's page (#/agents/<key>/<tab>): who it is, its work (needs you, ongoing, past: each task opens its thread),
// its general chats and its settings. Reads: agent-page.ts; writes: the settings editor's (SettingsAgents AgentDetails).
import { useCallback, useEffect, useRef, useState } from "react";
import { Scorecard } from "./Agents";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { agentOpenQuery, agentProfileQuery, QUERIES, useQuery } from "./queries";
import { AgentDetails } from "./SettingsAgents";
import { ChangesScope } from "./settings-ui";
import { SkeletonLines } from "./Skeleton";
import type { AgentProfile, SettingsData, TaskRow } from "./types";
import { ago } from "./util";
import "./settings.css";

export type AgentTab = "overview" | "chats" | "settings";
const TABS: [AgentTab, string][] = [["overview", "Overview"], ["chats", "Chats"], ["settings", "Settings"]];

const tone = (state: string) => (state === "failed" ? "failed" : state === "working" || state === "queued" ? "working" : state.startsWith("waiting") ? "needs" : "");
const Pill = ({ state }: { state: string }) => <span className={`pill${tone(state) ? ` pill-${tone(state)}` : ""}`}>{state}</span>;

export function AgentPage({ agentKey, tab, go, onSignIn }: { agentKey: string; tab: AgentTab; go: (hash: string) => void; onSignIn: () => void }) {
  const profileQ = useQuery(agentProfileQuery(agentKey), onSignIn);
  const open = useQuery(agentOpenQuery(agentKey), onSignIn);
  const profile = profileQ.data;
  if (!profile) {
    if (profileQ.error)
      return (
        <main className="page wide">
          <p className="empty">{/no such agent/.test(profileQ.error) ? <>No agent called {agentKey}. <a href="#/agents">Back to Agents</a></> : `Couldn't load: ${profileQ.error}`}</p>
        </main>
      );
    return <main className="page wide" aria-busy="true"><SkeletonLines lines={6} /></main>;
  }
  const needs = open.data?.needs.length ?? 0;
  const pill = profile.status === "paused" ? ["", "Paused"] : needs ? ["needs", `${needs} need${needs === 1 ? "s" : ""} you`] : profile.status === "running" ? ["working", "Working"] : ["", "Idle"];
  const src = profile.source;
  const source = src ? `from the ${src.module} module${src.revision ? ` ${src.revision}` : ""}${src.marketplace ? ` (${src.marketplace}${src.tier ? `, ${src.tier}` : ""})` : ""}` : "Your agent";
  const line = [profile.title, source, [profile.model, profile.effort].filter(Boolean).join(", "), profile.reportsTo && `reports to ${profile.reportsTo}`].filter(Boolean).join(" · ");
  const chat = `#/c/?to=${encodeURIComponent(profile.id)}`;
  return (
    <main className="page wide agent-page">
      <nav className="ap-crumb"><a href="#/agents">Agents</a> / {profile.name}</nav>
      <header className="page-head ap-head">
        <AgentAvatar name={profile.name} portrait={profile.avatar} size={48} />
        <div>
          <h1>{profile.name} <span className={`pill${pill[0] ? ` pill-${pill[0]}` : ""}`}>{pill[1]}</span></h1>
          <p className="page-sub">{line}</p>
        </div>
        <span className="spacer" />
        <a className="btn" href={chat}>Chat</a>
        <a className="btn primary" href={chat}>Give it a task</a>
      </header>
      <div className="st-seg" role="tablist">
        {TABS.map(([t, name]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => go(`#/agents/${agentKey}${t === "overview" ? "" : `/${t}`}`)}>{name}</button>
        ))}
      </div>
      {tab === "overview" && (
        <>
          <section><h4>Needs you</h4><TaskList rows={open.data?.needs} empty="Nothing needs you." /></section>
          <section><h4>Ongoing</h4><TaskList rows={open.data?.ongoing} empty="Nothing running." /></section>
          <History agentKey={agentKey} onSignIn={onSignIn} />
          <Scorecard id={profile.id} />
        </>
      )}
      {tab === "chats" && <ChatsTab profile={profile} onSignIn={onSignIn} />}
      {tab === "settings" && <SettingsTab agentKey={agentKey} onSignIn={onSignIn} />}
    </main>
  );
}

function TaskList({ rows, empty }: { rows: TaskRow[] | undefined; empty: string }) {
  if (!rows) return <SkeletonLines lines={2} />;
  if (!rows.length) return <p className="fleet-empty">{empty}</p>;
  return (
    <div className="st-rows">
      {rows.map((r) => (
        <a key={r.identifier} className="ap-row" href={`#/t/${r.identifier}`}>
          <Pill state={r.state} />
          <span className="ap-id">{r.identifier}</span>
          <span className="ap-title">{r.title}</span>
          {r.from && <span className="ap-from">from {r.from}</span>}
          <span className="time">{ago(r.updatedAt)}</span>
        </a>
      ))}
    </div>
  );
}

function History({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
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
  return (
    <section>
      <h4>History</h4>
      <div className="st-filters">
        {([["", "All"], ["done", "Done"], ["cancelled", "Stopped"]] as const).map(([v, name]) => (
          <button key={v} className={`st-filter${status === v ? " on" : ""}`} aria-pressed={status === v} onClick={() => setStatus(v)}>
            {name}
          </button>
        ))}
        <input className="st-search small" type="search" placeholder="Search tasks" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search finished tasks" />
      </div>
      {error ? <p className="fleet-empty">Couldn't load: {error}</p> : <TaskList rows={rows ?? undefined} empty="No finished tasks yet." />}
      {next !== null && <button className="btn" onClick={() => void load(next)}>Load more</button>}
    </section>
  );
}

function ChatsTab({ profile, onSignIn }: { profile: AgentProfile; onSignIn: () => void }) {
  const { data } = useQuery(QUERIES.chats, onSignIn);
  // A chat's agent `key` is the Paperclip id; `from` marks work handed out of a chat, which is a task, not a chat.
  const mine = (data?.chats ?? []).filter((c) => c.agent.key === profile.id && !c.from).sort((a, b) => Number(b.open) - Number(a.open));
  return (
    <section>
      <div className="ap-bar"><h4>Chats</h4><span className="spacer" /><a className="btn" href={`#/c/?to=${encodeURIComponent(profile.id)}`}>New chat</a></div>
      {!data ? (
        <SkeletonLines lines={2} />
      ) : !mine.length ? (
        <p className="fleet-empty">No chats with {profile.name} yet.</p>
      ) : (
        <div className="st-rows">
          {mine.map((c) => (
            <a key={c.identifier} className="ap-row" href={`#/c/${c.identifier}`}>
              <Pill state={c.state} />
              <span className="ap-id">{c.identifier}</span>
              <span className="ap-title">{c.title}</span>
              <span className="time">{ago(c.updatedAt)}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** Today's editor from Settings > Agents and models, inside the change context that page provides. */
function SettingsTab({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.settings().then(setData, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
  }, [onSignIn]);
  const a = data?.agents.find((x) => x.key === agentKey);
  return (
    <ChangesScope onSignIn={onSignIn}>
      <section className="st-embedded">
        {error ? <p className="fleet-empty">Couldn't load settings: {error}</p> : !data ? <SkeletonLines lines={4} /> : a ? <AgentDetails a={a} data={data} /> : <p className="fleet-empty">This agent has no settings in the compiled config yet.</p>}
      </section>
    </ChangesScope>
  );
}
