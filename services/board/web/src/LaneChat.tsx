// A fast-lane agent's chat (slack-live-mcp's lane, proxied by the board at /api/lane): the conversation lives in the lane,
// not in a Paperclip task. Polls every 1.5s while the agent is busy or for 10s after a send, else every 15s.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";
import { Composer, Monogram, portraitOf } from "./Workspace";
import type { Assignee, LaneAgent, LaneMessage } from "./types";

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function LaneChat({ agent, mobile, crew, go }: { agent: LaneAgent; mobile: boolean; crew: Assignee[]; go: (h: string) => void }) {
  const [messages, setMessages] = useState<LaneMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sentAt = useRef(0);
  const last = useRef("");
  const end = useRef<HTMLDivElement>(null);
  const poll = useCallback(async () => {
    try {
      const r = await api.laneMessages(agent.key, last.current);
      if (r.messages.length) {
        last.current = r.messages[r.messages.length - 1]!.id;
        setMessages((m) => [...m, ...r.messages.filter((x) => !m.some((y) => y.id === x.id))]);
      }
      setBusy(r.busy);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agent.key]);
  // Re-armed after each poll, so the interval follows `busy` and a recent send.
  useEffect(() => {
    const ms = busy || Date.now() - sentAt.current < 10_000 ? 1_500 : 15_000;
    const t = setTimeout(() => void poll(), ms);
    return () => clearTimeout(t);
  }, [poll, busy, messages]);
  useEffect(() => void end.current?.scrollIntoView?.({ block: "end" }), [messages.length]);
  const send = async (text: string) => {
    await api.laneSend(agent.key, text);
    sentAt.current = Date.now();
    await poll();
  };
  return (
    <section className="ws-main">
      <header className="conv-head">
        {mobile && (
          <button className="icon-btn" aria-label="Back to chats" onClick={() => go("#/")}>
            ‹
          </button>
        )}
        <Monogram name={agent.name} size={32} avatar={portraitOf(crew, agent.key)} />
        <span className="conv-who">
          <span className="conv-name">{agent.name}</span>
          <span className="conv-title muted small">{busy ? "working…" : "fast chat"}</span>
        </span>
      </header>
      <div className="conv-scroll">
        <div className="conv-inner">
          {error && <div className="alert">{error}</div>}
          {!messages.length && !error && <p className="conv-empty muted">No messages yet.</p>}
          {messages.map((m) =>
            m.role === "wake" ? (
              <div key={m.id} className="notice" title={m.text}>
                reminder · {clock(m.at)}
              </div>
            ) : (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === "agent" && (
                  <div className="msg-who">
                    <Monogram name={agent.name} size={26} avatar={portraitOf(crew, agent.key)} /> <b className="msg-name">{agent.name}</b> <span className="msg-time">{clock(m.at)}</span>
                  </div>
                )}
                <div className="bubble">
                  <Markdown text={m.text} prefix="" className="md" />
                </div>
                {m.role === "owner" && <div className="msg-meta">{clock(m.at)}</div>}
              </div>
            ),
          )}
          {busy && <div className="notice">{agent.name} is replying…</div>}
          <div ref={end} />
        </div>
      </div>
      <Composer placeholder={`Message ${agent.name}`} draftKey={`draft:lane:${agent.key}`} mobile={mobile} onSend={send} />
    </section>
  );
}
