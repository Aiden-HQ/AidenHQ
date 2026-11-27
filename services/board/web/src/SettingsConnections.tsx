// Settings > Connections: tiles, what needs you first (with Connect, Reconnect or Set up on the tile), then what is connected,
// then what is built in; a tile opens its dialog (state, grants, health, Google accounts). Connect is one click (Connect.tsx).
import { useEffect, useState } from "react";
import { api } from "./api";
import { ConnectButton, ConnectDialog, GoogleConnect } from "./Connect";
import { OrganisationPicker } from "./Organisation";
import { STATUS_LABEL, connectionStatus, displayName, sourceStatus, type ConnectionRow, type ConnectionsData, type Status, type Verdict } from "./connections";
import { Group, Page, Row } from "./settings-ui";
import { SetupButton } from "./SetupButton";
import { SignInLines, linesNeeding } from "./SignInLines";
import { Banner, Button, Dialog, LinkButton, Section, StatusDot, Tile, TileGrid, type StatusTone } from "./ui";
import { clockOpts } from "./util";

type Can = { signIn: boolean };
const TONE: Record<Status, StatusTone> = { connected: "ok", not_connected: "idle", signed_out: "needs", error: "failed", not_configured: "idle", unknown: "idle", builtin: "info" };
const NEEDS: Status[] = ["error", "signed_out", "not_configured", "unknown"];
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", ...clockOpts() }) : "never");

/** The hash's query: `connect=<id>[&error=…]` opens that connection's Connect (an old link, or a sign-in that failed); `connected=<id>`: this tab was opened for a sign-in that just landed. */
const asked = () => new URLSearchParams(location.hash.split("?")[1] ?? "");

export function ConnectionsPage({ conns, can, refresh, onRefresh }: { conns: ConnectionsData | null; can: Can; refresh: boolean; onRefresh: () => void }) {
  const [q, setQ] = useState(asked);
  const done = q.get("connected");
  // The tab the board opened for the sign-in closes itself; the one that pressed Connect has turned Connected meanwhile.
  useEffect(() => {
    if (done) window.close();
  }, [done]);
  const clear = () => (history.replaceState(null, "", "#/settings/connections"), setQ(new URLSearchParams()));
  if (!conns) return <Page title="Connections" sub="Loading…"><RowsSkeleton /></Page>;
  const rows = conns.connections.map((r) => ({ r, v: connectionStatus(r, can) })).sort((a, b) => NEEDS.indexOf(a.v.status) - NEEDS.indexOf(b.v.status) || displayName(a.r.name).localeCompare(displayName(b.r.name)));
  const needs = rows.filter((x) => NEEDS.includes(x.v.status));
  const ok = rows.filter((x) => x.v.status === "connected");
  const idle = rows.filter((x) => x.v.status === "not_connected");
  const built = rows.filter((x) => x.v.status === "builtin");
  const tiles = (list: typeof rows) => (
    <TileGrid>
      {list.map(({ r, v }) => (
        <ConnectionTile key={r.name} r={r} v={v} can={can} connect={q.get("connect") === r.name ? { error: q.get("error"), account: q.get("account") } : undefined} onAsked={clear} />
      ))}
    </TileGrid>
  );
  return (
    <Page
      title="Connections"
      sub={`${ok.length} connected${needs.length ? `, ${needs.length} need${needs.length === 1 ? "s" : ""} you` : ""}. Each system is connected once, and agents get only the tools they're granted.`}
      tools={
        <Button onClick={onRefresh} disabled={refresh}>
          {refresh ? "Checking…" : "Check again"}
        </Button>
      }
    >
      {done && <Banner>{displayName(done)} is connected.</Banner>}
      {/* A failed sign-in of a connection without a tile here (Google's): its reason, and the way on. */}
      {q.get("error") && !conns.connections.some((r) => r.name === q.get("connect")) && (
        <Banner tone="danger" action={<Button size="sm" onClick={clear}>Dismiss</Button>}>
          {q.get("error")} Nothing changed; press Connect to try again.
        </Banner>
      )}
      <OrganisationPicker compact onApplied={onRefresh} />
      {needs.length > 0 && <Section title="Needs you" count={needs.length}>{tiles(needs)}</Section>}
      {idle.length > 0 && <Section title="Not connected yet" count={idle.length} hint="Optional: connect one when you want agents to use it.">{tiles(idle)}</Section>}
      {ok.length > 0 && <Section title="Connected" count={ok.length}>{tiles(ok)}</Section>}
      {built.length > 0 && <Section title="Built in" count={built.length} hint="Part of every agent run; nothing to set up.">{tiles(built)}</Section>}
      <Group title="Warehouse sources" count={conns.sources.length} hint="What each source last brought into the shared warehouse.">
        {conns.sourcesError ? (
          <p className="st-empty">The apps platform didn't answer, so source state is unknown.</p>
        ) : !conns.sources.length ? (
          <p className="st-empty">No warehouse sources yet. They appear when a module that writes to the warehouse is on.</p>
        ) : (
          conns.sources.map((s) => {
            const sv = sourceStatus(s);
            return <Row key={s.name} title={<code>{s.name}</code>} sub={sv.reason} meta={<StatusDot tone={sv.status === "error" ? "failed" : s.failing ? "needs" : "ok"}>{sv.status === "error" ? "Behind" : s.failing ? "Last pass failed" : "Up to date"}</StatusDot>} />;
          })
        )}
      </Group>
    </Page>
  );
}

/** One connection: a tile with its state and its one action (Connect, Reconnect, Set up); everything else in its dialog. */
function ConnectionTile({ r, v, can, connect: asked, onAsked }: { r: ConnectionRow; v: Verdict; can: Can; connect?: { error: string | null; account?: string | null }; onAsked: () => void }) {
  const [open, setOpen] = useState(false);
  const c = { id: r.name, label: displayName(r.name), signIn: r.signIn };
  // A module sign-in connects in one click (Connect.tsx); Google's own Connect is a link; one that needs its client made first
  // (a setup flow) says Set up.
  const connect = v.action ? (
    r.signIn ? (
      <ConnectButton c={c} variant={v.status === "error" ? undefined : "primary"} size="sm" word={v.action.label} />
    ) : (
      <LinkButton variant={v.status === "signed_out" ? "primary" : undefined} size="sm" href={v.action.href}>
        {v.action.label}
      </LinkButton>
    )
  ) : v.status === "not_configured" ? (
    <SetupButton module={r.module} primary size="sm" />
  ) : null;
  // A sign-in that holds a token (ok, expired, or not checked yet: unknown) can run again: to grant more (the scope picker),
  // switch accounts, or move to an organisation's app.
  const again = r.signIn?.configured && r.signIn.state !== "missing" && r.signIn.state !== "none" && can.signIn ? <ConnectButton c={c} size="sm" /> : null;
  // Never signed in reads "Not connected yet", calm; "Signed out" is a sign-in that stopped working.
  const status = <StatusDot tone={TONE[v.status]}>{STATUS_LABEL[v.status]}</StatusDot>;
  const who = r.kind === "service" ? "Engineer jobs" : v.status === "builtin" ? null : r.grants.length ? `${r.grants.length} agent${r.grants.length === 1 ? "" : "s"}` : "No agents yet";
  return (
    <>
      <Tile
        onOpen={() => setOpen(true)}
        name={r.name}
        title={displayName(r.name)}
        tone={v.status === "error" ? "failed" : v.status === "signed_out" || v.status === "not_configured" ? "needs" : undefined}
        status={status}
        facts={
          <>
            {who && <span>{who}</span>}
            {linesNeeding(r.signIn) > 0 && <span className="st-need">{linesNeeding(r.signIn)} to fix</span>}
            {r.kind === "connection" && v.status !== "builtin" && <span>{r.tools.read} read, {r.tools.write} write tools</span>}
          </>
        }
        foot={r.module || "core"}
        action={connect ?? again ?? undefined}
      >
        {v.reason}
      </Tile>
      {asked && (r.google ? <GoogleConnect account={asked.account} error={asked.error} onClose={onAsked} /> : <ConnectDialog c={c} error={asked.error} onClose={onAsked} />)}
      <Dialog open={open} onClose={() => setOpen(false)} title={displayName(r.name)} wide actions={connect ?? again}>
        <div className="st-conn">
          <p className="st-conn-state">
            {status} <span>{v.reason}</span>
          </p>
          {v.hint && <p className="st-hint">{v.hint}</p>}
          <SignInLines c={c} can={can.signIn} />
          {r.signIn?.state === "ok" && <TestSignIn id={r.name} />}
          {r.google?.accounts.some((a) => a.state === "ok") && <TestSignIn id={r.name} google />}
          {!connect && r.setup && v.status === "not_configured" && <p className="st-hint">{r.setup}</p>}
          <Facts r={r} />
          {r.google && <GoogleAccounts g={r.google} />}
        </div>
      </Dialog>
    </>
  );
}

/** Test connection: one live read through the sign-in; what is wrong comes back in words with the one thing to do. */
function TestSignIn({ id, google }: { id: string; google?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.testSignIn>> | null>(null);
  const test = () => {
    setBusy(true);
    setResult(null);
    (google ? api.testGoogle() : api.testSignIn(id)).then(setResult, (e: Error) => setResult({ ok: false, message: e.message })).finally(() => setBusy(false));
  };
  return (
    <div className="st-test">
      <Button size="sm" disabled={busy} onClick={test}>
        {busy ? "Testing…" : "Test"}
      </Button>
      {result && (result.ok ? <Banner>It works: {displayName(id)} answered.</Banner> : <Banner tone="danger">{result.message}{result.fix ? ` ${result.fix}.` : ""}</Banner>)}
    </div>
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

function GoogleAccounts({ g }: { g: NonNullable<ConnectionRow["google"]> }) {
  return (
    <ul className="st-accounts">
      {g.accounts.map((a) => (
        <li key={a.email}>
          <StatusDot tone={a.state === "ok" ? "ok" : a.state === "unknown" ? "idle" : "needs"}>{a.state === "ok" ? "Working" : a.state === "expired" ? "Stopped working" : a.state === "unknown" ? "Checking" : "Error"}</StatusDot>
          <span className="st-account">
            {a.email}
            {a.primary && <span className="muted"> (calendar and meeting notes)</span>}
          </span>
          {a.state !== "ok" && (
            <a className="link-btn" href={`/google/connect?account=${encodeURIComponent(a.email)}`}>
              Reconnect
            </a>
          )}
        </li>
      ))}
      <li>
        <a className="link-btn" href="/google/connect">
          Add a Google account
        </a>
      </li>
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
