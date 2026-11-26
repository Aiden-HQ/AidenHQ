// Ask Aiden (⌘J, the top bar): a side panel on the right with Aiden's current chat, its history, and a composer. Non-modal:
// no backdrop, no focus trap, the page stays usable and it stays open across pages. "@Max …" starts a chat with that
// teammate (the server's pickAgent routes it) and the panel shows it. Open state lives in memory only.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SignInRequired, api } from "./api";
import { Composer, Conversation } from "./ChatPane";
import { LaneChat } from "./LaneChat";
import { QUERIES, agentChatsQuery, useQuery } from "./queries";
import { askKey } from "./Shell";
import type { Assignee, ChatRow } from "./types";
import { Button, Face, Kbd, Segmented, SidePanel, faceProps } from "./ui";
import { ago } from "./util";

const FRONT = "chief-of-staff";
const STARTERS = ["What needs me today?", "Who's working on what?", "Brief me on yesterday", "Hire a teammate…"];

/** The panel's state, outside React: any button, key or page opens it. `chat`: the chat to show ("" = a new one). */
const store = { open: false, chat: undefined as string | undefined, text: "", n: 0, listeners: new Set<() => void>() };
const emit = () => (store.n++, store.listeners.forEach((l) => l()));
const subscribe = (l: () => void) => (store.listeners.add(l), () => void store.listeners.delete(l));

/** Opens Ask Aiden (on `chat`, or with `text` in the composer); `toggle` closes it when open. */
export function openAsk(opts: { text?: string; chat?: string; toggle?: boolean } = {}): void {
  if (opts.toggle && store.open) store.open = false;
  else {
    store.open = true;
    if (opts.chat !== undefined) store.chat = opts.chat;
    if (opts.text) (store.text = opts.text), (store.chat = "");
  }
  emit();
  window.dispatchEvent(new CustomEvent("aidenhq:ask", { detail: opts }));
}
export const toggleAsk = () => openAsk({ toggle: true });
export const useAskOpen = () => useSyncExternalStore(subscribe, () => store.open);

type Props = { mobile: boolean; crew: Assignee[]; faces: Assignee[]; prefix: string; go: (h: string) => void; onSignIn: () => void; toast: (t: string) => void };

/** Mounted once by App; reads nothing until first opened, so a closed panel costs nothing. */
export function AskAiden(props: Props) {
  const open = useAskOpen();
  const [used, setUsed] = useState(open);
  useEffect(() => void (open && setUsed(true)), [open]);
  return used ? <AskPanel {...props} /> : null;
}

function AskPanel({ mobile, crew, faces, prefix, go, onSignIn, toast }: Props) {
  useSyncExternalStore(subscribe, () => store.n);
  const open = store.open;
  const [history, setHistory] = useState(false);
  const [state, setState] = useState<"active" | "settled">("active");
  const roster = useQuery(QUERIES.roster, onSignIn).data?.roster ?? [];
  const aiden = roster.find((r) => r.key === FRONT);
  const list = useQuery(agentChatsQuery(FRONT, state), onSignIn);
  const active = useQuery(agentChatsQuery(FRONT), onSignIn);
  const lane = useQuery(QUERIES.lane, onSignIn).data?.agents ?? [];
  const current = store.chat ?? active.data?.chats.find((c) => c.open)?.identifier ?? "";
  const pick = (chat: string) => ((store.chat = chat), setHistory(false), emit());
  const close = useCallback(() => {
    store.open = false;
    emit();
    // Back to the button that opens it when focus was left nowhere (⌘J from the page).
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.querySelector<HTMLElement>('[aria-controls="ask-aiden"]')?.focus();
    });
  }, []);
  // On open, focus goes to the composer (the opener gets it back on close: SidePanel).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(t);
  }, [open, current, history]);

  /** A new chat: to Aiden, or to the @teammate the text starts with (the server routes it). Lane answers open the lane. */
  const start = async (text: string, files: File[] = []) => {
    try {
      const { identifier } = await api.newChat(text || `Files: ${files.map((f) => f.name).join(", ")}`);
      for (const f of identifier.startsWith("lane:") ? [] : files) await api.attach(identifier, f).catch((e: Error) => toast(`Couldn't attach ${f.name}: ${e.message}`));
      store.text = "";
      pick(identifier);
      void active.reload();
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      throw e;
    }
  };
  const intercept = async (text: string) => {
    if (!/^@\S/.test(text.trim())) return false;
    await start(text);
    return true;
  };

  const laneAgent = current.startsWith("lane:") ? lane.find((a) => a.key === current.slice(5)) : undefined;
  const job = aiden?.teammate?.job ?? "Chief of staff";
  const historyBtn = (
    <Button variant="quiet" aria-label={history ? "Back to the chat" : "Earlier chats"} aria-pressed={history} title={history ? "Back to the chat" : "Earlier chats"} onClick={() => setHistory(!history)}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </Button>
  );
  const fresh = !history && !current;
  return (
    <div id="ask-aiden" ref={root} className="ask-aiden">
      <SidePanel
        open={open}
        onClose={close}
        title="Ask Aiden"
        sub={`${job} · knows your whole team`}
        face={<Face seed={FRONT} {...faceProps(aiden?.teammate?.face)} size={32} label={aiden?.name ?? "Aiden"} />}
        headerActions={historyBtn}
        footer={
          fresh ? (
            <Composer key={`ask:${store.text}`} initialText={store.text} placeholder="Ask Aiden, or @ a teammate" draftKey="draft:ask" mobile={mobile} crew={crew} autoFocus={false} onSend={(t, f) => start(t, f)} starters={STARTERS} />
          ) : undefined
        }
      >
        {history ? (
          <ChatHistory rows={list.data?.chats ?? null} state={state} setState={setState} current={current} pick={pick} />
        ) : laneAgent ? (
          <LaneChat key={laneAgent.key} agent={laneAgent} mobile={mobile} faces={faces} go={go} />
        ) : current && !current.startsWith("lane:") ? (
          <Conversation key={current} refId={current} mobile={mobile} crew={crew} faces={faces} prefix={prefix} go={go} onSignIn={onSignIn} toast={toast} reloadList={active.reload} compact intercept={intercept} />
        ) : (
          <p className="ask-empty">
            Ask about anything your team is doing, or hand Aiden something to take off your plate. Start with @ to talk to a teammate. <Kbd>{askKey}</Kbd> opens and closes this.
          </p>
        )}
      </SidePanel>
    </div>
  );
}

/** Aiden's chats, active or settled, newest first; a pick shows it, New chat starts over. */
function ChatHistory({ rows, state, setState, current, pick }: { rows: ChatRow[] | null; state: "active" | "settled"; setState: (s: "active" | "settled") => void; current: string; pick: (chat: string) => void }) {
  return (
    <div className="ask-history">
      <div className="ask-history-head">
        <Segmented label="Show" value={state} onChange={setState} options={[["active", "Active"], ["settled", "Settled"]] as const} />
        <Button size="sm" onClick={() => pick("")}>New chat</Button>
      </div>
      {rows === null ? (
        <p className="ask-empty">Loading…</p>
      ) : rows.length ? (
        <ul className="ask-list">
          {rows.map((c) => (
            <li key={c.identifier}>
              <button type="button" className={`ask-row lift${c.identifier === current ? " on" : ""}`} onClick={() => pick(c.identifier)}>
                <b>{c.title}</b>
                <span>{c.preview?.text ?? c.identifier}</span>
                <time>{ago(c.preview?.at ?? c.updatedAt)}</time>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ask-empty">{state === "settled" ? "No settled chats." : "No open chats with Aiden."}</p>
      )}
    </div>
  );
}
