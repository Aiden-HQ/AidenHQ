// A fast-lane agent's chat (/api/lane): its chat task, which the chat-lane module answers in seconds. Polls every 1.5s while
// the agent owes a reply or for 10s after a send, else every 15s.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";
import { Composer } from "./ChatPane";
import { AgentFace } from "./components";
import type { Assignee, LaneAgent, LaneMessage } from "./types";
import { clockOpts } from "./util";

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { ...clockOpts() });

export function LaneChat({ agent, mobile, faces, go }: { agent: LaneAgent; mobile: boolean; faces: Assignee[]; go: (h: string) => void }) {
  const [messages, setMessages] = useState<LaneMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Mounting counts as a send: arriving from a new chat, the first reply is moments away, so poll fast at once.
  const sentAt = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<LaneMessage[]>([]);
  const last = useRef("");
  const end = useRef<HTMLDivElement>(null);
  const poll = useCallback(async () => {
    try {
      const r = await api.laneMessages(agent.key, last.current);
      if (r.messages.length) {
        last.current = r.messages[r.messages.length - 1]!.id;
        setMessages((m) => [...m, ...r.messages.filter((x) => !m.some((y) => y.id === x.id))]);
        // Your message is now in the conversation: drop its optimistic copy.
        const said = new Set(r.messages.filter((x: LaneMessage) => x.role === "owner").map((x: LaneMessage) => x.text.trim()));
        if (said.size) setPending((p) => p.filter((x) => !said.has(x.text.trim())));
      }
      setBusy(r.busy);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
    // A poll that changed nothing must still re-arm the timer below (state set to its old value doesn't re-render).
    setTick((t) => t + 1);
  }, [agent.key]);
  useEffect(() => void poll(), [poll]);
  // Re-armed after each poll, so the interval follows `busy` and a recent send.
  useEffect(() => {
    const ms = busy || Date.now() - sentAt.current < 10_000 ? 1_500 : 15_000;
    // A hidden tab checks only at the slow pace.
    const t = setTimeout(() => void poll(), document.visibilityState === "visible" ? ms : 15_000);
    return () => clearTimeout(t);
  }, [poll, busy, tick, pending.length]);
  useEffect(() => void end.current?.scrollIntoView?.({ block: "end" }), [messages.length, pending.length]);
  const send = async (text: string) => {
    const mine = { id: `pending-${Date.now()}`, role: "owner", text, at: Date.now() } as LaneMessage;
    setPending((p) => [...p, mine]);
    sentAt.current = Date.now();
    try {
      await api.laneSend(agent.key, text);
    } catch (e) {
      setPending((p) => p.filter((x) => x !== mine));
      throw e;
    }
    await poll();
  };
  const all = [...messages, ...pending];
  // The agent owes a reply while the lane says busy, or the last thing said is yours and recent.
  const lastMsg = all[all.length - 1];
  const replying = busy || (lastMsg?.role === "owner" && Date.now() - lastMsg.at < 120_000);
  return (
    <section className="ws-main">
      <header className="conv-head">
        <AgentFace crew={faces} agent={agent.id} name={agent.name} size={32} state={replying ? "working" : "idle"} />
        <span className="conv-who">
          <span className="conv-name">{agent.name}</span>
          <span className="conv-title muted small">{replying ? "working…" : "fast chat"}</span>
        </span>
      </header>
      <div className="conv-scroll">
        <div className="conv-inner">
          {error && <div className="alert">{error}</div>}
          {!all.length && !error && <p className="conv-empty muted">No messages yet.</p>}
          {all.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === "agent" && (
                <div className="msg-who">
                  <AgentFace crew={faces} agent={agent.id} name={agent.name} size={26} /> <b className="msg-name">{agent.name}</b> <span className="msg-time">{clock(m.at)}</span>
                </div>
              )}
              <div className="bubble">
                <Markdown text={m.text} prefix="" className="md" />
              </div>
              {m.role === "owner" && <div className="msg-meta">{clock(m.at)}</div>}
            </div>
          ))}
          {replying && <div className="notice">{agent.name} is replying…</div>}
          <div ref={end} />
        </div>
      </div>
      <Composer placeholder={`Message ${agent.name}`} draftKey={`draft:lane:${agent.key}`} mobile={mobile} noFiles onSend={send} />
    </section>
  );
}
