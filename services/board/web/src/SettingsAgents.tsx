// An agent's settings as grouped rows (AgentSettings.tsx, the page's Settings tab): how it thinks, when it works, limits and
// its recent changes. Each row shows the module default beside the instance value, with Reset to default where the
// instance overrides it; an edit opens the preview, then the progress. One change per row at a time: while one is filed
// the row shows its stage instead of the editor.
import { useState, type ReactNode } from "react";
import { cronText, modelShort, shown } from "./settings-format";
import { ChangePreview, ChangeProgress, Group, IN_FLIGHT, Row, StatusPill, useChanges, useFiled } from "./settings-ui";
import type { AgentSettings, FiledChange, SettingChange, SettingsData } from "./types";

type Routine = AgentSettings["routines"][number];
const CAP_KEYS = ["run_usd", "task_usd", "day_usd"] as const;
const CAP_NAMES = { run_usd: "a run", task_usd: "a task", day_usd: "an agent-day" };
const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;
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
          {busy && <StatusPill tone="busy">Changing</StatusPill>}
          <span>{value}</span>
          {def && <span className="muted"> · module default {def.text}</span>}
        </>
      }
      details={
        <>
          {filed && (
            <ChangeProgress
              f={filed}
              after={busy ? <p className="st-field-help">A filed change can't be cancelled from here yet: decline its card in Approvals to stop it.</p> : undefined}
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
function Edit({ label, current, item, input, options, list }: { label: string; current: string; item: (v: string) => SettingChange; input?: "text"; options?: { value: string; label: string }[]; list?: string[] }) {
  const [v, setV] = useState(current);
  const [review, setReview] = useState(false);
  const listId = `dl-${label.replace(/\W/g, "")}`;
  return (
    <div className="st-change">
      <label className="st-field">
        <span className="st-field-label">{label}</span>
        {options ? (
          <select className="st-select" value={v} onChange={(e) => (setV(e.target.value), setReview(false))}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input list={list ? listId : undefined} value={v} onChange={(e) => (setV(e.target.value), setReview(false))} spellCheck={false} />
            {list && (
              <datalist id={listId}>
                {list.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </>
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
  const agentField = (f: "model" | "reasoning_effort" | "heartbeat") => (c: SettingChange) => c.kind === "agent" && c.agent === a.key && c.field === f;
  const dflt = (f: "model" | "reasoning_effort" | "heartbeat", now: unknown, text: (v: unknown) => ReactNode) =>
    f in d && d[f] !== undefined && JSON.stringify(d[f] ?? null) !== JSON.stringify(now ?? null) && d[f] !== null
      ? { text: text(d[f]), reset: { item: { kind: "agent" as const, agent: a.key, field: f, value: d[f] as string | number | boolean }, was: now } }
      : null;
  const fModel = useFiled(agentField("model"));
  const fEffort = useFiled(agentField("reasoning_effort"));
  const fBeat = useFiled(agentField("heartbeat"));
  const hb = a.heartbeatHours ? String(a.heartbeatHours) : "off";
  const routines = a.routines.filter((r) => !r.key.startsWith("heartbeat-"));
  return (
    <div className="st-agent-settings">
      <Group title="How it thinks">
        <Field title="Model" value={<code>{a.model ? modelShort(a.model) : "the runner's"}</code>} def={dflt("model", a.model, (v) => <code>{modelShort(String(v))}</code>)} filed={fModel}>
          {() => <Edit label="Model" current={a.model} item={(v) => ({ kind: "agent", agent: a.key, field: "model", value: v })} list={data.choices.models} />}
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
        {routines.map((r) => (
          <RoutineField key={r.key} r={r} models={data.choices.models} />
        ))}
        {!routines.length && !a.canHeartbeat && !a.heartbeatHours && <p className="fleet-empty">No heartbeat or routines: it runs when asked.</p>}
      </Group>
      <Group title="Limits" hint="USD. The gateway refuses a call that would pass a cap and files a Raise card.">
        <CapsField a={a} defaults={data.spend.defaults} />
      </Group>
      <Recent a={a} />
    </div>
  );
}

/** A routine: schedule (cron and timezone), status and model in one editor, filed as one `routine` change per field changed. */
function RoutineField({ r, models }: { r: Routine; models: string[] }) {
  const filed = useFiled((c) => c.kind === "routine" && c.routine === r.key);
  const [sched, setSched] = useState(r.schedules.map((s) => ({ ...s })));
  const [status, setStatus] = useState<"active" | "paused">(r.status === "paused" ? "paused" : "active");
  const [model, setModel] = useState(r.model ?? "");
  const [review, setReview] = useState(false);
  const own = r.defaults ?? {};
  const items: SettingChange[] = [];
  const was: unknown[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(sched, r.schedules)) (items.push({ kind: "routine", routine: r.key, field: "schedules", value: sched.map((s) => ({ cron: s.cron.trim(), ...(s.timezone.trim() ? { timezone: s.timezone.trim() } : {}), ...(s.label ? { label: s.label } : {}) })) }), was.push(r.schedules.map((s) => ({ cron: s.cron, timezone: s.timezone }))));
  if (status !== (r.status === "paused" ? "paused" : "active")) (items.push({ kind: "routine", routine: r.key, field: "status", value: status }), was.push(r.status ?? "active"));
  if (model.trim() !== (r.model ?? "")) (items.push({ kind: "routine", routine: r.key, field: "model", value: model.trim() }), was.push(r.model ?? null));
  const diff = Object.keys(own).filter((f) => !same(own[f], (r as unknown as Record<string, unknown>)[f] ?? null) && own[f] !== null);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const when = r.schedules.length ? r.schedules.map((s) => cronText(s.cron)).join(", ") : r.webhook ? "on an event" : "when asked";
  const listId = `rm-${r.key}`;
  return (
    <Row
      title={r.title}
      meta={
        <>
          {busy && <StatusPill tone="busy">Changing</StatusPill>}
          <span>
            {when}
            {r.model && ` on ${modelShort(r.model)}`}
            {r.status === "paused" && " (paused)"}
          </span>
          {diff.length > 0 && <span className="muted"> · module default differs for {diff.join(", ")}</span>}
        </>
      }
      details={
        <>
          {filed && <ChangeProgress f={filed} after={busy ? <p className="st-field-help">A filed change can't be cancelled from here yet: decline its card in Approvals to stop it.</p> : undefined} />}
          {!busy && (
            <div className="st-change">
              {sched.map((s, i) => (
                <div key={i} className="st-field">
                  <span className="st-field-label">Schedule{sched.length > 1 ? ` ${i + 1}` : ""}</span>
                  <input value={s.cron} aria-label={`${r.title}: cron`} onChange={(e) => (setSched(sched.map((x, j) => (j === i ? { ...x, cron: e.target.value } : x))), setReview(false))} spellCheck={false} />
                  <input value={s.timezone} aria-label={`${r.title}: timezone`} placeholder="timezone" onChange={(e) => (setSched(sched.map((x, j) => (j === i ? { ...x, timezone: e.target.value } : x))), setReview(false))} spellCheck={false} />
                </div>
              ))}
              <label className="st-field">
                <span className="st-field-label">Status</span>
                <select className="st-select" value={status} onChange={(e) => (setStatus(e.target.value as "active" | "paused"), setReview(false))}>
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                </select>
              </label>
              <label className="st-field">
                <span className="st-field-label">Model</span>
                <input list={listId} value={model} placeholder="the agent's" onChange={(e) => (setModel(e.target.value), setReview(false))} spellCheck={false} />
                <datalist id={listId}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              {review && items.length ? (
                <ChangePreview items={items} was={was} onCancel={() => setReview(false)} onDone={() => setReview(false)} />
              ) : (
                <div className="st-change-actions">
                  {diff.map((f) => (
                    <ResetRoutine key={f} r={r} field={f as "schedules" | "status" | "model"} value={own[f]} />
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

function ResetRoutine({ r, field, value }: { r: Routine; field: "schedules" | "status" | "model"; value: unknown }) {
  const [on, setOn] = useState(false);
  return on ? (
    <ChangePreview items={[{ kind: "routine", routine: r.key, field, value } as SettingChange]} was={[(r as unknown as Record<string, unknown>)[field] ?? null]} onCancel={() => setOn(false)} onDone={() => setOn(false)} note={`Back to the module's ${field}: ${shown(value)}.`} />
  ) : (
    <button className="btn" type="button" onClick={() => setOn(true)}>
      Reset {field} to default
    </button>
  );
}

function CapsField({ a, defaults }: { a: AgentSettings; defaults: Record<string, number> }) {
  const filed = useFiled((c) => c.kind === "caps" && c.agent === a.key);
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  const caps = a.caps;
  const own = CAP_KEYS.some((k) => caps[k] !== defaults[k]);
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(CAP_KEYS.map((k) => [k, String(caps[k] ?? defaults[k] ?? "")])));
  const [review, setReview] = useState<"edit" | "reset" | null>(null);
  const changed = Object.fromEntries(CAP_KEYS.filter((k) => Number(v[k]) !== caps[k]).map((k) => [k, Number(v[k])]));
  const bad = Object.values(changed).some((n) => !(n > 0) || n > 1000);
  const back = Object.fromEntries(CAP_KEYS.filter((k) => caps[k] !== defaults[k] && defaults[k] !== undefined).map((k) => [k, defaults[k]!]));
  return (
    <Row
      title="Spend caps"
      meta={
        <>
          {busy && <StatusPill tone="busy">Changing</StatusPill>}
          <span className={`st-caps${own ? " own" : ""}`}>{CAP_KEYS.map((k) => usd(caps[k] ?? 0)).join(" / ")}</span>
          <span className="muted"> · per run / task / agent-day{own ? `, fleet default ${CAP_KEYS.map((k) => usd(defaults[k] ?? 0)).join(" / ")}` : ""}</span>
        </>
      }
      details={
        <>
          {filed && <ChangeProgress f={filed} after={busy ? <p className="st-field-help">A filed change can't be cancelled from here yet: decline its card in Approvals to stop it.</p> : undefined} />}
          {!busy && (
            <>
              <form className="st-caps-form" onSubmit={(e) => (e.preventDefault(), Object.keys(changed).length && !bad && setReview("edit"))}>
                {CAP_KEYS.map((k) => (
                  <label key={k} className="st-field">
                    <span className="st-field-label">Per {CAP_NAMES[k].replace(/^an? /, "")}</span>
                    <span className="st-money">
                      $<input inputMode="decimal" value={v[k]} onChange={(e) => (setV({ ...v, [k]: e.target.value }), setReview(null))} aria-label={`Cap per ${CAP_NAMES[k]}`} />
                    </span>
                  </label>
                ))}
                {!review && (
                  <>
                    <button className="btn primary" disabled={!Object.keys(changed).length || bad}>
                      Review change
                    </button>
                    {own && (
                      <button className="btn" type="button" onClick={() => setReview("reset")}>
                        Reset to default
                      </button>
                    )}
                  </>
                )}
              </form>
              {bad && <span className="st-field-help bad">Each cap is above $0 and at most $1000.</span>}
              {review === "edit" && <ChangePreview items={[{ kind: "caps", agent: a.key, value: changed }]} was={[Object.fromEntries(Object.keys(changed).map((k) => [k, caps[k]]))]} onCancel={() => setReview(null)} onDone={() => setReview(null)} />}
              {review === "reset" && <ChangePreview items={[{ kind: "caps", agent: a.key, value: back }]} was={[Object.fromEntries(Object.keys(back).map((k) => [k, caps[k]]))]} onCancel={() => setReview(null)} onDone={() => setReview(null)} />}
            </>
          )}
        </>
      }
    />
  );
}

const touches = (c: SettingChange, a: AgentSettings) => ("agent" in c && c.agent === a.key) || (c.kind === "routine" && a.routines.some((r) => r.key === c.routine));
const TONE = { applied: "ok", failed: "bad", rejected: "bad", closed: "off" } as const;

/** This agent's filed changes (the last two weeks), with their stage. */
function Recent({ a }: { a: AgentSettings }) {
  const mine = useChanges().changes.filter((f) => f.items.some((c) => touches(c, a)));
  return (
    <Group title="Recent changes">
      {mine.length ? (
        mine.map((f) => (
          <Row key={f.identifier} title={f.title} sub={<a href={`#/c/${f.identifier}`}>{f.identifier}</a>} meta={<StatusPill tone={TONE[f.stage as keyof typeof TONE] ?? "busy"}>{f.stage === "working" ? "Filed" : f.stage === "waiting" ? "Waiting for approval" : f.stage === "applying" ? "Applying" : f.stage === "applied" ? "Live" : f.stage}</StatusPill>} />
        ))
      ) : (
        <p className="fleet-empty">No changes to this agent in the last two weeks.</p>
      )}
    </Group>
  );
}
