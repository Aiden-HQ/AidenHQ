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
import type { AsideMessage, Assignee, Lineage, LineageRow, LineageStatus } from "./types";

const STATUS_WORDS: Record<LineageStatus, string> = { running: "running", done: "done", blocked: "blocked", approval: "waiting on approval", needs: "needs you", waiting: "waiting" };

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

export function StatusBadge({ status }: { status: LineageStatus }) {
  return <span className={`lin-badge s-${status}`}>{STATUS_WORDS[status]}</span>;
}

interface Target {
  identifier: string;
  title: string;
  agent: string;
}

export function LineageStrip({ refId, title, agent, crew, prefix, href, onSignIn }: { refId: string; title: string; agent: string; crew: Assignee[]; prefix: string; href: (identifier: string) => string; onSignIn: () => void }) {
  const [data, setData] = useState<Lineage | null>(null);
  const load = useCallback(
    () =>
      api.lineage(refId).then(setData, (e) => {
        if (e instanceof SignInRequired) onSignIn();
      }),
    [refId, onSignIn],
  );
  // Task changes and approvals (throttled: each read walks two levels of children) and a 15s poll; not every progress tick.
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
  const [table, setTable] = useState<boolean | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<{ target: Target; anchor: DOMRect; drawer: boolean } | null>(null);
  const threads = useRef(new Map<string, AsideMessage[]>());
  const rows = data?.children ?? [];
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
      <td>
        <StatusBadge status={r.status} />
      </td>
      <td className={`lin-latest${r.status === "blocked" ? " bad" : ""}`} title={r.latest?.text}>
        {r.latest?.text ?? ""}
      </td>
      <td className="r">{tokens(r.tokens)}</td>
      <td className="r">{usd(r.usd)}</td>
      <td className="r m">{took(r)}</td>
      <td className="lin-act">
        <button className={`btn sm ghost lin-ask${r.status === "blocked" ? " shown" : ""}`} onClick={(e) => open(r, e.currentTarget)} title="Ask about this task: not posted, doesn't wake the agent">
          ✦ {r.status === "blocked" ? "Why?" : "Ask"}
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
            const appr = waitsOnApproval(r);
            return (
              <button key={r.identifier} className={`lin-chip s-${appr ? "approval" : r.status}`} title={`${r.agent}: ${r.title} (${STATUS_WORDS[appr ? "approval" : r.status]})`} onClick={() => setTable(!shown)}>
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
                  {t.blocked > 0 && ` · ${t.blocked} blocked`}
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
