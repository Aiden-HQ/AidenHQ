// A teammate's page (#/team/<key>[/c/<chat>]): who it is and what it does now, Pause, one Advanced link; its chat (the
// newest open one, any of its chats from the switcher, or a new one) beside a generic side column: what it does, its recent
// work, how it is set up (its modules' declared settings) and the team behind it. Nothing here is per-module.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { load, useCached } from "./cache";
import { Composer, Conversation } from "./ChatPane";
import { useLive } from "./events";
import { LaneChat } from "./LaneChat";
import { QUERIES, agentChatsQuery, agentTimelineQuery, useQuery } from "./queries";
import { RenameButton, statusLine } from "./Team";
import { SkeletonLines } from "./Skeleton";
import type { Assignee, ChatRow, RosterAgent, SettingRow } from "./types";
import { Banner, Button, Card, Disclosure, EmptyState, Face, Facts, LinkButton, Menu, Page, SectionCard, Segmented, StatusDot, Tag, faceProps, faceStateOf, type TagTone } from "./ui";
import { yamlValue } from "./settings-format";
import { ago } from "./util";
import "./team.css";

type Toast = (text: string, action?: { label: string; run: () => void }) => void;
const OUTCOME: Record<string, [string, TagTone]> = { running: ["Running", "accent"], done: ["Done", "ok"], failed: ["Failed", "failed"], stopped: ["Stopped", "neutral"] };
const settingsQuery = { key: "settings", fetch: api.settings, persist: false as const };

/** A setting's value in a line: a list joined, on/off, else its YAML. */
const valueText = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : yamlValue(x))).join(", ") || "none" : typeof v === "boolean" ? (v ? "On" : "Off") : v === null || v === undefined || v === "" ? "not set" : typeof v === "string" ? v : yamlValue(v));
/** A setting's label: the first sentence of its doc, else its key in words. */
const labelOf = (s: SettingRow) => (s.doc ? s.doc.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "") : s.key.replace(/_/g, " "));

export function TeammateView({ agentKey, chat, text, crew, faces, prefix, go, onSignIn, toast, mobile }: { agentKey: string; chat?: string; text?: string; crew: Assignee[]; faces: Assignee[]; prefix: string; go: (h: string) => void; onSignIn: () => void; toast: Toast; mobile: boolean }) {
  const rosterQ = useQuery(QUERIES.roster, onSignIn);
  const roster = rosterQ.data?.roster;
  const a = roster?.find((r) => r.key === agentKey);
  // An agent that isn't a teammate has its own page under All agents.
  useEffect(() => {
    if (a && !a.teammate) location.replace(`#/team/agents/${agentKey}`);
  }, [a, agentKey]);
  if (!roster) return <Page label="Teammate">{rosterQ.error ? <EmptyState>Couldn't load your team: {rosterQ.error}</EmptyState> : <SkeletonLines lines={6} />}</Page>;
  if (!a)
    return (
      <Page label="Teammate">
        <EmptyState action={<a className="btn" href="#/team">Your team</a>}>No teammate called {agentKey}.</EmptyState>
      </Page>
    );
  if (!a.teammate) return null;
  return <Mate key={a.key} a={a} roster={roster} chat={chat} text={text} crew={crew} faces={faces} prefix={prefix} go={go} onSignIn={onSignIn} toast={toast} mobile={mobile} />;
}

function Mate({ a, roster, chat, text, crew, faces, prefix, go, onSignIn, toast, mobile }: { a: RosterAgent; roster: RosterAgent[]; chat?: string; text?: string; crew: Assignee[]; faces: Assignee[]; prefix: string; go: (h: string) => void; onSignIn: () => void; toast: Toast; mobile: boolean }) {
  const key = a.key!;
  const t = a.teammate!;
  const home = useQuery(QUERIES.home, onSignIn).data;
  const needs = home?.needs.filter((n) => n.teammate.key === key).length ?? 0;
  const pages = useQuery(QUERIES.pages, onSignIn).data?.pages ?? [];
  const modules = useQuery(QUERIES.modules, onSignIn).data?.modules ?? [];
  const [note, setNote] = useState("");
  const paused = a.state === "paused";
  const pause = async () => {
    try {
      await api.pauseAgent(key, { paused: !paused });
      setNote("");
      void load(QUERIES.roster.key, QUERIES.roster.fetch, QUERIES.roster.persist, true).catch(() => {});
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setNote(`Couldn't ${paused ? "resume" : "pause"} ${a.name}: ${(e as Error).message}`);
    }
  };
  // One Advanced link: the first controlled module's page, else its settings.
  const mod = t.controls[0];
  const page = mod ? pages.find((p) => p.module === mod) : undefined;
  const modName = modules.find((m) => m.name === mod)?.name ?? mod;
  const advanced = mod && (page ? { href: `#/team/m/${page.id}`, label: page.title } : { href: `#/team/modules/${mod}/settings`, label: modName });
  const state = faceStateOf(a, needs > 0);
  const tone = paused ? "idle" : state === "needs" ? "needs" : state === "working" ? "working" : a.state === "failing" ? "failed" : "idle";
  return (
    <Page className="mate" label={a.name}>
      <a className="mate-back" href="#/team">← Your team</a>
      <Card className="mate-card">
        <div className="mate-head">
        <Face seed={key} {...faceProps(t.face)} state={state} size={96} label={a.name} />
        <span className="mate-who">
          <span className="mate-name"><h1>{a.name}</h1><span className="mate-job">· {t.job}</span><RenameButton agent={a} roster={roster} /></span>
          <StatusDot tone={tone}>{statusLine(a, needs)}</StatusDot>
          {a.title && <p className="mate-desc">{a.title}</p>}
        </span>
        <span className="mate-actions">
          <Button onClick={() => void pause()}>{paused ? `Resume ${a.name}` : `Pause ${a.name}`}</Button>
          {advanced && <LinkButton href={advanced.href}>Advanced: {advanced.label} settings ↗</LinkButton>}
        </span>
        </div>
        {note && <Banner tone="danger">{note}</Banner>}
      </Card>
      <div className="mate-grid">
        <ChatCard a={a} chat={chat} text={text} crew={crew} faces={faces} prefix={prefix} go={go} onSignIn={onSignIn} toast={toast} mobile={mobile} />
        <aside className="mate-side" aria-label={`About ${a.name}`}>
          <SectionCard title={`What ${a.name} does`}>
            <p className="mate-p">{a.title ?? t.sample}</p>
          </SectionCard>
          <RecentWork a={a} onSignIn={onSignIn} />
          <SetUp a={a} onSignIn={onSignIn} />
          {t.staff.length > 0 && (
            <Card>
              <Disclosure summary={`Team behind ${a.name} (${t.staff.length})`}>
              <div className="mate-staff">
                {t.staff.map((k) => {
                  const s = roster.find((r) => r.key === k);
                  return <a key={k} href={`#/team/agents/${k}`}>{s?.name ?? k}{s?.title ? ` · ${s.title}` : ""}</a>;
                })}
              </div>
              </Disclosure>
            </Card>
          )}
        </aside>
      </div>
    </Page>
  );
}

/** The chat: a lane agent's one conversation, the route's chat, the newest open one, else a composer for a new one. */
function ChatCard({ a, chat, text, crew, faces, prefix, go, onSignIn, toast, mobile }: { a: RosterAgent; chat?: string; text?: string; crew: Assignee[]; faces: Assignee[]; prefix: string; go: (h: string) => void; onSignIn: () => void; toast: Toast; mobile: boolean }) {
  const key = a.key!;
  const [state, setState] = useState<"active" | "settled">("active");
  const [older, setOlder] = useState<ChatRow[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  // The offset "Show older" reads from: the server's `next_offset` after the last page (it reads past other agents' chats).
  const [next, setNext] = useState<number | null>(null);
  const list = useQuery(agentChatsQuery(key, state), onSignIn);
  const active = useQuery(agentChatsQuery(key), onSignIn);
  useLive(["chat"], active.reload, 30_000);
  const lane = useQuery(QUERIES.lane, onSignIn).data?.agents.find((l) => l.key === key || l.id === a.id);
  const [fresh, setFresh] = useState(false);
  // A route with text (#/team/<key>?text=…) asks for a new chat with it prefilled, whatever chat is open.
  const current = fresh ? undefined : chat ?? (text ? undefined : active.data?.chats.find((c) => c.open && !c.settled)?.identifier);
  const rows = [...(list.data?.chats ?? []), ...older];
  const showOlder = async () => {
    try {
      const r = await api.chats(key, { state, offset: next ?? list.data?.next_offset ?? 0 });
      const shown = new Set(list.data?.chats.map((c) => c.identifier));
      setOlder((o) => [...o, ...r.chats.filter((c) => !shown.has(c.identifier) && !o.some((x) => x.identifier === c.identifier))]);
      setMore(!!r.more);
      setNext(r.next_offset ?? null);
    } catch (e) {
      toast(`Couldn't load older chats: ${(e as Error).message}`);
    }
  };
  const send = async (body: string, files: File[]) => {
    const { identifier } = await api.newChat(body || `Files: ${files.map((f) => f.name).join(", ")}`, key);
    for (const f of identifier.startsWith("lane:") ? [] : files) await api.attach(identifier, f).catch((e: Error) => toast(`Couldn't attach ${f.name}: ${e.message}`));
    setFresh(false);
    void active.reload();
    go(`#/team/${key}/c/${identifier}`);
  };
  const tools = lane ? undefined : (
    <span className="mate-chat-tools">
      <Segmented label="Chats" value={state} onChange={(s) => (setState(s), setOlder([]), setMore(null), setNext(null))} options={[["active", "Active"], ["settled", "Settled"]] as const} />
      <Menu
        label={`${a.name}'s chats`}
        items={[
          { label: "New chat", onSelect: () => (setFresh(true), go(`#/team/${key}`)) },
          ...rows.map((c) => ({ label: `${c.title} · ${ago(c.preview?.at ?? c.updatedAt)}`, onSelect: () => (setFresh(false), go(`#/team/${key}/c/${c.identifier}`)) })),
          ...((more ?? list.data?.more) ? [{ label: "Show older", onSelect: () => void showOlder() }] : []),
        ]}
      />
    </span>
  );
  return (
    <div className="mate-chat-wrap">
      <SectionCard title={`Chat with ${a.name}`} meta={mobile ? undefined : "Tell it what you want; it changes its own settings and shows you exactly what changed."} action={tools} flush>
        <div className="mate-chat">
          {lane ? (
            <LaneChat agent={lane} mobile={mobile} faces={faces} go={go} />
          ) : current ? (
            <Conversation key={current} refId={current} row={rows.find((r) => r.identifier === current)} mobile={mobile} crew={crew} faces={faces} prefix={prefix} go={go} onSignIn={onSignIn} toast={toast} reloadList={active.reload} compact />
          ) : (
            <div className="mate-new ws-main">
              <p className="mate-new-hint">{fresh ? `A new chat with ${a.name}.` : `No chat with ${a.name} yet.`} Tell {a.name} what you want; it changes its own settings and shows you exactly what changed.</p>
              <Composer key={`${key}|${text ?? ""}`} initialText={text} placeholder={`Message ${a.name}: ${a.teammate!.sample}`} draftKey={`draft:new:${key}`} mobile={mobile} crew={crew} autoFocus={!mobile} onSend={send} />
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

function RecentWork({ a, onSignIn }: { a: RosterAgent; onSignIn: () => void }) {
  const q = useQuery(agentTimelineQuery(a.key!), onSignIn);
  const rows = (q.data ?? []).filter((e) => e.task.identifier).slice(0, 5);
  return (
    <SectionCard title="Recent work" action={<a href={`#/team/agents/${a.key}/activity`}>All work →</a>}>
      {q.data === undefined ? (
        <SkeletonLines lines={3} />
      ) : rows.length ? (
        <ul className="mate-work">
          {rows.map((e) => {
            const [word, tone] = OUTCOME[e.outcome] ?? [e.state, "neutral" as const];
            return (
              <li key={e.id}>
                <Tag tone={tone}>{word}</Tag>
                <a href={`#/t/${e.task.identifier}`} title={e.task.title ?? ""}>{e.task.title ?? e.task.identifier}</a>
                {e.startedAt && <time>{ago(e.startedAt)}</time>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mate-p">Nothing yet. Work {a.name} does shows here.</p>
      )}
    </SectionCard>
  );
}

/** Its controlled modules' declared settings, in words; changes go through the teammate itself. */
function SetUp({ a, onSignIn }: { a: RosterAgent; onSignIn: () => void }) {
  const q = useCached(settingsQuery.key, settingsQuery.fetch, { persist: false, onSignIn });
  const controls = a.teammate!.controls;
  const rows = (q.data?.settings ?? []).filter((s) => controls.includes(s.module));
  if (!controls.length || (q.data && !rows.length)) return null;
  return (
    <SectionCard title={`How ${a.name} is set up`}>
      {q.data ? <Facts items={rows.map((s) => [labelOf(s), valueText(s.value)] as const)} /> : <SkeletonLines lines={3} />}
      <p className="mate-foot">Change any of this by asking {a.name}.</p>
    </SectionCard>
  );
}

