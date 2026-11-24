// The one control for answering an agent's questions: chat replies, asks from delegated work and My day's Needs-you rows.
// A single single-choice question answers on one tap and its typed reply sends on Enter; several questions or a multi-select
// pick, then Send (Enter there sends nothing). Answers are only words: they never approve anything. The control is locked while sending; a failure keeps the typed
// text and shows under the control.
import { useState } from "react";
import type { Question } from "./types";

export function AnswerForm({ questions, onAnswer, autoFocus, askedAbove }: { questions: Question[]; onAnswer: (text: string) => Promise<unknown>; autoFocus?: boolean; /** The question is already shown above: a single one drops its own heading. */ askedAbove?: boolean }) {
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [own, setOwn] = useState<string[]>(() => questions.map(() => ""));
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const one = questions.length === 1 ? questions[0]! : undefined;
  const tap = Boolean(one && !one.multi && one.options.length);
  const typed = Boolean(one && !one.options.length);
  const submit = (text: string) => {
    setState("sending");
    setError("");
    onAnswer(text).then(
      () => setState("sent"),
      (e: Error) => (setError(e.message), setState("idle")),
    );
  };
  const pick = (n: number, o: string, multi?: boolean) =>
    setPicked((p) => p.map((cur, i) => (i !== n ? cur : multi ? (cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]) : cur[0] === o ? [] : [o])));
  const reply = (n: number) => [...(tap ? [] : picked[n]!), own[n]!.trim()].filter(Boolean).join(", ");
  const ready = questions.some((_, n) => reply(n));
  const send = () => submit(questions.map((q, n) => (questions.length === 1 ? reply(n) : `**${q.question}**\n${reply(n) || "(skipped)"}`)).join("\n\n"));
  if (state === "sent") return <p className="q-sent" role="status">Sent</p>;
  return (
    <div className="qform">
      {questions.map((q, n) => (
        <fieldset key={n} className="q" disabled={state === "sending"}>
          {!(askedAbove && one) && (
            <legend>
              {questions.length > 1 && <span className="q-num">{n + 1}</span>}
              {q.question}
              {q.multi && <span className="muted small"> · pick any</span>}
            </legend>
          )}
          <div className={tap ? "q-tap" : "q-opts"}>
            {q.options.map((o, i) => {
              const on = picked[n]!.includes(o);
              return (
                <button key={o} type="button" className={`q-opt${on ? " on" : ""}`} aria-pressed={tap ? undefined : on} autoFocus={autoFocus && i === 0} onClick={() => (tap ? submit(o) : pick(n, o, q.multi))}>
                  {!tap && <span className={`q-mark${q.multi ? " box" : ""}`} />}
                  <span className="q-label">{o}</span>
                  {i === 0 && <span className="q-rec">Recommended</span>}
                </button>
              );
            })}
          </div>
          <input
            className="q-own"
            aria-label={tap || typed ? "Type your answer" : `Your own answer to: ${q.question}`}
            placeholder={tap || typed ? "Type your answer" : "Or in your own words…"}
            value={own[n]}
            autoFocus={autoFocus && !q.options.length && n === 0}
            onChange={(e) => setOwn((p) => p.map((x, i) => (i === n ? e.target.value : x)))}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (tap || typed) && ready && submit(reply(0))}
          />
        </fieldset>
      ))}
      {error && <p className="q-error" role="alert">{error}</p>}
      {!tap && !typed && (
        <div className="row-end">
          <button className="btn primary" disabled={!ready || state === "sending"} onClick={send}>
            Send {questions.length > 1 ? "answers" : "answer"}
          </button>
        </div>
      )}
    </div>
  );
}
