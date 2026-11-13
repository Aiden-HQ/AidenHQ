// Settings > Connections: what needs setting up first (with its URL input in the row), then what is connected, then what is
// built in. A saved URL is a change like any other (settings-ui ChangePreview): the row follows it to live, then offers
// the sign-in.
import { useState } from "react";
import { STATUS_LABEL, connectionStatus, displayName, sourceStatus, type ConnectionRow, type ConnectionsData, type Status, type UrlSetting, type Verdict } from "./connections";
import { ChangePreview, ChangeProgress, Group, IN_FLIGHT, Page, Row, StatusPill, useFiled } from "./settings-ui";
import { urlSettingProblem } from "../../src/url-setting";

type Can = { signIn: boolean; google: boolean };
const TONE: Record<Status, "ok" | "warn" | "bad" | "off" | "info"> = { connected: "ok", signed_out: "warn", error: "bad", not_configured: "off", unknown: "off", builtin: "info" };
const NEEDS: Status[] = ["error", "signed_out", "not_configured", "unknown"];
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "never");

export function ConnectionsPage({ conns, can, refresh, onRefresh }: { conns: ConnectionsData | null; can: Can; refresh: boolean; onRefresh: () => void }) {
  if (!conns) return <Page title="Connections" sub="Loading…"><RowsSkeleton /></Page>;
  const rows = conns.connections.map((r) => ({ r, v: connectionStatus(r, can) })).sort((a, b) => NEEDS.indexOf(a.v.status) - NEEDS.indexOf(b.v.status) || displayName(a.r.name).localeCompare(displayName(b.r.name)));
  const needs = rows.filter((x) => NEEDS.includes(x.v.status));
  const ok = rows.filter((x) => x.v.status === "connected");
  const built = rows.filter((x) => x.v.status === "builtin");
  return (
    <Page
      title="Connections"
      sub={`${ok.length} connected${needs.length ? `, ${needs.length} need${needs.length === 1 ? "s" : ""} setting up` : ""}. Each system is connected once, and agents get only the tools they're granted.`}
      tools={
        <button className="btn" onClick={onRefresh} disabled={refresh}>
          {refresh ? "Checking…" : "Check again"}
        </button>
      }
    >
      {needs.length > 0 && (
        <Group title="Needs setup" count={needs.length} tone="needs">
          {needs.map(({ r, v }) => (
            <ConnectionItem key={r.name} r={r} v={v} can={can} />
          ))}
        </Group>
      )}
      {ok.length > 0 && (
        <Group title="Connected" count={ok.length}>
          {ok.map(({ r, v }) => (
            <ConnectionItem key={r.name} r={r} v={v} can={can} />
          ))}
        </Group>
      )}
      {built.length > 0 && (
        <Group title="Built in" count={built.length} hint="Part of every agent run; nothing to set up.">
          {built.map(({ r, v }) => (
            <ConnectionItem key={r.name} r={r} v={v} can={can} />
          ))}
        </Group>
      )}
      <Group title="Warehouse sources" count={conns.sources.length} hint="What each source last brought into the shared warehouse.">
        {conns.sourcesError ? (
          <p className="st-empty">The apps platform didn't answer, so source state is unknown.</p>
        ) : !conns.sources.length ? (
          <p className="st-empty">No warehouse sources yet. They appear when a module that writes to the warehouse is on.</p>
        ) : (
          conns.sources.map((s) => {
            const sv = sourceStatus(s);
            return <Row key={s.name} title={<code>{s.name}</code>} sub={sv.reason} meta={<StatusPill tone={sv.status === "error" ? "bad" : s.failing ? "warn" : "ok"}>{sv.status === "error" ? "Behind" : s.failing ? "Last pass failed" : "Up to date"}</StatusPill>} />;
          })
        )}
      </Group>
    </Page>
  );
}

function ConnectionItem({ r, v, can }: { r: ConnectionRow; v: Verdict; can: Can }) {
  const urls = r.urls ?? [];
  const filed = useFiled((c) => c.kind === "setting" && urls.some((u) => u.key === c.key));
  const setup = v.status === "not_configured" && urls.length > 0;
  const [open, setOpen] = useState(setup || Boolean(filed && IN_FLIGHT.includes(filed.stage)));
  const pill = filed && IN_FLIGHT.includes(filed.stage) ? <StatusPill tone="busy">Changing</StatusPill> : <StatusPill tone={TONE[v.status]}>{STATUS_LABEL[v.status]}</StatusPill>;
  const connect = v.action ? (
    <a className={`btn${v.status === "signed_out" ? " primary" : ""}`} href={v.action.href}>
      {v.action.label}
    </a>
  ) : null;
  return (
    <Row
      tone={v.status}
      title={displayName(r.name)}
      sub={v.reason}
      meta={
        <>
          {r.kind === "connection" && v.status !== "builtin" && <span className="st-chip">{r.grants.length ? `${r.grants.length} agent${r.grants.length === 1 ? "" : "s"}` : "no agents"}</span>}
          {r.kind === "service" && <span className="st-chip">Engineer jobs</span>}
          {pill}
        </>
      }
      action={connect ?? (v.hint && v.status === "signed_out" ? <span className="st-hint">{v.hint}</span> : undefined)}
      open={open}
      onToggle={setOpen}
      details={
        <>
          {filed && <ChangeProgress f={filed} after={filed.stage === "applied" && connect && <p className="st-next">Next: {connect} to sign in.</p>} />}
          {urls.length > 0 && !(filed && IN_FLIGHT.includes(filed.stage)) && <UrlFields urls={urls} primaryOnly={setup} />}
          {setup && !connect && v.hint && <p className="st-hint">After the change is live, sign in from the host: {v.hint.replace(/^Connect from the board on the host \((.*)\)\.$/, "$1")}.</p>}
          {!urls.length && r.setup && v.status === "not_configured" && <p className="st-hint">{r.setup}</p>}
          <Facts r={r} />
          {r.google && <GoogleAccounts g={r.google} can={can.google} />}
        </>
      }
    />
  );
}

/** The URL settings of a connection: each a field; a not-set-up connection shows only the one(s) without a default. */
function UrlFields({ urls, primaryOnly }: { urls: UrlSetting[]; primaryOnly: boolean }) {
  const shown = primaryOnly ? urls.filter((u) => !u.default) : urls;
  return (
    <div className="st-urls">
      {(shown.length ? shown : urls).map((u) => (
        <UrlField key={u.key} u={u} startEditing={primaryOnly && !u.value} />
      ))}
    </div>
  );
}

const example = (doc?: string) => /e\.g\. (https:\/\/\S+?)[.,;]?(\s|$)/.exec(doc ?? "")?.[1];

function UrlField({ u, startEditing }: { u: UrlSetting; startEditing: boolean }) {
  const [editing, setEditing] = useState(startEditing);
  const [text, setText] = useState(u.value);
  const [touched, setTouched] = useState(false);
  const [review, setReview] = useState(false);
  const problem = text.trim() ? urlSettingProblem(text.trim(), u.host) : "Enter the URL.";
  const label = u.key.replace(/_/g, " ").replace(/\burl\b/, "URL").replace(/\bmcp\b/, "MCP").replace(/^./, (c) => c.toUpperCase());
  if (!editing)
    return (
      <div className="st-url-view">
        <span className="st-url-label">{label}</span>
        <code className="st-url-value">{u.value || u.default || "not set"}</code>
        <button className="link-btn" onClick={() => (setEditing(true), setText(u.value))}>
          Change
        </button>
      </div>
    );
  return (
    <form
      className="st-url-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!problem) setReview(true);
      }}
    >
      <label className="st-field">
        <span className="st-field-label">{label}</span>
        <span className="st-field-row">
          <input
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={text}
            placeholder={example(u.doc) ?? "https://"}
            onChange={(e) => (setText(e.target.value), setReview(false))}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && Boolean(problem)}
            aria-describedby={`${u.key}-help`}
            disabled={review}
          />
          {!review && (
            <button className="btn primary" type="submit">
              Save URL
            </button>
          )}
        </span>
        <span id={`${u.key}-help`} className={`st-field-help${touched && problem ? " bad" : ""}`}>
          {touched && problem ? problem.replace(/^./, (c) => c.toUpperCase()) : (u.doc ?? "")}
          {!(touched && problem) && u.host && <> Must be {u.host.startsWith("*.") ? `a ${u.host.slice(2)} address` : u.host}.</>}
        </span>
      </label>
      {review && <ChangePreview items={[{ kind: "setting", key: u.key, value: text.trim() }]} was={[u.value || null]} onCancel={() => setReview(false)} onDone={() => (setReview(false), setEditing(false))} note="You approve it on the card; on approval the host restarts only this connection." />}
      {!startEditing && !review && (
        <button type="button" className="link-btn" onClick={() => setEditing(false)}>
          Cancel
        </button>
      )}
    </form>
  );
}

function Facts({ r }: { r: ConnectionRow }) {
  const writers = r.grants.filter((g) => g.access === "write");
  const readers = r.grants.filter((g) => g.access === "read");
  return (
    <dl className="st-facts">
      {r.kind === "service" ? (
        <>
          <dt>Used by</dt>
          <dd>The runner's Engineer jobs</dd>
        </>
      ) : (
        <>
          {writers.length > 0 && (
            <>
              <dt>Read and write</dt>
              <dd>{writers.map((g) => g.name).join(", ")}</dd>
            </>
          )}
          {readers.length > 0 && (
            <>
              <dt>Read only</dt>
              <dd>{readers.length > 8 ? `${readers.slice(0, 8).map((g) => g.name).join(", ")} and ${readers.length - 8} more` : readers.map((g) => g.name).join(", ")}</dd>
            </>
          )}
          {!r.grants.length && (
            <>
              <dt>Granted to</dt>
              <dd className="muted">No agent yet</dd>
            </>
          )}
          <dt>Tools</dt>
          <dd>
            {r.tools.read} read, {r.tools.write} write{r.transport !== "built in" ? `, over ${r.transport}` : ""}
          </dd>
        </>
      )}
      {r.probe && (
        <>
          <dt>Health</dt>
          <dd>
            Checked {when(r.probe.checkedAt)}, last answered {when(r.probe.lastOkAt)}
          </dd>
        </>
      )}
      <dt>Module</dt>
      <dd>
        <code>{r.module || "core"}</code>
        {r.name !== r.module && <code className="muted"> {r.name}</code>}
      </dd>
    </dl>
  );
}

function GoogleAccounts({ g, can }: { g: NonNullable<ConnectionRow["google"]>; can: boolean }) {
  return (
    <ul className="st-accounts">
      {g.accounts.map((a) => (
        <li key={a.email}>
          <StatusPill tone={a.state === "ok" ? "ok" : a.state === "unknown" ? "off" : "warn"}>{a.state === "ok" ? "Working" : a.state === "expired" ? "Stopped working" : a.state === "unknown" ? "Checking" : "Error"}</StatusPill>
          <span className="st-account">
            {a.email}
            {a.primary && <span className="muted"> (calendar and meeting notes)</span>}
          </span>
          {can && a.state !== "ok" && (
            <a className="link-btn" href={`/google/connect?account=${encodeURIComponent(a.email)}`}>
              Reconnect
            </a>
          )}
        </li>
      ))}
      {can && (
        <li>
          <a className="link-btn" href="/google/connect">
            Add a Google account
          </a>
        </li>
      )}
    </ul>
  );
}

export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <section className="st-group" aria-busy="true" aria-label="Loading">
      <div className="st-rows">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="st-row st-row-sk">
            <span className="sk" style={{ width: `${28 + ((i * 17) % 30)}%`, height: 12 }} />
            <span className="sk" style={{ width: `${44 + ((i * 11) % 30)}%`, height: 10 }} />
          </div>
        ))}
      </div>
    </section>
  );
}
