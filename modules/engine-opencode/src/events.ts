// opencode's /event stream (1.19.6) as engine events: tool calls become steps, finished text parts become the job's words,
// each finished assistant message its token use; endTurn() gives a finished turn's last words as a `reply` with the turn's start and
// end (the kernel drops it when the job commented on its own task in between). Events of other sessions on the same server are ignored.
import type { EngineEvent, JobSpec } from "../sdk/types.ts";
import { tracker, withArg } from "../sdk/progress.ts";

export function sseEvents(spec: JobSpec, emit: (e: EngineEvent) => void, sessionId: () => string, onError: (why: string) => void = () => {}) {
  const p = tracker();
  const started = new Set<string>();
  const billed = new Set<string>();
  // The turn in progress: its last finished text, and when it started.
  let last: { id: string; text: string } | undefined;
  let start = Date.now();
  return {
    /** A turn the engine starts: nothing of an earlier one (a turn typed in the terminal) carries into it. */
    beginTurn() { last = undefined, start = Date.now(); },
    /** The turn ended: its last words go on the task as the agent's reply, unless the turn was silent (the kernel skips one the job already posted itself). */
    endTurn() {
      const reply = last;
      last = undefined;
      if (reply && reply.text.trim() && reply.text.trim() !== "NO_REPLY") emit({ t: "reply", id: reply.id, text: reply.text.trim(), start, end: Date.now() });
    },
    take(ev: any) {
      const props = ev?.properties;
      if (!props || (props.sessionID && props.sessionID !== sessionId())) return;
      // An interrupted turn (the owner's stop in the terminal) has no answer: what it had streamed is not a reply.
      if (ev.type === "session.error" && props.error?.name === "MessageAbortedError") last = undefined;
      if (ev.type === "session.error" && props.error?.name !== "MessageAbortedError") onError(String(props.error?.data?.message ?? props.error?.name ?? "unknown error").slice(0, 300));
      if (ev.type === "message.part.updated") {
        const part = props.part;
        if (part?.type === "tool" && part.state?.status === "running" && !started.has(part.id)) {
          started.add(part.id);
          last = undefined;   // words before a tool call are narration: the reply is what the turn says after its last one
          if (p.step(withArg(String(part.tool), part.state.input))) emit(p.snapshot());
        }
        if (part?.type === "text" && part.time?.end) {
          if (typeof part.text === "string" && part.text.trim()) last = { id: String(part.id), text: part.text };
          if (p.said(part.text)) emit(p.snapshot());
        }
      }
      if (ev.type === "message.updated" && props.info?.role === "assistant" && props.info.time?.completed && !billed.has(props.info.id)) {
        billed.add(props.info.id);
        const t = props.info.tokens ?? {};
        emit({ t: "usage", input: t.input ?? 0, cached: t.cache?.read ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), model: props.info.modelID ?? spec.model.id });
      }
    },
  };
}
