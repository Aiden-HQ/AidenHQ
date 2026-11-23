// An agent's settings as grouped rows (AgentSettings.tsx, the page's Settings tab): how it thinks, when it works and
// its recent changes. Each row shows the module default beside the instance value, with Reset to default where the
// instance overrides it; an edit opens the preview, then the progress. One change per row at a time: while one is filed
// the row shows its stage instead of the editor.
import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { cronText, modelShort, shown } from "./settings-format";
import { ChangePreview, ChangeProgress, Group, IN_FLIGHT, Row, useChanges, useFiled } from "./settings-ui";
import type { AgentSettings, FiledChange, SettingChange, SettingsData } from "./types";
import { useModelCatalog } from "./useModelCatalog";
import { ModelPicker, StatusDot } from "./ui";

type Routine = AgentSettings["routines"][number];
/** An agent works with tools, so only models that call them are offered. */
const TOOL_MODELS = { tools: true };
const hours = (v: unknown) => (v === true ? "the fleet's heartbeat" : typeof v === "number" ? `every ${v} hour${v === 1 ? "" : "s"}` : "off");

/** One editable row: value (and the module's default beside it), the pending change's stage, the editor, Reset to default. */
function Field({ title, value, def, filed, children }: { title: string; value: ReactNode; def?: { text: ReactNode; reset: { item: SettingChange; was: unknown } } | null; filed?: FiledChange; children: (done: () => void) => ReactNode }) {
  const [resetting, setResetting] = useState(false);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  return (
    <Row
      title={title}
      meta={
        <>
          {busy && <StatusDot tone="busy">Changing</StatusDot>}
          <span>{value}</span>
          {def && <span className="muted"> · module default {def.text}</span>}
        </>
      }
      details={
        <>
          {filed && (
            <ChangeProgress
              f={filed}
              after={busy ? <p className="ui-field-help">A filed change can't be cancelled from here yet: decline its card in Approvals to stop it.</p> : undefined}
            />
          )}
          {!busy &&
            (resetting && def ? (
              <ChangePreview items={[def.reset.item]} was={[def.reset.was]} onCancel={() => setResetting(false)} onDone={() => setResetting(false)} />
            ) : (
              <>
                {children(() => setResetting(false))}
                {def && (
                  <button className="btn" type="button" onClick={() => setResetting(true)}>
                    Reset to default
                  </button>
                )}
              </>
            ))}
        </>
      }
    />
  );
}

/** A text or select input with Review change: files `item(value)` when it differs from `current`. */
function Edit({ label, current, item, input, options, models }: { label: string; current: string; item: (v: string) => SettingChange; input?: "text"; options?: { value: string; label: string }[]; models?: string[] }) {
  const [v, setV] = useState(current);
  const [review, setReview] = useState(false);
  const catalog = useModelCatalog();
  return (
    <div className="st-change">
      <label className="ui-field">
        <span className="ui-field-label">{label}</span>
        {options ? (
          <select className="ui-select" value={v} onChange={(e) => (setV(e.target.value), setReview(false))}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : models ? (
          <ModelPicker label={label} value={v} catalog={catalog} recommended={models} accepts={TOOL_MODELS} onChange={(m) => (setV(m), setReview(false))} />
        ) : (
          <input className="ui-input" value={v} onChange={(e) => (setV(e.target.value), setReview(false))} spellCheck={false} />
        )}
      </label>
      {review ? (
        <ChangePreview items={[item(v.trim())]} was={[current]} onCancel={() => setReview(false)} onDone={() => setReview(false)} />
      ) : (
        <button className="btn primary" type="button" disabled={!v.trim() || v.trim() === current} onClick={() => setReview(true)}>
          Review change
        </button>
      )}
    </div>
  );
}

export function AgentDetails({ a, data }: { a: AgentSettings; data: SettingsData }) {
  const d = a.defaults ?? {};
  const agentField = (f: "model" | "reasoning_effort" | "heartbeat" | "max_parallel") => (c: SettingChange) => c.kind === "agent" && c.agent === a.key && c.field === f;
  const dflt = (f: "model" | "reasoning_effort" | "heartbeat", now: unknown, text: (v: unknown) => ReactNode) =>
    f in d && d[f] !== undefined && JSON.stringify(d[f] ?? null) !== JSON.stringify(now ?? null) && d[f] !== null
      ? { text: text(d[f]), reset: { item: { kind: "agent" as const, agent: a.key, field: f, value: d[f] as string | number | boolean }, was: now } }
      : null;
  const fModel = useFiled(agentField("model"));
  const fEffort = useFiled(agentField("reasoning_effort"));
  const fBeat = useFiled(agentField("heartbeat"));
  const fParallel = useFiled(agentField("max_parallel"));
  const hb = a.heartbeatHours ? String(a.heartbeatHours) : "off";
  const routines = a.routines.filter((r) => !r.key.startsWith("heartbeat-"));
  return (
    <div className="st-agent-settings">
      {a.team && <p className="fleet-empty">The {a.team} team: model, effort and parallel jobs here are every member's default; a member's own setting wins.</p>}
      {a.memberOf && <p className="fleet-empty">A team member: these settings are this member's own. The team's defaults are on the team's page.</p>}
      <Group title="How it thinks">
        <Field title="Model" value={<code>{a.model ? modelShort(a.model) : "the runner's"}</code>} def={dflt("model", a.model, (v) => <code>{modelShort(String(v))}</code>)} filed={fModel}>
          {() => <Edit label="Model" current={a.model} item={(v) => ({ kind: "agent", agent: a.key, field: "model", value: v })} models={data.choices.models} />}
        </Field>
        {a.efforts.length > 0 && (
          <Field title="Effort" value={a.effort || "the model's default"} def={dflt("reasoning_effort", a.effort, String)} filed={fEffort}>
            {() => <Edit label="Effort" current={a.effort} item={(v) => ({ kind: "agent", agent: a.key, field: "reasoning_effort", value: v })} options={a.efforts.map((x) => ({ value: x, label: x }))} />}
          </Field>
        )}
      </Group>
      <Group title="When it works">
        {(a.canHeartbeat || a.heartbeatHours) && (
          <Field title="Heartbeat" value={hours(a.heartbeatHours)} def={dflt("heartbeat", a.heartbeatHours ?? false, hours)} filed={fBeat}>
            {() => (
              <Edit
                label="Heartbeat"
                current={hb}
                item={(v) => ({ kind: "agent", agent: a.key, field: "heartbeat", value: v === "off" ? false : Number(v) })}
                options={[{ value: "off", label: "off" }, ...data.choices.heartbeatHours.map((h) => ({ value: String(h), label: `every ${h} hour${h === 1 ? "" : "s"}` }))]}
              />
            )}
          </Field>
        )}
        {a.maxParallel !== undefined && (
          <Field title="Parallel jobs" value={a.maxParallel} filed={fParallel}>
            {() => <Edit label="Parallel jobs" current={String(a.maxParallel)} item={(v) => ({ kind: "agent", agent: a.key, field: "max_parallel", value: Number(v) })} options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />}
          </Field>
        )}
        {routines.map((r) => (
          <RoutineField key={r.key} r={r} models={data.choices.models} />
        ))}
        {!routines.length && !a.canHeartbeat && !a.heartbeatHours && <p className="fleet-empty">No heartbeat or routines: it runs when asked.</p>}
      </Group>
      <Recent a={a} />
    </div>
  );
}

/**
 * A routine: schedule (cron and timezone) and model in one editor, filed as one `routine` change per field changed; pause and
 * resume are its live controls here (Paperclip's status, no settings change).
 */
function RoutineField({ r, models }: { r: Routine; models: string[] }) {
  const filed = useFiled((c) => c.kind === "routine" && c.routine === r.key);
  const [sched, setSched] = useState(r.schedules.map((s) => ({ ...s })));
  const [model, setModel] = useState(r.model ?? "");
  const [paused, setPaused] = useState(Boolean(r.paused));
  useEffect(() => setPaused(Boolean(r.paused)), [r.paused]); // a refreshed status is the truth
  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState("");
  const togglePause = () => {
    setPausing(true);
    api.pauseRoutine(r.id!, !paused).then((x) => (setPaused((r.paused = x.status === "paused")), setPauseError("")), (e) => setPauseError((e as Error).message)).finally(() => setPausing(false));
  };
  const [review, setReview] = useState(false);
  const own = r.defaults ?? {};
  const items: SettingChange[] = [];
  const was: unknown[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(sched, r.schedules)) (items.push({ kind: "routine", routine: r.key, field: "schedules", value: sched.map((s) => ({ cron: s.cron.trim(), ...(s.timezone.trim() ? { timezone: s.timezone.trim() } : {}), ...(s.label ? { label: s.label } : {}) })) }), was.push(r.schedules.map((s) => ({ cron: s.cron, timezone: s.timezone }))));
  if (model.trim() !== (r.model ?? "")) (items.push({ kind: "routine", routine: r.key, field: "model", value: model.trim() }), was.push(r.model ?? null));
  const diff = Object.keys(own).filter((f) => !same(own[f], f === "schedules" ? r.schedules.map((x) => ({ cron: x.cron, ...(x.timezone ? { timezone: x.timezone } : {}), ...(x.label ? { label: x.label } : {}) })) : (r as unknown as Record<string, unknown>)[f] ?? null) && own[f] !== null);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const when = r.schedules.length ? r.schedules.map((s) => cronText(s.cron)).join(", ") : r.webhook ? "on an event" : "when asked";
  const catalog = useModelCatalog();
  return (
    <Row
      title={r.title}
      meta={
        <>
          {busy && <StatusDot tone="busy">Changing</StatusDot>}
          <span>
            {when}
            {r.model && ` on ${modelShort(r.model)}`}
            {paused && " (paused)"}
          </span>
          {r.id && <button className="btn" type="button" disabled={pausing} onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>}
          {pauseError && <span className="st-error" role="alert">{pauseError}</span>}
          {diff.length > 0 && <span className="muted"> · module default differs for {diff.join(", ")}</span>}
        </>
      }
      details={
        <>
          {filed && <ChangeProgress f={filed} after={busy ? <p className="ui-field-help">A filed change can't be cancelled from here yet: decline its card in Approvals to stop it.</p> : undefined} />}
          {!busy && (
            <div className="st-change">
              {sched.map((s, i) => (
                <div key={i} className="ui-field">
                  <span className="ui-field-label">Schedule{sched.length > 1 ? ` ${i + 1}` : ""}</span>
                  <input className="ui-input" value={s.cron} aria-label={`${r.title}: cron`} onChange={(e) => (setSched(sched.map((x, j) => (j === i ? { ...x, cron: e.target.value } : x))), setReview(false))} spellCheck={false} />
                  <input className="ui-input" value={s.timezone} aria-label={`${r.title}: timezone`} placeholder="timezone" onChange={(e) => (setSched(sched.map((x, j) => (j === i ? { ...x, timezone: e.target.value } : x))), setReview(false))} spellCheck={false} />
                </div>
              ))}
              <div className="ui-field">
                <span className="ui-field-label">Model</span>
                <ModelPicker label={`${r.title}: model`} value={model} catalog={catalog} recommended={models} accepts={TOOL_MODELS} none="The agent's model" onChange={(m) => (setModel(m), setReview(false))} />
              </div>
              {review && items.length ? (
                <ChangePreview items={items} was={was} onCancel={() => setReview(false)} onDone={() => setReview(false)} />
              ) : (
                <div className="st-change-actions">
                  {diff.map((f) => (
                    <ResetRoutine key={f} r={r} field={f as "schedules" | "model"} value={own[f]} />
                  ))}
                  <button className="btn primary" type="button" disabled={!items.length} onClick={() => setReview(true)}>
                    Review change
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      }
    />
  );
}

function ResetRoutine({ r, field, value }: { r: Routine; field: "schedules" | "model"; value: unknown }) {
  const [on, setOn] = useState(false);
  return on ? (
    <ChangePreview items={[{ kind: "routine", routine: r.key, field, value } as SettingChange]} was={[(r as unknown as Record<string, unknown>)[field] ?? null]} onCancel={() => setOn(false)} onDone={() => setOn(false)} note={`Back to the module's ${field}: ${shown(value)}.`} />
  ) : (
    <button className="btn" type="button" onClick={() => setOn(true)}>
      Reset {field} to default
    </button>
  );
}

const touches = (c: SettingChange, a: AgentSettings) => ("agent" in c && c.agent === a.key) || (c.kind === "routine" && a.routines.some((r) => r.key === c.routine));
const TONE = { applied: "ok", failed: "failed", rejected: "failed", closed: "idle" } as const;

/** This agent's filed changes (the last two weeks), with their stage. */
function Recent({ a }: { a: AgentSettings }) {
  const mine = useChanges().changes.filter((f) => f.items.some((c) => touches(c, a)));
  return (
    <Group title="Recent changes">
      {mine.length ? (
        mine.map((f) => (
          <Row key={f.identifier} title={f.title} sub={<a href={`#/c/${f.identifier}`}>{f.identifier}</a>} meta={<StatusDot tone={TONE[f.stage as keyof typeof TONE] ?? "busy"}>{f.stage === "working" ? "Filed" : f.stage === "waiting" ? "Waiting for approval" : f.stage === "applying" ? "Applying" : f.stage === "applied" ? "Live" : f.stage}</StatusDot>} />
        ))
      ) : (
        <p className="fleet-empty">No changes to this agent in the last two weeks.</p>
      )}
    </Group>
  );
}
