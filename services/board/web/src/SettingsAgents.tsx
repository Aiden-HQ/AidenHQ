// Settings > Agents and models: one compact row per agent, by department as on the Agents page (platform agents, then the
// owner's own), with its model, when it wakes in plain words, and counts. A row opens to the details and to Change: model,
// effort and heartbeat, filed as one change (settings-ui ChangePreview).
import { useMemo, useState } from "react";
import { cronText, modelShort, wakeText } from "./settings-format";
import { ChangePreview, ChangeProgress, Group, IN_FLIGHT, Page, StatusPill, Row, useFiled } from "./settings-ui";
import type { AgentSettings, SettingChange, SettingsData } from "./types";

type Dept = AgentSettings["department"];

function byDepartment(agents: AgentSettings[]) {
  const groups = new Map<string, { dept: Dept; members: AgentSettings[] }>();
  for (const a of agents) {
    if (!groups.has(a.department.id)) groups.set(a.department.id, { dept: a.department, members: [] });
    groups.get(a.department.id)!.members.push(a);
  }
  return [...groups.values()].sort((x, y) => x.dept.order - y.dept.order || x.dept.name.localeCompare(y.dept.name));
}

export function AgentsPage({ data }: { data: SettingsData }) {
  const [model, setModel] = useState("");
  const [heartbeat, setHeartbeat] = useState(false);
  const [q, setQ] = useState("");
  const models = useMemo(() => [...new Set(data.agents.map((a) => modelShort(a.model)).filter(Boolean))].sort(), [data.agents]);
  const shown = data.agents.filter((a) => (!model || modelShort(a.model) === model) && (!heartbeat || a.heartbeatHours) && (!q || `${a.name} ${a.key}`.toLowerCase().includes(q.toLowerCase())));
  const platform = shown.filter((a) => a.module !== "instance");
  const own = shown.filter((a) => a.module === "instance");
  const beats = data.agents.filter((a) => a.heartbeatHours).length;
  return (
    <Page title="Agents and models" sub={`${data.agents.length} agents, ${beats} with a heartbeat. Open one to change its model, effort or heartbeat.`}>
      <div className="st-filters" role="group" aria-label="Filter agents">
        <input className="st-search" type="search" placeholder="Find an agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an agent" />
        <select className="st-select" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          <option value="">Every model</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button className={`st-filter${heartbeat ? " on" : ""}`} aria-pressed={heartbeat} onClick={() => setHeartbeat(!heartbeat)}>
          Has a heartbeat
        </button>
        {(model || heartbeat || q) && (
          <button className="link-btn" onClick={() => (setModel(""), setHeartbeat(false), setQ(""))}>
            Clear
          </button>
        )}
      </div>
      {!shown.length && <p className="st-empty">No agent matches. Clear the filters to see them all.</p>}
      {platform.length > 0 && <h2 className="st-section-title">Platform agents</h2>}
      {byDepartment(platform).map((g) => (
        <Group key={g.dept.id} title={g.dept.name} count={g.members.length} hint={g.dept.description}>
          <AgentHeader />
          {g.members.map((a) => (
            <AgentRow key={a.key} a={a} data={data} />
          ))}
        </Group>
      ))}
      {own.length > 0 && (
        <>
          <h2 className="st-section-title">Your agents</h2>
          <Group count={own.length}>
            <AgentHeader />
            {own.map((a) => (
              <AgentRow key={a.key} a={a} data={data} />
            ))}
          </Group>
        </>
      )}
    </Page>
  );
}

const AgentHeader = () => (
  <div className="st-agent-cols st-cols-head" aria-hidden>
    <span>Agent</span>
    <span>Model</span>
    <span>Wakes</span>
    <span className="num">Routines</span>
    <span className="num">Connections</span>
  </div>
);

function AgentRow({ a, data }: { a: AgentSettings; data: SettingsData }) {
  const filed = useFiled((c) => (c.kind === "agent" || c.kind === "caps") && c.agent === a.key);
  const wake = wakeText(a);
  const routines = a.routines.filter((r) => !r.key.startsWith("heartbeat-"));
  const busy = filed && IN_FLIGHT.includes(filed.stage);
  return (
    <Row
      title={
        <span className="st-agent-cols">
          <span className="st-agent-name">
            {a.name}
            {a.trial && <span className="st-chip warn">In trial</span>}
            {busy && <StatusPill tone="busy">Changing</StatusPill>}
          </span>
          <span className="st-agent-model" title={a.model}>
            {modelShort(a.model) || "the runner's"}
            {a.efforts.length > 0 && <span className="st-effort">{a.effort || "default"}</span>}
          </span>
          <span className="st-agent-wake" title={wake.full.join("\n") || undefined}>
            {wake.text}
          </span>
          <span className="num">{routines.length || "–"}</span>
          <span className="num">{a.connections.length}</span>
        </span>
      }
      details={<AgentDetails a={a} data={data} />}
    />
  );
}

function AgentDetails({ a, data }: { a: AgentSettings; data: SettingsData }) {
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
