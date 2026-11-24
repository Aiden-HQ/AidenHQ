// The lineage strip under a chat's or task's header: one chip per delegated task, a dense table of every level on a click
// (opened by itself when one of them waits on an approval, with the Approvals page's card in that row), and the side chat:
// a question about a task, answered by a model, never posted on the task and never waking its agent.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { ApprovalCard } from "./Chat";
import { CloseIcon } from "./components";
import { useLive } from "./events";
import { Markdown } from "./markdown";
import type { AsideMessage, Assignee, Lineage, LineageRow } from "./types";
import { TaskState, needsOwner, stateWords } from "./ui/TaskState";

const tokens = (n: number | null) => (n === null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 0)}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}
const took = (r: LineageRow) => span((r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt));
const withKids = (r: LineageRow) => [r, ...r.children];
const costOf = (r: LineageRow) => (withKids(r).every((x) => x.usd === null) ? null : withKids(r).reduce((s, x) => s + (x.usd ?? 0), 0));
const waitsOnApproval = (r: LineageRow) => withKids(r).some((x) => x.approvals.length > 0);

interface Target {
  identifier: string;
  title: string;
  agent: string;
}

/** The delegated tasks, kept fresh: task changes and approvals (throttled: each read walks two levels of children) and a 15s poll; not every progress tick. */
export function useLineage(refId: string, onSignIn: () => void): Lineage | null {
  const [data, setData] = useState<Lineage | null>(null);
  const load = useCallback(
    () =>
      api.lineage(refId).then(setData, (e) => {
        if (e instanceof SignInRequired) onSignIn();
      }),
    [refId, onSignIn],
  );
  const last = useRef(0);
  const later = useRef<ReturnType<typeof setTimeout>>(undefined);
  const throttled = useCallback(() => {
    const wait = last.current + 4_000 - Date.now();
    if (wait > 0) return void (later.current ??= setTimeout(() => ((later.current = undefined), throttled()), wait));
    last.current = Date.now();
    return load();
  }, [load]);
  useEffect(() => () => clearTimeout(later.current), []);
  useLive(["tasks", "approvals"], throttled, 15_000);
  return data;
}

/** What waits on the owner (an approval card or his answer) comes first; the rest keep their order. */
const needsFirst = (rows: LineageRow[]) => [...rows].sort((a, b) => Number(waitsOnApproval(b) || needsOwner(b.state)) - Number(waitsOnApproval(a) || needsOwner(a.state)));

/** A chat's Details: the delegated work as dense rows, Needs you first; each row opens the child. */
export function DelegatedList({ lineage, go }: { lineage: Lineage | null; go: (hash: string) => void }) {
  const rows = needsFirst(lineage?.children ?? []);
  if (!rows.length) return null;
  const row = (r: LineageRow, grand: boolean) => (
    <li key={r.identifier}>
      <a className={`handed-row${grand ? " lin-sub" : ""}`} href={`#/c/${r.identifier}`} title={`${r.agent}: ${r.title}`} onClick={(e) => (e.preventDefault(), go(`#/c/${r.identifier}`))}>
        <span className="handed-title">{r.title}</span>
        <span className="handed-agent">
          {r.agent} · {took(r)}
        </span>
        <span className="handed-state">
          <TaskState state={r.state} bare />
        </span>
      </a>
    </li>
  );
  return <ul className="handed-list">{rows.flatMap((r) => [row(r, false), ...r.children.map((g) => row(g, true))])}</ul>;
}

export function LineageStrip({ data, refId, title, agent, crew, prefix, href, onSignIn }: { data: Lineage | null; refId: string; title: string; agent: string; crew: Assignee[]; prefix: string; href: (identifier: string) => string; onSignIn: () => void }) {
  const [table, setTable] = useState<boolean | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<{ target: Target; anchor: DOMRect; drawer: boolean } | null>(null);
  const threads = useRef(new Map<string, AsideMessage[]>());
  const rows = needsFirst(data?.children ?? []);
  // A pending approval anywhere below opens the table (unless the owner closed it) and unfolds the row that holds it.
  const pending = rows.filter(waitsOnApproval).map((r) => r.identifier).join();
  useEffect(() => {
    if (!pending) return;
    setUnfolded((u) => new Set([...u, ...pending.split(",")]));
  }, [pending]);
  const shown = table ?? Boolean(pending);
  const portrait = (name: string) => {
    const a = crew.find((c) => c.name === name);
    return a?.avatar;
  };
  if (!rows.length) return null;
  const t = data!.total;
  const open = (target: Target, el: HTMLElement) => setAsk({ target, anchor: el.getBoundingClientRect(), drawer: false });
  const toggleRow = (id: string) => setUnfolded((u) => (u.has(id) ? new Set([...u].filter((x) => x !== id)) : new Set([...u, id])));

  const line = (r: LineageRow, grand: boolean) => (
    <tr key={r.identifier} className={`${grand ? "lin-g" : ""}${r.approvals.length ? " lin-appr" : ""}`}>
      <td>
        {!grand && (
          <button className="lin-fold" aria-label={unfolded.has(r.identifier) ? "Fold sub-tasks" : "Show sub-tasks"} style={r.children.length ? undefined : { visibility: "hidden" }} onClick={() => toggleRow(r.identifier)}>
            {unfolded.has(r.identifier) ? "−" : "+"}
          </button>
        )}
        <span className="lin-ag">
          <AgentAvatar name={r.agent} portrait={portrait(r.agent)} size={18} />
          {r.agent}
        </span>
      </td>
      <td className="lin-task">
        <a href={href(r.identifier)} title={`${r.identifier}: ${r.title}`}>
          {r.title}
        </a>
      </td>
      <td className="lin-model">{r.model ?? "—"}</td>
      <td className="lin-state">
        <TaskState state={r.state} />
      </td>
      <td className={`lin-latest${r.state?.reason === "failed" ? " bad" : ""}`} title={r.latest?.text}>
        {r.latest?.text ?? ""}
      </td>
      <td className="r">{tokens(r.tokens)}</td>
      <td className="r">{usd(r.usd)}</td>
      <td className="r m">{took(r)}</td>
      <td className="lin-act">
        <button className={`btn sm ghost lin-ask${r.state?.reason === "failed" ? " shown" : ""}`} onClick={(e) => open(r, e.currentTarget)} title="Ask about this task: not posted, doesn't wake the agent">
          ✦ {r.state?.reason === "failed" ? "Why?" : "Ask"}
        </button>
      </td>
    </tr>
  );
  const cards = (r: LineageRow) =>
    r.approvals.length > 0 && (
      <tr key={`${r.identifier}:cards`} className="lin-cards">
        <td colSpan={9}>
          <ul className="approval-list">
            {r.approvals.map((a) => (
              <ApprovalCard key={a.id} a={a} open={(id) => (location.hash = href(id))} inline unfold prefix={prefix} />
            ))}
          </ul>
        </td>
      </tr>
    );

  return (
    <>
      <div className="lin-strip">
        <span className="lin-lead">
          Delegated <span className="lin-num">{rows.length} · {usd(t.usd)} · {span(t.ms)}</span>
        </span>
        <div className="lin-chips">
          {rows.map((r) => {
            const cost = costOf(r);
            const tone = waitsOnApproval(r) ? "needs" : r.state ? stateWords(r.state).tone : "idle";
            return (
              <button key={r.identifier} className={`lin-chip s-${tone}`} title={`${r.agent}: ${r.title}${r.state ? ` (${stateWords(r.state).word}${stateWords(r.state).detail ? `: ${stateWords(r.state).detail}` : ""})` : ""}`} onClick={() => setTable(!shown)}>
                <AgentAvatar name={r.agent} portrait={portrait(r.agent)} size={18} />
                <span className="lin-chip-name">{r.agent}</span>
                <span className="lin-c">
                  {r.children.length > 0 && `+${r.children.length}`}
                  {r.children.length > 0 && cost !== null && " · "}
                  {cost !== null && usd(cost)}
                </span>
              </button>
            );
          })}
        </div>
        <button className="btn sm ghost lin-ask-all" onClick={(e) => open({ identifier: refId, title, agent }, e.currentTarget)} title="Ask about this: not posted, doesn't wake the agent">
          ✦ Ask
        </button>
        <button className="link-btn lin-tog" aria-expanded={shown} onClick={() => setTable(!shown)}>
          {shown ? "Hide table ▴" : "Show table ▾"}
        </button>
      </div>
      {shown && (
        <div className="lin-table-wrap">
          <table className="lin-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Task</th>
                <th>Model</th>
                <th>Status</th>
                <th>Latest</th>
                <th className="r">Tokens</th>
                <th className="r">Cost</th>
                <th className="r">Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((r) => [line(r, false), cards(r), ...(unfolded.has(r.identifier) ? r.children.flatMap((g) => [line(g, true), cards(g)]) : [])])}
              <tr className="lin-tot">
                <td colSpan={2}>
                  {t.tasks} task{t.tasks === 1 ? "" : "s"}
                  {t.running > 0 && ` · ${t.running} running`}
                  {t.needs > 0 && ` · ${t.needs} need${t.needs === 1 ? "s" : ""} you`}
                  {t.failed > 0 && ` · ${t.failed} failed`}
                </td>
                <td className="lin-model" />
                <td />
                <td className="lin-latest" />
                <td className="r">{tokens(t.tokens)}</td>
                <td className="r">{usd(t.usd)}</td>
                <td className="r">{span(t.ms)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {ask && (
        <AsidePanel
          key={ask.target.identifier}
          target={ask.target}
          anchor={ask.anchor}
          drawer={ask.drawer}
          thread={threads.current.get(ask.target.identifier) ?? []}
          keep={(m) => threads.current.set(ask.target.identifier, m)}
          onExpand={() => setAsk({ ...ask, drawer: true })}
          onClose={() => setAsk(null)}
          prefix={prefix}
          onSignIn={onSignIn}
        />
      )}
    </>
  );
}

/** The side chat, as a popover under what was asked about or as a right drawer. Its messages live only here. */
export function AsidePanel({ target, anchor, drawer, thread, keep, onExpand, onClose, prefix, onSignIn }: { target: Target; anchor?: DOMRect; drawer: boolean; thread: AsideMessage[]; keep: (m: AsideMessage[]) => void; onExpand?: () => void; onClose: () => void; prefix: string; onSignIn: () => void }) {
  const [messages, setMessages] = useState(thread);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), [drawer]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  useLayoutEffect(() => {
    const el = box.current?.querySelector(".aside-msgs");
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);
  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    const next: AsideMessage[] = [...messages, { role: "user", text: q }];
    setMessages(next), keep(next), setText(""), setBusy(true), setError("");
    try {
      const { answer } = await api.aside(target.identifier, next);
      const done: AsideMessage[] = [...next, { role: "assistant", text: answer }];
      setMessages(done), keep(done);
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const left = anchor ? Math.min(Math.max(8, anchor.left - 24), window.innerWidth - 416) : 0;
  const style = drawer || !anchor ? undefined : { left, top: anchor.bottom + 8, "--nub": `${Math.min(Math.max(16, anchor.left - left + 12), 380)}px` } as React.CSSProperties;
  return (
    <div ref={box} className={drawer ? "aside-drawer" : "aside-pop"} style={style} role="dialog" aria-label={`Ask about ${target.title}`}>
      <div className="aside-head">
        <b>✦ Ask</b>
        <span className="aside-about" title={`${target.identifier}: ${target.title}`}>
          {target.agent} · {target.title}
        </span>
        {!drawer && onExpand && (
          <button className="icon-btn subtle" aria-label="Open in a side drawer" title="Open in a side drawer" onClick={onExpand}>
            ⤢
          </button>
        )}
        <button className="icon-btn subtle" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="aside-msgs">
        <div className="aside-note">○ Not saved to the task · doesn't wake {target.agent}</div>
        {!messages.length && (
          <div className="aside-starters">
            {["Why is this stuck?", "What did it change?", "What did it cost?"].map((s) => (
              <button key={s} className="btn sm" onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="aside-q">
              {m.text}
            </div>
          ) : (
            <div key={i} className="aside-a">
              <Markdown text={m.text} prefix={prefix} />
            </div>
          ),
        )}
        {busy && <div className="aside-a muted">Reading the task…</div>}
        {error && <div className="alert">Couldn't answer: {error}</div>}
      </div>
      <div className="aside-in">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={messages.length ? "Ask a follow-up" : "Ask about this task"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) e.preventDefault(), void send();
          }}
        />
        <span className="faint small">esc closes</span>
      </div>
    </div>
  );
}
