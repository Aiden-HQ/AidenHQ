// An agent's settings editor (shown on its page, AgentPage.tsx): model, effort and heartbeat, filed as one change
// (settings-ui ChangePreview).
import { useState } from "react";
import { cronText, modelShort } from "./settings-format";
import { ChangePreview, ChangeProgress, IN_FLIGHT, useFiled } from "./settings-ui";
import type { AgentSettings, SettingChange, SettingsData } from "./types";

export function AgentDetails({ a, data }: { a: AgentSettings; data: SettingsData }) {
  const filed = useFiled((c) => (c.kind === "agent" || c.kind === "caps") && c.agent === a.key);
  const routines = a.routines.filter((r) => !r.key.startsWith("heartbeat-"));
  return (
    <div className="st-agent-details">
      {filed && <ChangeProgress f={filed} />}
      <div className="st-agent-grid">
        <dl className="st-facts">
          <dt>Model</dt>
          <dd>
            <code>{a.model || "the runner's"}</code>
            {a.models.length > 0 && <span className="muted"> (may also call {a.models.map(modelShort).join(", ")})</span>}
          </dd>
          <dt>Runs on</dt>
          <dd>
            {a.runsOn}, {a.adapter}
          </dd>
          <dt>Heartbeat</dt>
          <dd>{a.heartbeatHours ? `every ${a.heartbeatHours} hours` : <span className="muted">none</span>}</dd>
          <dt>Routines</dt>
          <dd>
            {routines.length ? (
              <ul className="st-plain-list">
                {routines.map((r) => (
                  <li key={r.key}>
                    {r.title}
                    {r.status === "paused" && <span className="muted"> (paused)</span>}
                    {": "}
                    <span className="muted">
                      {r.schedules.length
                        ? r.schedules.map((s, i) => (
                            <span key={i} title={`${s.cron}${s.timezone ? ` (${s.timezone})` : ""}`} className="st-cron">
                              {cronText(s.cron)}
                            </span>
                          ))
                        : r.webhook
                          ? "on an event"
                          : "when asked"}
                      {r.model && ` on ${modelShort(r.model)}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">none</span>
            )}
          </dd>
          <dt>Connections</dt>
          <dd>{a.connections.length ? a.connections.join(", ") : <span className="muted">none</span>}</dd>
          {a.roles.length > 0 && (
            <>
              <dt>Roles</dt>
              <dd>{a.roles.join(", ")}</dd>
            </>
          )}
          <dt>Module</dt>
          <dd>
            <code>{a.module || "instance"}</code> <code className="muted">{a.key}</code>
          </dd>
        </dl>
        <AgentChange a={a} data={data} busy={Boolean(filed && IN_FLIGHT.includes(filed.stage))} />
      </div>
    </div>
  );
}

function AgentChange({ a, data, busy }: { a: AgentSettings; data: SettingsData; busy: boolean }) {
  const [model, setModel] = useState(a.model);
  const [effort, setEffort] = useState(a.effort);
  const hb = a.heartbeatHours ? String(a.heartbeatHours) : "off";
  const [heartbeat, setHeartbeat] = useState(hb);
  const [review, setReview] = useState(false);
  const items: SettingChange[] = [];
  const was: unknown[] = [];
  if (model.trim() && model.trim() !== a.model) (items.push({ kind: "agent", agent: a.key, field: "model", value: model.trim() }), was.push(a.model || null));
  if (effort && effort !== a.effort) (items.push({ kind: "agent", agent: a.key, field: "reasoning_effort", value: effort }), was.push(a.effort || null));
  if (heartbeat !== hb) (items.push({ kind: "agent", agent: a.key, field: "heartbeat", value: heartbeat === "off" ? false : Number(heartbeat) }), was.push(a.heartbeatHours ?? false));
  const reset = () => (setModel(a.model), setEffort(a.effort), setHeartbeat(hb), setReview(false));
  const listId = `models-${a.key}`;
  return (
    <form className="st-change" onSubmit={(e) => (e.preventDefault(), items.length && setReview(true))}>
      <h3>Change</h3>
      <label className="st-field">
        <span className="st-field-label">Model</span>
        <input list={listId} value={model} onChange={(e) => (setModel(e.target.value), setReview(false))} spellCheck={false} disabled={busy} />
        <datalist id={listId}>
          {data.choices.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {a.efforts.length > 0 && (
        <label className="st-field">
          <span className="st-field-label">Effort</span>
          <select className="st-select" value={effort} onChange={(e) => (setEffort(e.target.value), setReview(false))} disabled={busy}>
            {!a.effort && <option value="">the model's default</option>}
            {a.efforts.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      )}
      {(a.canHeartbeat || a.heartbeatHours) && (
        <label className="st-field">
          <span className="st-field-label">Heartbeat</span>
          <select className="st-select" value={heartbeat} onChange={(e) => (setHeartbeat(e.target.value), setReview(false))} disabled={busy}>
            <option value="off">off</option>
            {data.choices.heartbeatHours.map((h) => (
              <option key={h} value={String(h)}>
                every {h} hour{h === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
      )}
      {review && items.length ? (
        <ChangePreview items={items} was={was} onCancel={() => setReview(false)} onDone={() => setReview(false)} />
      ) : (
        <div className="st-change-actions">
          {items.length > 0 && (
            <button type="button" className="btn" onClick={reset}>
              Reset
            </button>
          )}
          <button className="btn primary" disabled={!items.length || busy}>
            Review change
          </button>
        </div>
      )}
    </form>
  );
}
