// Modules > Marketplaces: where modules come from, each at its pinned sha.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { RowsSkeleton } from "./SettingsConnections";
import { ChangeProgress, Group, IN_FLIGHT, Row, useChanges, useFiled } from "./settings-ui";
import type { MarketplaceRow, SettingChange } from "./types";
import "./settings.css";
import { Tag } from "./ui";

type Op = Extract<SettingChange, { kind: "marketplace" }>;

export function Marketplaces({ onSignIn }: { onSignIn: () => void }) {
  const [rows, setRows] = useState<MarketplaceRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.marketplaces().then(
      (r) => setRows(r.marketplaces),
      (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)),
    );
  }, [onSignIn]);
  return (
    <section className="st-page">
      <AddMarketplace />
      {error ? <p className="fleet-empty">Couldn't load marketplaces: {error}</p> : !rows ? <RowsSkeleton /> : (
        <Group count={rows.length}>
          {rows.map((m) => (
            <MarketplaceItem key={m.name} m={m} />
          ))}
        </Group>
      )}
    </section>
  );
}

function useOp() {
  const { file, toast } = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (op: Op, done?: () => void) => {
    setBusy(true);
    setError("");
    try {
      toast(`Filed (${await file([op])}).`);
      done?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

const shortDate = (d: string) => (d ? new Date(d).toLocaleDateString() : "an unknown date");

function AddMarketplace() {
  const [repo, setRepo] = useState("");
  const [pin, setPin] = useState<{ sha: string; date: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const { run, busy, error } = useOp();
  const [problem, setProblem] = useState("");
  const ok = /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  const look = async () => {
    setLooking(true);
    setProblem("");
    try {
      setPin(await api.resolveMarketplace(repo.trim()));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setLooking(false);
    }
  };
  const add = () => pin?.sha && void run({ kind: "marketplace", op: "add", name: repo.trim().split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-"), source: { source: "github", repo: repo.trim() }, sha: pin.sha }, () => (setRepo(""), setPin(null)));
  return (
    <form className="br-add" onSubmit={(e) => (e.preventDefault(), ok && (pin ? add() : void look()))}>
      <input className="br-search" placeholder="github owner/repo" aria-label="GitHub repository" value={repo} onChange={(e) => (setRepo(e.target.value), setPin(null))} />
      <button className="btn primary" disabled={!ok || busy || looking}>{pin ? "Add marketplace" : "Check repository"}</button>
      {pin?.sha ? <p className="muted">Pinning {pin.sha.slice(0, 7)} from {shortDate(pin.date)} (the newest commit at least 7 days old). Reviewed by AI, then needs your tap.</p> : pin ? <p className="muted">No commit found for this repository, so there is nothing to pin.</p> : <p className="muted">Pinned at its newest commit that is at least 7 days old. Reviewed by AI, then needs your tap.</p>}
      {(problem || error) && <p className="st-error" role="alert">{problem || error}</p>}
    </form>
  );
}

function MarketplaceItem({ m }: { m: MarketplaceRow }) {
  const filed = useFiled((c) => c.kind === "marketplace" && c.name === m.name);
  const { run, busy, error } = useOp();
  const [confirm, setConfirm] = useState(false);
  const inFlight = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  return (
    <>
      {confirm && (
        <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && setConfirm(false)}>
          <div className="new-task" role="dialog" aria-label={`Remove ${m.name}?`}>
            <h2>Remove {m.name}?</h2>
            <p>Modules installed from it stop being available; remove them first or the change is refused.</p>
            <div className="ap-bar">
              <span className="spacer" />
              <button className="btn" autoFocus onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn primary" onClick={() => void run({ kind: "marketplace", op: "remove", name: m.name }, () => setConfirm(false))}>Remove</button>
            </div>
          </div>
        </div>
      )}
      <Row
        title={m.name}
        sub={m.source || "built in"}
        meta={
          <>
            <Tag>{m.sha ? m.sha.slice(0, 7) : "product"}</Tag>
            <Tag>{m.modules} modules</Tag>
            {m.newer && <Tag tone="needs">newer available</Tag>}
          </>
        }
        action={
          <>
            {m.newer && m.latest && <button className="btn" title={`Pin ${m.latest.sha.slice(0, 7)} from ${shortDate(m.latest.date)}`} disabled={busy || inFlight} onClick={() => void run({ kind: "marketplace", op: "update", name: m.name, sha: m.latest!.sha })}>Update to {m.latest.sha.slice(0, 7)}</button>}
            {m.name !== "aidenhq" && <button className="btn" disabled={busy || inFlight} onClick={() => setConfirm(true)}>Remove</button>}
          </>
        }
        details={
          <>
            {filed && <ChangeProgress f={filed} />}
            {error && <p className="st-error" role="alert">{error}</p>}
          </>
        }
      />
    </>
  );
}
