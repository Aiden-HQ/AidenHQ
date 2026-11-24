// The chat workspace: agents on the left with their chats (Aiden pinned on top as the front door), the conversation
// in the middle, and one details panel on the right (context, the tasks the chat handed out, progress and files). On a
// narrow screen the panel opens over the conversation; on a phone: the list, then the conversation full screen, the
// panel as a sheet. Lives at #/c/ (a new chat) and #/c/<chat>.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { load as loadCached } from "./cache";
import { QUERIES, chatQuery, peekingChat, prefetchChat, useQuery } from "./queries";
import { ChatListSkeleton, SkeletonLines } from "./Skeleton";
import { AnswerForm } from "./AnswerForm";
import { ApprovalCard } from "./Chat";
import { LaneChat } from "./LaneChat";
import { FeatureCostStrip } from "./FeatureCost";
import { DelegatedList, LineageStrip, useLineage } from "./Lineage";
import { live as streaming, useEvents } from "./events";
import { CloseIcon, Plan, PlusIcon } from "./components";
import { Markdown } from "./markdown";
import { anyLive, groupChats, groupTasks, laneOf, settleableChat, taskSummary, type AgentGroup } from "./sidebar";
import { TaskState, isActive, needsOwner, waitsForAnswer } from "./ui/TaskState";
import { foldCount, foldNoise, isNoise, shortTitle, type Folded } from "./conversation";
import type { Approval, Assignee, ChatAgent, ChatDetail, LaneAgent, ChatMessage, ChatRow, FileView, Lineage, SettledItem, Working } from "./types";
import { MAX_FILE, ago, elapsed, fileSize, handleOf } from "./util";
import { Icon } from "./ui/icons";

interface Props {
  selected: string | null;
  /** #/c/ itself: a new chat (on a phone, full screen instead of the list). */
  composing: boolean;
  mobile: boolean;
  crew: Assignee[];
  prefix: string;
  go: (hash: string) => void;
  onSignIn: () => void;
  toast: (text: string) => void;
}

const QUIET_MS = 2 * 60_000;
const PANEL_KEY = "aidenhq.panel";
/** From this width the details panel starts open; below it, it starts shut until the owner opens it (a stored choice wins). */
const PANEL_OPEN_FROM = 1920;
/** An agent's portrait (/crew/<avatar>.svg), by its key or name, when it has one. */
export const portraitOf = (crew: Assignee[], keyOrName: string) => {
  const a = crew.find((c) => c.key === keyOrName) ?? crew.find((c) => c.name === keyOrName);
  return a?.avatar;
};

/** An agent's face in the chat workspace (AgentAvatar: its portrait, else its monogram). */
export function Monogram({ name, size = 28, front, avatar }: { name: string; size?: number; front?: boolean; avatar?: string }) {
  return <AgentAvatar className="monogram" name={name} portrait={avatar} size={size} front={front} />;
}

/**
 * The fallback timer (the cache fetched on mount already; live updates, events.ts, refetch on every change): at the old
 * pace while the live stream is down, once a minute while it is up, and only while the page is visible.
 */
function usePoll(load: () => Promise<unknown>, fast: boolean, idleMs: number) {
  useEffect(() => {
    let last = Date.now();
    const t = setInterval(() => {
      if (document.visibilityState !== "visible" || (streaming() && Date.now() - last < 60_000)) return;
      last = Date.now();
      void load();
    }, fast ? 2_000 : idleMs);
    return () => clearInterval(t);
  }, [load, fast, idleMs]);
}

const NO_AGENTS: ChatAgent[] = [];
const NO_LANE: LaneAgent[] = [];

export function ChatWorkspace({ selected, composing, mobile, crew, prefix, go, onSignIn, toast }: Props) {
  // From the cache (queries.ts): coming back to Chat paints the last list at once while it refreshes.
  const chats = useQuery(QUERIES.chats, onSignIn);
  const rows = chats.data?.chats ?? null;
  const agents = chats.data?.agents ?? NO_AGENTS;
  const error = chats.error;
  const load = chats.reload;
  usePoll(load, anyLive(rows ?? []), 6_000);
  // Fast-lane agents (LaneChat.tsx): their one conversation is listed under the agent; none on an instance without the lane.
  const laneAgents = useQuery(QUERIES.lane, onSignIn).data?.agents ?? NO_LANE;
  const laneAgent = selected?.startsWith("lane:") ? laneAgents.find((a) => a.key === selected.slice(5)) : undefined;
  useEvents(["chat", "approvals"], load);
  const [panel, setPanel] = useState(() => {
    try {
      const saved = localStorage.getItem(PANEL_KEY);
      return saved ? saved === "1" : window.innerWidth >= PANEL_OPEN_FROM;
    } catch {
      return window.innerWidth >= PANEL_OPEN_FROM;
    }
  });
  const togglePanel = () =>
    setPanel((p) => {
      try {
        localStorage.setItem(PANEL_KEY, p ? "0" : "1");
      } catch {}
      return !p;
    });

  const list = <Sidebar lane={laneAgents} rows={rows} agents={agents} crew={crew} selected={selected} go={go} error={error} retry={load} />;
  const main = laneAgent ? (
    <LaneChat key={laneAgent.key} agent={laneAgent} mobile={mobile} crew={crew} go={go} />
  ) : selected?.startsWith("lane:") ? (
    // A lane chat is not a Paperclip task: until the lane's agents load (a reload on its URL) show nothing, never open it as a task ref.
    <section className="ws-main" />
  ) : selected ? (
    <Conversation key={selected} refId={selected} row={rows?.find((r) => r.identifier === selected)} mobile={mobile} crew={crew} prefix={prefix} go={go} onSignIn={onSignIn} toast={toast} panel={panel} togglePanel={togglePanel} reloadList={load} />
  ) : (
    <NewChat agents={agents} crew={crew} mobile={mobile} go={go} toast={toast} reloadList={load} />
  );
  if (mobile) return <div className="ws ws-phone">{selected || composing || (rows && !rows.length) ? main : list}</div>;
  return (
    <div className="ws">
      {list}
      {main}
    </div>
  );
}

// ------------------------------------------------------------------ sidebar

function Sidebar({ lane, rows, agents, crew, selected, go, error, retry }: { lane: LaneAgent[]; rows: ChatRow[] | null; agents: ChatAgent[]; crew: Assignee[]; selected: string | null; go: (h: string) => void; error: string; retry: () => void }) {
  const active = useMemo(() => (rows ?? []).filter((r) => !r.settled), [rows]);
  const groups = useMemo(() => groupChats(active, agents), [active, agents]);
  const [tab, setTab] = useState<"active" | "settled">("active");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // A search looks through every chat of the agent, open or finished, and lists the matches flat.
  const filter = (g: AgentGroup): AgentGroup => {
    if (!q) return g;
    const hit = (c: ChatRow) => `${c.title} ${c.preview?.text ?? ""} ${g.agent.name}`.toLowerCase().includes(q);
    return { ...g, chats: [...g.chats, ...g.more].filter(hit), more: [], earlier: g.earlier.filter(hit), tests: g.tests.filter(hit) };
  };
  return (
    <aside className="ws-side" aria-label="Chats">
      <div className="side-top">
        <button className="btn primary new-chat-btn" onClick={() => go("#/c/")}>
          <PlusIcon /> New chat
        </button>
        <div className="side-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "active"} className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>
            Active<i>{active.filter((r) => !r.from && r.open).length}</i>
          </button>
          <button role="tab" aria-selected={tab === "settled"} className={tab === "settled" ? "on" : ""} onClick={() => setTab("settled")}>
            Settled
          </button>
        </div>
        {tab === "active" && <input className="side-search" type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search chats" />}
      </div>
      {tab === "settled" && <SettledList selected={selected} go={go} reloadList={retry} />}
      {error && (
        <div className="alert">
          Couldn't load your chats: {error}{" "}
          <button className="link-btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {tab === "active" && (!rows ? (
        <ChatListSkeleton />
      ) : (
        <nav className="side-scroll">
          {groups.front && <Group g={filter(groups.front)} lane={laneOf(lane, groups.front.agent.key)} crew={crew} selected={selected} go={go} front searching={!!q} />}
          {groups.others.length > 0 && <h3 className="side-h">Agents</h3>}
          {groups.others.map((g) => (
            <Group key={g.agent.key} g={filter(g)} lane={laneOf(lane, g.agent.key)} crew={crew} selected={selected} go={go} searching={!!q} />
          ))}
        </nav>
      ))}
    </aside>
  );
}

/** Settled chats and tasks: searchable; a click views one, Reopen brings it back to the active list. */
function SettledList({ selected, go, reloadList }: { selected: string | null; go: (h: string) => void; reloadList: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SettledItem[] | null>(null);
  const load = useCallback(() => api.settledList(q.trim()).then((r) => setItems(r.settled), () => setItems([])), [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [load]);
  const hash = (i: SettledItem) => (i.kind === "chat" ? `#/c/${i.identifier}` : `#/t/${i.identifier}`);
  const reopen = async (i: SettledItem) => {
    await api.settle(i.identifier, false).catch(() => undefined);
    reloadList();
    void load();
    go(hash(i));
  };
  return (
    <div className="side-scroll settled-list">
      <input className="side-search" type="search" placeholder="Search settled" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settled chats and tasks" autoFocus />
      {!items ? (
        <ChatListSkeleton count={3} />
      ) : !items.length ? (
        <p className="side-empty muted small">{q ? "No matches." : "Nothing settled yet. Settle a finished chat or task to keep the active list short."}</p>
      ) : (
        <ul className="side-chats">
          {items.map((i) => (
            <li key={i.issueId}>
              <div className={`settled-row${i.identifier === selected ? " on" : ""}`}>
                <button className="settled-open" onClick={() => go(hash(i))} title={`View ${i.identifier} without reopening`}>
                  <span className="side-chat-title">{i.title}</span>
                  <span className="muted small">
                    {i.agent} · {i.kind} · settled {ago(i.at)}
                  </span>
                </button>
                <button className="btn reopen-btn" onClick={() => void reopen(i)}>
                  Reopen
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Group({ g, lane, crew, selected, go, front, searching }: { g: AgentGroup; lane?: LaneAgent; crew: Assignee[]; selected: string | null; go: (h: string) => void; front?: boolean; searching?: boolean }) {
  const inMore = g.more.some((c) => c.identifier === selected);
  const inEarlier = g.earlier.some((c) => c.identifier === selected);
  const inTests = g.tests.some((c) => c.identifier === selected);
  const holds = g.chats.some((c) => c.identifier === selected) || inMore || inEarlier || inTests || [...g.handedOut.values()].flat().some((c) => c.identifier === selected);
  const laneOn = selected === `lane:${g.agent.key}`;
  const [open, setOpen] = useState(front || holds || laneOn || !!lane || g.chats.length > 0);
  const [showMore, setShowMore] = useState(inMore);
  const [showEarlier, setShowEarlier] = useState(inEarlier);
  const [showTests, setShowTests] = useState(inTests);
  useEffect(() => {
    if (holds || laneOn) setOpen(true);
    if (inMore) setShowMore(true);
    if (inEarlier) setShowEarlier(true);
    if (inTests) setShowTests(true);
  }, [holds, laneOn, inMore, inEarlier, inTests]);
  const row = (c: ChatRow) => (
    <li key={c.identifier}>
      <ChatLink c={c} selected={selected} go={go} tasks={g.handedOut.get(c.identifier)} />
    </li>
  );
  return (
    <section className={`side-group${front ? " front" : ""}`}>
      <div className="side-agent">
        <button className="side-agent-btn" onClick={() => (front && !open ? setOpen(true) : setOpen(!open))} aria-expanded={open}>
          <Monogram name={g.agent.name} size={front ? 32 : 26} front={front} avatar={portraitOf(crew, g.agent.key)} />
          <span className="side-agent-name">{g.agent.name}</span>
          {g.count && (
            <span className={`side-count ${g.count.kind}`} title={`${g.count.n} of ${g.agent.name}'s chats (and the work they handed out) ${g.count.kind === "needs" ? "need you" : "working now"}`}>
              {g.count.kind === "needs" ? <i className="needs-dot" /> : <i className="live-dot" />}
              {g.count.n} {g.count.kind === "needs" ? (g.count.n === 1 ? "needs you" : "need you") : "working"}
            </span>
          )}
          {!open && g.unread && <span className="unread-dot" title="New reply" />}
          <span className={`chev${open ? " open" : ""}`} aria-hidden>
            <Chevron />
          </span>
        </button>
        <button className="icon-btn subtle" title={`New chat with ${g.agent.name}`} aria-label={`New chat with ${g.agent.name}`} onClick={() => go(`#/c/?to=${encodeURIComponent(g.agent.key)}`)}>
          <PlusIcon />
        </button>
      </div>
      {open && (
        <ul className="side-chats">
          {lane && !searching && (
            <li>
              <button className={`side-chat${laneOn ? " on" : ""}`} onClick={() => go(`#/c/lane:${lane.key}`)} title={`${lane.name}: fast chat`}>
                <span className="side-chat-top">
                  <span className="side-chat-title">Fast chat</span>
                </span>
              </button>
            </li>
          )}
          {!lane && !g.chats.length && !g.earlier.length && !g.tests.length && <li className="side-empty muted small">{searching ? "No matches." : "No chats yet."}</li>}
          {g.chats.map(row)}
          {showMore && g.more.map(row)}
          {g.more.length > 0 && !showMore && (
            <li>
              <button className="side-toggle" onClick={() => setShowMore(true)}>
                Show {g.more.length} more
              </button>
            </li>
          )}
          {g.earlier.length > 0 && (
            <li>
              <button className="side-toggle" aria-expanded={showEarlier || !!searching} onClick={() => setShowEarlier(!showEarlier)}>
                Earlier ({g.earlier.length})
                <span className={`chev${showEarlier || searching ? " open" : ""}`} aria-hidden>
                  <Chevron />
                </span>
              </button>
            </li>
          )}
          {(showEarlier || searching) && g.earlier.map(row)}
          {g.tests.length > 0 && (
            <li>
              <button className="side-toggle" aria-expanded={showTests || !!searching} onClick={() => setShowTests(!showTests)} title="Chats titled TEST or throwaway">
                Tests ({g.tests.length})
                <span className={`chev${showTests || searching ? " open" : ""}`} aria-hidden>
                  <Chevron />
                </span>
              </button>
            </li>
          )}
          {(showTests || searching) &&
            g.tests.map((c) => (
              <li key={c.identifier} className="side-test">
                <ChatLink c={c} selected={selected} go={go} />
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function ChatLink({ c, selected, go, tasks }: { c: ChatRow; selected: string | null; go: (h: string) => void; tasks?: ChatRow[] }) {
  const t = tasks?.length ? taskSummary(tasks) : undefined;
  return (
    <button
      className={`side-chat${c.identifier === selected ? " on" : ""}${c.open ? "" : " closed"}`}
      title={c.title}
      onClick={() => go(`#/c/${c.identifier}`)}
      // Warmed on hover or focus, so the click paints the conversation at once.
      onPointerEnter={() => prefetchChat(c.identifier)}
      onFocus={() => prefetchChat(c.identifier)}
    >
      <span className="side-chat-top">
        <span className={`side-chat-title${c.unread ? " unread" : ""}`}>{c.title}</span>
        <span className="side-time">{ago(c.preview?.at ?? c.updatedAt)}</span>
      </span>
      <span className="side-chat-bottom">
        <span className="side-preview">{c.preview ? `${c.preview.from === "you" ? "You: " : ""}${c.preview.text}` : ""}</span>
        {isActive(c.state) && <TaskState state={c.state} bare />}
        {c.unread && <span className="unread-dot" title="New reply" />}
      </span>
      {t && (
        <span className="side-tasks">
          {t.busy && <span className="live-dot" title="Working" />}
          {t.total} task{t.total > 1 ? "s" : ""}
          {t.needs > 0 && (
            <>
              {" · "}
              <b className="side-tasks-needs">{t.needs} needs you</b>
            </>
          )}
        </span>
      )}
    </button>
  );
}

// ------------------------------------------------------------------ a new chat (the home screen)

const STARTERS = ["What's waiting on me today?", "Who is working on what right now?", "Brief me on yesterday", "I need a new agent for…"];

function NewChat({ agents, crew, mobile, go, toast, reloadList }: { agents: ChatAgent[]; crew: Assignee[]; mobile: boolean; go: (h: string) => void; toast: (t: string) => void; reloadList: () => Promise<void> }) {
  const to = new URLSearchParams(location.hash.split("?")[1] ?? "").get("to") ?? "";
  const text = new URLSearchParams(location.hash.split("?")[1] ?? "").get("text") ?? ""; // a pre-filled message (Settings: Ask Aiden)
  const [agent, setAgent] = useState(to);
  useEffect(() => setAgent(to), [to]);
  const front = agents.find((a) => a.front);
  const name = agents.find((a) => a.key === agent)?.name ?? front?.name ?? "Aiden";
  const send = async (text: string, files: File[]) => {
    const { identifier } = await api.newChat(text || `Files: ${files.map((f) => f.name).join(", ")}`, agent || undefined);
    for (const f of identifier.startsWith("lane:") ? [] : files) await api.attach(identifier, f).catch((e: Error) => toast(`Couldn't attach ${f.name}: ${e.message}`));
    await reloadList();
    go(`#/c/${identifier}`);
  };
  return (
    <section className="ws-main ws-home">
      {mobile && (
        <header className="conv-head">
          <button className="icon-btn" aria-label="Back to chats" onClick={() => go("#/")}>
            <Icon name="back" size={20} />
          </button>
          <span className="conv-name">New chat</span>
        </header>
      )}
      <div className="home-center">
        <Monogram name={name} size={56} front={!agent || agent === front?.key} avatar={portraitOf(crew, agent || front?.key || "")} />
        <h1 className="home-title">What should {name} take off your plate?</h1>
        <div className="home-to">
          <label className="muted small" htmlFor="home-agent">
            To
          </label>
          <select id="home-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{front?.name ?? "Aiden"}</option>
            {agents
              .filter((a) => !a.front)
              .map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
        <Composer key={`${agent}|${text}`} initialText={text} placeholder={`Message ${name}`} draftKey={`draft:new:${agent}`} mobile={mobile} autoFocus={!mobile} onSend={send} starters={!agent || agent === front?.key ? STARTERS : []} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the conversation

interface Pending {
  id: number;
  text: string;
  files: string[];
  state: "sending" | "sent" | "failed";
  queued: boolean;
  error?: string;
  retry: () => void;
}

/**
 * Messages on their way, per chat, outside any component: switching chats and back keeps a sending or failed message
 * (with its Retry) in place, and a send that lands after the switch still settles.
 */
const outbox = { byChat: new Map<string, Pending[]>(), listeners: new Set<() => void>() };
const NOTHING_PENDING: Pending[] = [];
function setOutbox(ref: string, fn: (p: Pending[]) => Pending[]) {
  const now = outbox.byChat.get(ref) ?? NOTHING_PENDING;
  const next = fn(now);
  if (next === now) return;
  if (next.length) outbox.byChat.set(ref, next);
  else outbox.byChat.delete(ref);
  outbox.listeners.forEach((l) => l());
}
/** One send at a time per chat, in the order written: the box is free at once, but messages never overtake each other. */
const turns = new Map<string, Promise<void>>();
function inTurn(ref: string, run: () => Promise<void>): Promise<void> {
  const next = (turns.get(ref) ?? Promise.resolve()).then(run);
  turns.set(ref, next);
  void next.then(() => turns.get(ref) === next && turns.delete(ref));
  return next;
}
const subscribeOutbox =(l: () => void) => (outbox.listeners.add(l), () => void outbox.listeners.delete(l));
const useOutbox = (ref: string) => useSyncExternalStore(subscribeOutbox, () => outbox.byChat.get(ref) ?? NOTHING_PENDING);

type Ask = ChatDetail["asks"][number];
type Item = { at: string; key: string } & ({ type: "message"; m: ChatMessage } | { type: "approval"; a: Approval } | { type: "ask"; q: Ask });

function Conversation({ refId, row, mobile, crew, prefix, go, onSignIn, toast, panel, togglePanel, reloadList }: { refId: string; row?: ChatRow; mobile: boolean; crew: Assignee[]; prefix: string; go: (h: string) => void; onSignIn: () => void; toast: (t: string) => void; panel: boolean; togglePanel: () => void; reloadList: () => Promise<void> }) {
  // From the cache (queries.ts): a chat opened before (or warmed by a hover) paints at once, then refreshes.
  const query = useQuery(chatQuery(refId), onSignIn);
  const chat = query.data ?? null;
  // One read of the delegated work, for the strip above the conversation and the Details panel.
  const lineage = useLineage(refId, onSignIn);
  const error = query.error;
  const load = query.reload;
  // Cards shown from an earlier load can't be decided until the fresh copy lands (as on Approvals).
  const hold = query.stale;
  const stop = async () => {
    try {
      await api.stop(refId);
      toast("Stopped");
      await Promise.all([load(), reloadList()]);
    } catch (e) {
      toast(`Couldn't stop: ${(e as Error).message}`);
    }
  };
  // Opened while a hover's prefetch (which leaves it unread) is still on its way: read it properly once that lands.
  useEffect(() => void (peekingChat(refId) && load()), [refId, load]);
  const pending = useOutbox(refId);
  const setPending = useCallback((fn: (p: Pending[]) => Pending[]) => setOutbox(refId, fn), [refId]);
  const [sheet, setSheet] = useState(false);
  // A sent message drops its placeholder once it shows in the conversation.
  useEffect(() => {
    if (!chat) return;
    const said = new Set(chat.messages.filter((m) => m.kind === "owner").map((m) => (m as { text: string }).text.trim()));
    setPending((p) => (p.some((x) => x.state === "sent" && said.has(x.text.trim())) ? p.filter((x) => x.state !== "sent" || !said.has(x.text.trim())) : p));
  }, [chat, pending, setPending]);
  const live = anyLive(chat ? [chat, ...chat.handedOut] : []);
  usePoll(load, live, 8_000);
  // Changes arrive at once (events.ts): a message from either side, the run starting, saying more or ending, the work
  // handed out moving on, a card filed or decided, a grade.
  useEvents(["chat", "tasks", "progress"], load, chat?.id);
  useEvents(["approvals", "grades"], load);

  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const count = (chat?.messages.length ?? 0) + pending.length + (chat?.approvals.length ?? 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd) el.scrollTop = el.scrollHeight;
    // Follows the end only when the chat grows or its state changes, not on every render.
  }, [count, chat?.working?.said, chat?.state]);
  // At the end, stay there as the conversation grows under you: a failed send's Retry line, a card's outcome, rows
  // drawn at their real height after an estimate (content-visibility).
  // Updated straight from the scroll handler (not on the next render), so a slow scroll up stops the sticking at once.
  const stick = useRef(atEnd);
  const lastTop = useRef(0);
  const shown = !!chat;
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    ro.observe(inner);
    return () => ro.disconnect();
  }, [shown]);
  const toEnd = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  /**
   * The message shows at once (pending), the box is free for the next one straight away, and the send runs on its own:
   * a failure stays on the message with Retry, even after a switch to another chat and back.
   */
  async function send(text: string, files: File[], answer = false) {
    const id = Date.now() + Math.random();
    const queued = live;
    const q = chatQuery(refId);
    const attempt = async () => {
      setOutbox(refId, (p) => p.map((x) => (x.id === id ? { ...x, state: "sending", error: undefined } : x)));
      try {
        const names: string[] = [];
        for (const f of files) {
          await api.attach(refId, f);
          names.push(f.name);
        }
        if (text.trim()) {
          const body = names.length ? `${text.trimEnd()}\n\nAttached: ${names.map((n) => `\`${n.replace(/`/g, "")}\``).join(", ")}` : text;
          const view = await api.comment(refId, body, answer, true);
          if (view.movedTo) toast(`Sent to ${view.movedTo}`);
          setOutbox(refId, (p) => p.map((x) => (x.id === id ? { ...x, text: body, state: "sent" } : x)));
        } else setOutbox(refId, (p) => p.filter((x) => x.id !== id));
        // Through the cache, not this view: it may have closed by now.
        await Promise.all([loadCached(q.key, q.fetch, false, true), reloadList()]);
      } catch (e) {
        if (e instanceof SignInRequired) onSignIn();
        setOutbox(refId, (p) => p.map((x) => (x.id === id ? { ...x, state: "failed", error: (e as Error).message } : x)));
      }
    };
    setOutbox(refId, (p) => [...p, { id, text, files: files.map((f) => f.name), state: "sending", queued, retry: () => void inTurn(refId, attempt) }]);
    (stick.current = true), setAtEnd(true);
    void inTurn(refId, attempt);
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  const answer = useCallback((t: string) => void sendRef.current(t, [], true), []);
  // The form's answer to the question the kernel says is open: claimed against that wait (never routed by @mentions), then the chat refreshes.
  const waitSince = chat?.state?.wait_since;
  const answerAsk = useCallback(
    async (t: string) => {
      if (!waitSince) throw new Error("This question was already answered or has changed.");
      await api.answer(refId, t, waitSince);
      const q = chatQuery(refId);
      await Promise.all([loadCached(q.key, q.fetch, false, true), reloadList()]).catch(() => {});
    },
    [refId, waitSince, reloadList],
  );
  const openChat = useCallback((id: string) => go(`#/c/${id}`), [go]);

  async function settle(on: boolean) {
    await api.settle(refId, on).then(
      () => toast(on ? `Settled “${shortTitle(chat!.title)}”` : "Back in the active list"),
      (e: Error) => toast(`Couldn't ${on ? "settle" : "reopen"}: ${e.message}`),
    );
    await reloadList();
  }

  const notRight = useCallback(
    async (text: string) => {
      try {
        await api.notRight(refId, text);
      } catch (e) {
        toast(`Couldn't send the correction: ${(e as Error).message}`);
        return false;
      }
      toast("Sent back as a correction");
      await load();
      return true;
    },
    [refId, toast, load],
  );

  // Messages, cards and questions in time order; runs of progress lines (notes, wake-ups) fold to one line.
  const items: Folded<Item>[] = useMemo(() => {
    if (!chat) return [];
    const list: Item[] = [
      ...chat.messages.map((m) => ({ type: "message" as const, m, at: m.at, key: m.id })),
      ...chat.approvals.map((a) => ({ type: "approval" as const, a, at: a.createdAt, key: a.id })),
      ...(chat.asks ?? []).map((q) => ({ type: "ask" as const, q, at: q.at, key: q.id })),
    ];
    return foldNoise(
      list.sort((x, y) => x.at.localeCompare(y.at)),
      (it) => it.type === "message" && isNoise(it.m),
    );
  }, [chat?.messages, chat?.approvals, chat?.asks]);
  const messages = chat?.messages;
  const lastReply = useMemo(() => messages && [...messages].reverse().find((m) => m.kind === "reply" || m.kind === "owner"), [messages]);
  // Questions stay answerable after the agent posts later updates, for as long as the kernel says the chat waits on the owner's
  // answer: the newest reply that offered some.
  const waits = waitsForAnswer(chat?.state);
  const asking = useMemo(() => (waits ? messages?.findLast((m) => m.kind === "reply" && m.questions?.length) : undefined), [messages, waits]);
  // The conversation itself is rebuilt only when what it shows changes: typing, the live clock and polls that bring
  // nothing new leave it alone, and a new message re-renders only its own row (MessageView is memoised).
  const open = chat?.open ?? false;
  const conversationRows = useMemo(
    () =>
      items.map((it, i) => {
        const prev = items[i - 1];
        const day = new Date(it.at).toDateString();
        const sep = !prev || new Date(prev.at).toDateString() !== day;
        return (
          <div key={it.key} className="conv-item">
            {sep && <div className="day-sep">{dayLabel(it.at)}</div>}
            {it.type === "fold" ? (
              <NoiseFold lines={it.items.map((x) => (x as Item & { type: "message" }).m)} from={it.at} until={it.until} prefix={prefix} />
            ) : it.type === "approval" ? (
              <ul className="approval-list inline">
                <ApprovalCard a={it.a} open={openChat} inline prefix={prefix} hold={hold} />
              </ul>
            ) : it.type === "ask" ? (
              <AskView q={it.q} crew={crew} prefix={prefix} go={go} answered={load} toast={toast} />
            ) : (
              <MessageView m={it.m} crew={crew} prefix={prefix} lastReply={it.m === lastReply} asking={it.m === asking} open={open} notRight={notRight} answer={answer} answerAsk={answerAsk} />
            )}
          </div>
        );
      }),
    [items, crew, prefix, lastReply, asking, open, hold, openChat, load, go, toast, notRight, answer, answerAsk],
  );

  if (!chat)
    return (
      <section className="ws-main conv">
        {/* The chat's header comes from its row in the list, so only the messages wait. */}
        {row && (
          <header className="conv-head">
            {mobile && (
              <button className="icon-btn" aria-label="Back to chats" onClick={() => go("#/")}>
                <Icon name="back" size={20} />
              </button>
            )}
            <Monogram name={row.agent.name} size={32} avatar={portraitOf(crew, row.agent.key)} />
            <span className="conv-who">
              <span className="conv-name" title={row.title}>
                {shortTitle(row.title)}
              </span>
              <span className="conv-title">
                {row.agent.name} · {row.identifier}
              </span>
            </span>
          </header>
        )}
        {error ? (
          <div className="alert">
            Couldn't open this chat: {error}{" "}
            <button className="link-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="sk-conv" role="status" aria-label="Opening the chat">
            <SkeletonLines lines={2} />
            <SkeletonLines lines={4} />
            <SkeletonLines lines={3} />
          </div>
        )}
      </section>
    );

  const needs = groupTasks(chat.handedOut).needs.length;
  const shut = mobile ? !sheet : !panel;
  return (
    <>
      <section
        className="ws-main conv"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
      >
        <header className="conv-head">
          {mobile && (
            <button className="icon-btn" aria-label="Back to chats" onClick={() => go("#/")}>
              <Icon name="back" size={20} />
            </button>
          )}
          <Monogram name={chat.agent.name} size={32} avatar={portraitOf(crew, chat.agent.key)} />
          <span className="conv-who">
            <span className="conv-name" title={chat.title}>
              {shortTitle(chat.title)}
            </span>
            <span className="conv-title">
              {chat.agent.name} · {chat.identifier}
            </span>
          </span>
          <TaskState state={chat.state} />
          {row?.settled ? (
            <button className="btn settle-btn on" onClick={() => void settle(false)} title="Settled: bring it back to the active list">
              ◆ Settled · Reopen
            </button>
          ) : (
            !live &&
            settleableChat(chat.state) && (
              <button className="btn settle-btn" onClick={() => void settle(true)} title="Move this finished chat to Settled">
                ◆ Settle
              </button>
            )
          )}
          {chat.runs.length > 0 && (
            <a className="btn last-run-btn" href={`#/r/${chat.runs[0]!.id}`} title="The trace of this chat's latest run">
              Last run
            </a>
          )}
          <button className={`btn details-btn${shut ? "" : " on"}`} aria-expanded={!shut} onClick={() => (mobile ? setSheet(!sheet) : togglePanel())} title="Tasks, progress, files and context">
            {mobile || shut ? "Details" : "Hide details"}
            {shut && needs > 0 && (
              <span className="details-needs" title={`${needs} task${needs > 1 ? "s" : ""} need${needs > 1 ? "" : "s"} you`}>
                {needs}
              </span>
            )}
          </button>
        </header>
        {chat.parent && (
          <div className="conv-from muted small">
            Handed out from{" "}
            <a href={`#/c/${chat.parent.identifier}`} onClick={(e) => (e.preventDefault(), go(`#/c/${chat.parent!.identifier}`))}>
              {chat.parent.title}
            </a>
          </div>
        )}
        <LineageStrip data={lineage} refId={chat.identifier} title={chat.title} agent={chat.agent.name} crew={crew} prefix={prefix} href={(id) => `#/c/${id}`} onSignIn={onSignIn} />
        <FeatureCostStrip refId={chat.identifier} />
        <div
          className="conv-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            // Any move up is the reader leaving the end, even within 80px of it: rows above drawn at their real height
            // (content-visibility) resize the list, and sticking then would snap a slow scroll back down.
            const up = el.scrollTop < lastTop.current;
            lastTop.current = el.scrollTop;
            const end = !up && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            stick.current = end;
            setAtEnd(end);
          }}
        >
          <div className="conv-inner">
            {!items.length && !pending.length && <p className="conv-empty muted">No messages yet.</p>}
            {conversationRows}
            {pending.map((p) => (
              <div key={p.id} className={`msg owner pending ${p.state}`}>
                <div className="bubble">{p.text || p.files.join(", ")}</div>
                <div className="msg-meta">
                  {p.state === "failed" ? (
                    <>
                      <span className="bad">Not sent{p.error ? `: ${p.error}` : ""}</span> ·{" "}
                      <button className="link-btn" onClick={p.retry}>
                        Retry
                      </button>
                    </>
                  ) : p.state === "sending" ? (
                    p.files.length ? "Uploading…" : "Sending…"
                  ) : p.queued ? (
                    "Queued for the next turn"
                  ) : (
                    "Sent"
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {!atEnd && (
          <button className="jump-end" onClick={toEnd} aria-label="Jump to the latest message">
            ↓
          </button>
        )}
        <LiveRow chat={chat} retry={() => void send("Please try again.", [], true)} stop={stop} />
        <Composer
          placeholder={`Message ${chat.agent.name}${chat.open ? "" : " (this reopens the chat)"}`}
          draftKey={`draft:${chat.id}`}
          mobile={mobile}
          crew={crew}
          autoFocus={!mobile}
          onSend={send}
          dropZone
        />
      </section>
      {!mobile && panel && (
        <aside className="ws-panel" aria-label="Details">
          <button className="icon-btn subtle panel-close" aria-label="Hide details" onClick={togglePanel}>
            <CloseIcon />
          </button>
          <DetailsPanel chat={chat} lineage={lineage} go={go} />
        </aside>
      )}
      {mobile && sheet && (
        <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Details">
            <button className="icon-btn subtle sheet-close" aria-label="Close" onClick={() => setSheet(false)}>
              <CloseIcon />
            </button>
            <DetailsPanel
              chat={chat}
              lineage={lineage}
              go={(h) => {
                setSheet(false);
                go(h);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const MessageView = memo(function MessageView({ m, crew, prefix, lastReply, asking, open, notRight, answer, answerAsk }: { m: ChatMessage; crew: Assignee[]; prefix: string; lastReply: boolean; asking: boolean; open: boolean; notRight: (t: string) => Promise<boolean>; answer: (t: string) => void; answerAsk: (t: string) => Promise<unknown> }) {
  const [fixing, setFixing] = useState(false);
  const [fix, setFix] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The box closes and clears only when the correction went; a failure keeps the text.
  const sendFix = () => {
    setBusy(true);
    void notRight(fix.trim()).then((sent) => {
      setBusy(false);
      if (sent) (setFixing(false), setFix(""));
    });
  };
  if (m.kind === "owner")
    return (
      <div className="msg owner">
        <div className="bubble">
          {m.correction && <span className="tag bad">Not right</span>}
          <Markdown text={m.text} prefix={prefix} className="md" />
        </div>
        <div className="msg-meta" title={new Date(m.at).toLocaleString()}>
          {clock(m.at)}
          {m.by ? ` · by ${m.by}` : ""}
          {m.via ? ` · via ${m.via}` : ""}
        </div>
      </div>
    );
  if (m.kind === "notice") return <div className="notice">{m.text}</div>;
  if (m.kind === "notes")
    return (
      <div className="notes">
        <button className="notes-line" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          {m.agent} · {m.notes.length === 1 ? "1 note" : `${m.notes.length} notes`} · {clock(m.at)} <span className={`chev${expanded ? " open" : ""}`} aria-hidden>
            <Chevron />
          </span>
        </button>
        {expanded && (
          <ol className="notes-list">
            {m.notes.map((n, i) => (
              <li key={i}>
                <span className="muted small">
                  {n.by} · {clock(n.at)}
                </span>
                <Markdown text={n.text} prefix={prefix} className="md" />
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  const long = m.text.split("\n").length > 25 || m.text.length > 2400;
  return (
    <div className="msg agent">
      <div className="msg-who">
        <Monogram name={m.agent} size={26} avatar={portraitOf(crew, m.agent)} /> <b className="msg-name">{m.agent}</b> <span className="msg-time">{clock(m.at)}</span>
      </div>
      <div className={`bubble${long && !expanded ? " clipped" : ""}`}>
        <Markdown text={m.text} prefix={prefix} className="md" />
      </div>
      {long && (
        <button className="link-btn small" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {lastReply && open && m.actions && (
        <div className="answers">
          {m.actions.map((a) => (
            <button key={a} className="btn answer" onClick={() => answer(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
      {m.run && (
        <a className="run-line muted small" href={`#/r/${m.run.id}`} title="Open this run's steps">
          Ran for {m.run.seconds >= 60 ? `${Math.floor(m.run.seconds / 60)}m ${m.run.seconds % 60}s` : `${m.run.seconds}s`}
          {m.run.trigger ? ` · ${m.run.trigger}` : ""} ›
        </a>
      )}
      {asking && open && m.questions && <AnswerForm questions={m.questions} onAnswer={answerAsk} />}
      <div className="msg-actions">
        <button className="link-btn small" onClick={() => setFixing(!fixing)} title="Tell the agent this reply was wrong (recorded as a correction)">
          Not right
        </button>
      </div>
      {fixing && (
        <div className="not-right">
          <input
            autoFocus
            placeholder="What's not right, in one line"
            value={fix}
            maxLength={500}
            onChange={(e) => setFix(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fix.trim() && !busy && sendFix()}
            aria-label="What's not right"
          />
          <button className="btn primary" disabled={!fix.trim() || busy} onClick={() => sendFix()}>
            Send
          </button>
        </div>
      )}
    </div>
  );
});

/** A run of progress lines (notes, wake-ups, card outcomes) as one muted line; a tap lists each in order. */
function NoiseFold({ lines, from, until, prefix }: { lines: ChatMessage[]; from: string; until: string; prefix: string }) {
  const [open, setOpen] = useState(false);
  const n = foldCount(lines);
  const span = clock(from) === clock(until) ? clock(from) : `${clock(from)}–${clock(until)}`;
  const entries = lines.flatMap((m) => (m.kind === "notes" ? m.notes.map((x) => ({ by: x.by, at: x.at, text: x.text })) : m.kind === "notice" ? [{ by: "Board", at: m.at, text: m.text }] : []));
  return (
    <div className="notes">
      <button className="notes-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        {n} updates · {span}{" "}
        <span className={`chev${open ? " open" : ""}`} aria-hidden>
          <Chevron />
        </span>
      </button>
      {open && (
        <ol className="notes-list">
          {entries.map((e, i) => (
            <li key={i}>
              <span className="muted small">
                {e.by} · {clock(e.at)}
              </span>
              <Markdown text={e.text} prefix={prefix} className="md" />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const STEP_ICON ={ tool: "⚙", thought: "…", message: "💬" } as const;

/** The latest line, a tap away from every step so far: proof the agent is working, not a guess. */
function Steps({ steps, said }: { steps: NonNullable<Working["steps"]>; said?: string }) {
  const [open, setOpen] = useState(false);
  const last = steps.at(-1)!;
  return (
    <div className="live-steps">
      <button className="live-said live-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="muted">{open ? "▾" : "▸"}</span> {said ?? last.text}
        {!open && <span className="muted small"> · {steps.length} steps</span>}
      </button>
      {open && (
        <ol className="step-list">
          {steps.map((s, i) => (
            <li key={i} className={`step-${s.kind}`}>
              <span className="step-icon" aria-hidden>{STEP_ICON[s.kind]}</span>
              <span className="step-text">{s.text}</span>
              {s.at && <span className="step-at muted small">{ago(s.at)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One live row pinned above the composer: what the run is doing now, or why it stopped. The plan lives in the panel. */
function LiveRow({ chat, retry, stop }: { chat: ChatDetail; retry: () => void; stop: () => void }) {
  const [, tick] = useState(0);
  const ticking = chat.state?.kind === "working";
  useEffect(() => {
    // Its clock ("1m 20s", "nothing new for 3 min"): only this row re-renders each second.
    if (!ticking) return;
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, [ticking]);
  const w = chat.working;
  const name = chat.agent.name;
  if (chat.state?.kind === "working" && w) {
    const lastAt = w.saidAt ?? w.since;
    const quiet = lastAt ? Date.now() - Date.parse(lastAt) : 0;
    return (
      <div className="live-row working">
        <div className="live-line">
          <span className="pulse" /> <b>{w.agent || name}</b> <span className="shimmer">is working</span>
          {w.since && <span className="live-clock">{elapsed(w.since)}</span>}
          {quiet > QUIET_MS && <span className="muted"> · nothing new for {Math.floor(quiet / 60_000)} min</span>}
          <button className="btn" onClick={stop}>
            Stop
          </button>
        </div>
        {w.steps?.length ? <Steps steps={w.steps} said={w.said} /> : w.said && <div className="live-said">{w.said}</div>}
      </div>
    );
  }
  if (chat.state?.kind === "working")
    return (
      <div className="live-row working">
        <div className="live-line">
          <span className="pulse" /> <b>{name}</b> <span className="shimmer">is working</span>
          <button className="btn" onClick={stop}>
            Stop
          </button>
        </div>
      </div>
    );
  if (chat.state?.reason === "job_queued") return <div className="live-row">Queued: {name} starts when free.</div>;
  if (chat.state?.reason === "card_owner") return <div className="live-row you">Waiting for your approval (above).</div>;
  if (waitsForAnswer(chat.state)) return <div className="live-row you">Needs your input.</div>;
  if (chat.state?.reason === "failed")
    return (
      <div className="live-row failed">
        {`${name} stopped: ${chat.state.refLabel ?? "no reason given"}.`}{" "}
        <button className="btn" onClick={retry}>
          Try again
        </button>
      </div>
    );
  if (!chat.open) return <div className="live-row muted">Finished. A new message reopens this chat.</div>;
  return null;
}

// ------------------------------------------------------------------ the right panel

/**
 * The one details panel: the chat's context in a line, then the work it handed out (the Lineage list, you first), then progress and files only when there are some.
 */
function DetailsPanel({ chat, lineage, go }: { chat: ChatDetail; lineage: Lineage | null; go: (h: string) => void }) {
  const files = chat.files.filter((f) => !f.textOf);
  const plan = chat.working?.plan ?? [];
  const done = plan.filter((p) => p.state === "done").length;
  const waiting = chat.approvals.filter((a) => a.state === "pending");
  const onYou = waiting.length ? `${waiting.length} approval${waiting.length > 1 ? "s" : ""}` : waitsForAnswer(chat.state) ? "a reply" : "";
  const quiet = !chat.handedOut.length && !lineage?.children.length && !plan.length && chat.state?.kind !== "working" && !files.length;
  return (
    <div className="panel">
      <dl className="panel-context" aria-label="Context">
        <div>
          <dt>State</dt>
          <dd>{chat.state ? <TaskState state={chat.state} /> : chat.open ? "open" : "finished"}</dd>
        </div>
        <div>
          <dt>On you</dt>
          <dd className={onYou ? "needs" : ""}>{onYou || "nothing"}</dd>
        </div>
        {chat.runs.length > 0 && (
          <div className="panel-run">
            <dt>Run</dt>
            <dd>
              <a href={`#/r/${chat.runs[0]!.id}`} onClick={(e) => (e.preventDefault(), go(`#/r/${chat.runs[0]!.id}`))}>
                the latest
              </a>
            </dd>
          </div>
        )}
        {chat.parent && (
          <div className="wide">
            <dt>From</dt>
            <dd>
              <a href={`#/c/${chat.parent.identifier}`} onClick={(e) => (e.preventDefault(), go(`#/c/${chat.parent!.identifier}`))}>
                {chat.parent.title}
              </a>
            </dd>
          </div>
        )}
      </dl>
      {(chat.handedOut.length > 0 || (lineage?.children.length ?? 0) > 0) && (
        <section className="panel-card">
          <h3>
            Delegated{lineage && <span className="panel-count">{lineage.total.tasks}</span>}
          </h3>
          {lineage ? <DelegatedList lineage={lineage} go={go} /> : <p className="muted small">Loading…</p>}
        </section>
      )}
      {(plan.length > 0 || chat.state?.kind === "working") && (
        <section className="panel-card">
          <h3>
            Progress
            {plan.length > 0 && (
              <span className="panel-count">
                {done} of {plan.length}
              </span>
            )}
          </h3>
          {plan.length > 0 && (
            <div className="meter" aria-hidden>
              <i style={{ width: `${(100 * done) / plan.length}%` }} />
            </div>
          )}
          {plan.length > 0 ? <Plan items={plan} /> : <p className="muted small">Working; no plan shared yet.</p>}
        </section>
      )}
      {files.length > 0 && (
        <section className="panel-card">
          <h3>
            Files<span className="panel-count">{files.length}</span>
          </h3>
          <ul className="panel-list">
            {files.map((f) => (
              <FileRow key={f.id} f={f} chatId={chat.id} />
            ))}
          </ul>
        </section>
      )}
      {quiet && <p className="panel-empty muted small">Work this chat hands out, its plan and any files show here. Drop a file on the chat to attach it.</p>}
    </div>
  );
}

function FileRow({ f, chatId }: { f: FileView; chatId: string }) {
  return (
    <li>
      <a href={`/api/issues/${encodeURIComponent(chatId)}/files/${f.id}`} target="_blank" rel="noopener noreferrer">
        {f.name}
      </a>
      <span className="muted small">
        {fileSize(f.size)} · {f.by === "me" ? "you" : "agent"} · {ago(f.createdAt)}
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ the composer

export function Composer({ initialText, placeholder, draftKey, mobile, crew = [], autoFocus, onSend, starters = [], dropZone, noFiles }: { initialText?: string; placeholder: string; draftKey: string; mobile: boolean; crew?: Assignee[]; autoFocus?: boolean; onSend: (text: string, files: File[]) => Promise<void>; starters?: string[]; dropZone?: boolean; /** The conversation can't take files (Fast chat): no attach button, no pasted files. */ noFiles?: boolean }) {
  const [text, setText] = useState(() => {
    if (initialText) return initialText;
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const typed = crew.length ? /(?:^|\s)@([A-Za-z]*)$/.exec(text.slice(0, caret)) : null;
  const offers = typed ? crew.filter((a) => a.kind !== "me" && handleOf(a).toLowerCase().startsWith(typed[1]!.toLowerCase())).slice(0, 6) : [];
  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, text]);
  // The box grows with its text. Resetting its height lays out the whole conversation above it, so that happens only
  // when the text got shorter (it may need to shrink) or no longer fits; a keystroke that fits costs nothing.
  const typedLength = useRef(text.length);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const shorter = text.length < typedLength.current;
    typedLength.current = text.length;
    if (!shorter && el.scrollHeight <= el.clientHeight) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);
  // Drop anywhere on the conversation, not only on the box.
  useEffect(() => {
    if (!dropZone) return;
    const pane = box.current?.closest(".ws-main");
    if (!pane) return;
    const over = (e: Event) => {
      const d = (e as DragEvent).dataTransfer;
      if (d?.types.includes("Files")) (e.preventDefault(), setDragging(true));
    };
    const leave = (e: Event) => {
      if (e.target === pane || !(pane as HTMLElement).contains((e as DragEvent).relatedTarget as Node)) setDragging(false);
    };
    const drop = (e: Event) => {
      const d = (e as DragEvent).dataTransfer;
      setDragging(false);
      if (d?.files.length) (e.preventDefault(), add(d.files));
    };
    pane.addEventListener("dragover", over);
    pane.addEventListener("dragleave", leave);
    pane.addEventListener("drop", drop);
    return () => {
      pane.removeEventListener("dragover", over);
      pane.removeEventListener("dragleave", leave);
      pane.removeEventListener("drop", drop);
    };
  });
  function add(list: FileList | null | undefined) {
    const picked = [...(list ?? [])];
    const big = picked.filter((f) => f.size > MAX_FILE);
    setNote(big.length ? `${big.map((f) => f.name).join(", ")} ${big.length > 1 ? "are" : "is"} over 10 MB and can't be sent.` : "");
    setFiles((now) => [...now, ...picked.filter((f) => f.size <= MAX_FILE && f.size > 0)]);
  }
  function mention(a: Assignee) {
    const start = caret - typed![1]!.length;
    const next = `${text.slice(0, start)}${handleOf(a)} ${text.slice(caret)}`;
    setText(next);
    const at = start + handleOf(a).length + 1;
    setCaret(at);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  }
  async function send() {
    if ((!text.trim() && !files.length) || busy) return;
    const t = text;
    const f = files;
    setBusy(true);
    setText("");
    setFiles([]);
    try {
      await onSend(t, f);
    } catch (e) {
      // Nothing is lost: the words and files come back to the box.
      setText(t);
      setFiles(f);
      setNote(`Couldn't send: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }
  return (
    <footer className="ws-composer">
      {dragging && <div className="drop-hint">Drop files to attach them</div>}
      {starters.length > 0 && !text && (
        <div className="starters">
          {starters.map((s) => (
            <button key={s} className="btn starter" onClick={() => (setText(s), box.current?.focus())}>
              {s}
            </button>
          ))}
        </div>
      )}
      {offers.length > 0 && (
        <div className="mention-offers" role="listbox" aria-label="Mention an agent">
          {offers.map((a) => (
            <button key={a.key} className="mention-offer" role="option" aria-selected={a === offers[0]} onMouseDown={(e) => (e.preventDefault(), mention(a))}>
              @{handleOf(a)}
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        {files.length > 0 && (
          <div className="attach-list">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="attach-chip">
                {f.name} <span className="muted small">{fileSize(f.size)}</span>
                <button className="icon-btn subtle" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => setFiles((now) => now.filter((x) => x !== f))}>
                  <CloseIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          rows={1}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={text}
          onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart))}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onPaste={(e) => {
            if (noFiles || !e.clipboardData.files.length) return;
            e.preventDefault();
            add(e.clipboardData.files);
          }}
          onKeyDown={(e) => {
            if (offers.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) return e.preventDefault(), mention(offers[0]!);
            // Enter sends on a computer (Shift+Enter: a new line); on a phone, return is a new line and Send sends.
            if (e.key === "Enter" && !e.shiftKey && !mobile && !e.nativeEvent.isComposing) return e.preventDefault(), void send();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return e.preventDefault(), void send();
          }}
          aria-label={placeholder}
        />
        <div className="composer-row">
          {!noFiles && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  add(e.target.files);
                  e.target.value = "";
                }}
              />
              <button className="icon-btn" title="Attach files" aria-label="Attach files" disabled={busy} onClick={() => picker.current?.click()}>
                <ClipIcon />
              </button>
            </>
          )}
          <span className="muted small composer-hint">{mobile ? "" : "Enter to send · Shift+Enter for a new line · @ to bring in an agent"}</span>
          <button className="send-btn" aria-label="Send" disabled={(!text.trim() && !files.length) || busy} onClick={() => void send()}>
            <SendIcon />
          </button>
        </div>
      </div>
      {note && (
        <div className="composer-note" role="status" onClick={() => setNote("")}>
          {note}
        </div>
      )}
    </footer>
  );
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 6l6 6-6 6" />
  </svg>
);
const ClipIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

/**
 * A question from an agent this chat handed work to, shown in this chat: the answer goes to that agent's own task (as
 * the owner's message there, which wakes it), not to this chat's agent.
 */
function AskView({ q, crew, prefix, go, answered, toast }: { q: Ask; crew: Assignee[]; prefix: string; go: (h: string) => void; answered: () => Promise<void>; toast: (t: string) => void }) {
  const answer = (t: string) => api.answer(q.identifier, t, q.waitSince).then(() => (toast(`Sent to ${q.agent}`), void answered()));
  return (
    <div className="msg agent">
      <div className="msg-who">
        <Monogram name={q.agent} size={26} avatar={portraitOf(crew, q.agent)} /> <b className="msg-name">{q.agent}</b>{" "}
        <span className="msg-time">
          {clock(q.at)} · on{" "}
          <a href={`#/c/${q.identifier}`} onClick={(e) => (e.preventDefault(), go(`#/c/${q.identifier}`))}>
            {q.identifier}
          </a>
        </span>
      </div>
      <div className="bubble">
        <Markdown text={q.text} prefix={prefix} className="md" />
      </div>
      <AnswerForm key={`${q.waitSince}:${q.questions.length}`} questions={q.questions} onAnswer={answer} />
    </div>
  );
}
