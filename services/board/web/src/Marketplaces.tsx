// Modules > Marketplaces: where modules come from, each at its pinned sha.
import { useEffect, useState } from "react";
import { SignInRequired, api } from "./api";
import { RowsSkeleton } from "./SettingsConnections";
import { ChangeProgress, Group, IN_FLIGHT, Row, useChanges, useFiled } from "./settings-ui";
import type { MarketplaceRow, SettingChange } from "./types";
import "./settings.css";

type Op = { kind: "marketplace"; op: "add" | "update" | "remove"; name: string; source?: { source: "github"; repo: string }; sha?: string };

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
      toast(`Filed (${await file([op as unknown as SettingChange])}).`);
      done?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

function AddMarketplace() {
  const [repo, setRepo] = useState("");
  const { run, busy, error } = useOp();
  const ok = /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  return (
    <form className="br-add" onSubmit={(e) => (e.preventDefault(), ok && void run({ kind: "marketplace", op: "add", name: repo.trim().split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]/g, "-"), source: { source: "github", repo: repo.trim() } }, () => setRepo("")))}>
      <input className="br-search" placeholder="github owner/repo" aria-label="GitHub repository" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <button className="btn primary" disabled={!ok || busy}>Add marketplace</button>
      <p className="muted">Reviewed by AI, then needs your tap.</p>
      {error && <p className="st-error" role="alert">{error}</p>}
    </form>
  );
}

function MarketplaceItem({ m }: { m: MarketplaceRow }) {
  const filed = useFiled((c) => (c as unknown as Op).kind === "marketplace" && (c as unknown as Op).name === m.name);
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
            <span className="st-chip">{m.sha ? m.sha.slice(0, 7) : "product"}</span>
            <span className="st-chip">{m.modules} modules</span>
            {m.newer && <span className="st-chip warn">newer available</span>}
          </>
        }
        action={
          <>
            {m.newer && <button className="btn" disabled={busy || inFlight} onClick={() => void run({ kind: "marketplace", op: "update", name: m.name })}>Update</button>}
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
