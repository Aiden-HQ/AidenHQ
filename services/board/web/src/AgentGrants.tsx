// What an agent may touch, per connection: its tools by class, the ones it holds, and Reset to the module's default.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { ChangeProgress, Group, Row, useChanges, useFiled } from "./settings-ui";
import type { GrantConnection, SettingChange } from "./types";
import { Tag } from "./ui";

export function AgentGrants({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const [conns, setConns] = useState<GrantConnection[] | null>(null);
  useEffect(() => {
    api.agentGrants(agentKey).then(
      (r) => setConns(r.connections),
      (e) => (e instanceof SignInRequired ? onSignIn() : setConns([])),
    );
  }, [agentKey, onSignIn]);
  if (!conns?.length) return null;
  return (
    <section className="st-embedded">
      <Group title="What it may touch" hint="Adding write or destructive tools needs your tap.">
        {conns.map((c) => (
          <ConnectionGrant key={c.id} agentKey={agentKey} c={c} />
        ))}
      </Group>
    </section>
  );
}

const grantChange = (agent: string, connection: string, tools: string[] | null): SettingChange => ({ kind: "grants", agent, connection, tools });

function ConnectionGrant({ agentKey, c }: { agentKey: string; c: GrantConnection }) {
  const { file, toast } = useChanges();
  const filed = useFiled((x) => x.kind === "grants" && x.agent === agentKey && x.connection === c.id);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(c.tools.filter((t) => t.granted).map((t) => t.name)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const held = c.tools.filter((t) => t.granted).map((t) => t.name);
  const dirty = picked.size !== held.length || held.some((n) => !picked.has(n));
  const isDefault = c.tools.every((t) => t.granted === t.default);
  const send = async (tools: string[] | null) => {
    setBusy(true);
    setError("");
    try {
      toast(`Filed (${await file([grantChange(agentKey, c.id, tools)])}).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      title={c.id}
      sub={c.module ? `from ${c.module}` : undefined}
      meta={<Tag tone="accent">{held.length} of {c.tools.length} tools</Tag>}
      details={
        <>
          <ul className="br-tools">
            {c.tools.map((t) => (
              <li key={t.name}>
                <label>
                  <input type="checkbox" checked={picked.has(t.name)} onChange={(e) => setPicked((p) => new Set(e.target.checked ? [...p, t.name] : [...p].filter((n) => n !== t.name)))} /> {t.name}
                </label>
                <Tag tone={t.class === "read" ? "neutral" : "needs"}>{t.class}</Tag>
                {t.default && <span className="muted"> module default</span>}
              </li>
            ))}
          </ul>
          <p className="muted">
            Adding write or destructive tools needs your tap. If a tool needs a sign-in, connect it in <a className="st-link" href="#/settings/connections">Settings → Connections</a>.
          </p>
          {filed && <ChangeProgress f={filed} />}
          {error && <p className="st-error" role="alert">{error}</p>}
          <div className="st-preview-actions">
            <button className="btn" disabled={busy || isDefault} onClick={() => void send(null)}>Reset to default</button>
            <button className="btn primary" disabled={busy || !dirty} onClick={() => void send([...picked])}>Save</button>
          </div>
        </>
      }
    />
  );
}
