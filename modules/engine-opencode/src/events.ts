// opencode's /event stream (1.19.6) as engine events: tool calls become steps, finished text parts become the job's words,
// each finished assistant message its token use. Events of other sessions on the same server are ignored.
import type { EngineEvent, JobSpec } from "../sdk/types.ts";
import { tracker, withArg } from "../sdk/progress.ts";

export function sseEvents(spec: JobSpec, emit: (e: EngineEvent) => void, sessionId: () => string, onError: (why: string) => void = () => {}) {
  const p = tracker();
  const started = new Set<string>();
  const billed = new Set<string>();
  return {
    take(ev: any) {
      const props = ev?.properties;
      if (!props || (props.sessionID && props.sessionID !== sessionId())) return;
      if (ev.type === "session.error" && props.error?.name !== "MessageAbortedError") onError(String(props.error?.data?.message ?? props.error?.name ?? "unknown error").slice(0, 300));
      if (ev.type === "message.part.updated") {
        const part = props.part;
        if (part?.type === "tool" && part.state?.status === "running" && !started.has(part.id)) {
          started.add(part.id);
          if (p.step(withArg(String(part.tool), part.state.input))) emit(p.snapshot());
        }
        if (part?.type === "text" && part.time?.end && p.said(part.text)) emit(p.snapshot());
      }
      if (ev.type === "message.updated" && props.info?.role === "assistant" && props.info.time?.completed && !billed.has(props.info.id)) {
        billed.add(props.info.id);
        const t = props.info.tokens ?? {};
        emit({ t: "usage", input: t.input ?? 0, cached: t.cache?.read ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), model: props.info.modelID ?? spec.model.id });
      }
    },
  };
}
