// Your organisation (modules/marketplace.json `organisations`): members of an organisation that runs internal apps sign in with
// its apps, so they never make their own. Choosing one fills those connections' client IDs; each then connects as usual. Shown
// on Settings > Connections and as the wizard's first step; nothing when the catalog lists none.
import { useEffect, useState } from "react";
import { SignInRequired, api, type Organisations } from "./api";
import { displayName } from "./connections";
import { Banner, Button } from "./ui";
import "./setup-flow.css";

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * The organisation a picker starts on: only one the catalog still lists (a saved id may have left it). A setup page (`bare`, for
 * its `module`) starts on the one applied to that module, else the saved or suggested one if it has an app for the module (the
 * dropdown lists no other).
 */
function initialPick(d: Organisations, module: string | undefined, bare: boolean | undefined): string | null {
  const listed = (id: string | null | undefined) => {
    const o = d.organisations.find((x) => x.id === id);
    return o && (!bare || !module || o.connections.includes(module)) ? o.id : null;
  };
  return (bare && module ? listed(d.applied?.[module]) : null) ?? listed(d.chosen) ?? listed(d.suggested);
}

/**
 * `onContinue` (the wizard): one primary Continue that applies the picked organisation, or moves on with None, and always shows
 * the choice. Otherwise (Settings) a chosen organisation collapses to a line with Change. `bare` (inside a setup flow's way, for its
 * `module`): a dropdown of the organisations and its button, applying only that module's client, with no card or None.
 */
export function OrganisationPicker({ onApplied, onContinue, compact, bare, module }: { onApplied?: () => void; onContinue?: () => void; compact?: boolean; bare?: boolean; module?: string }) {
  const [data, setData] = useState<Organisations | null | undefined>(undefined);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    api.organisations().then((d) => (setData(d), setPick(initialPick(d, module, bare))), () => setData(null));
  }, [module, bare]);
  if (data === undefined) return null;
  if (!data?.organisations.length) {
    return onContinue ? (
      <div className="setup-actions">
        <Button variant="primary" onClick={onContinue}>Continue</Button>
      </div>
    ) : null;
  }
  // A setup page lists only the organisations that have an app for its module.
  const offered = module ? data.organisations.filter((o) => o.connections.includes(module)) : data.organisations;
  const chosen = data.organisations.find((o) => o.id === data.chosen);
  const apply = async () => {
    if (!pick || (pick === data.chosen && !bare)) return onContinue?.();
    setBusy(true);
    setProblem("");
    try {
      const r = await api.organisationApply(pick, module);
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) setProblem(`${list(failed.map((f) => displayName(f.module)))} didn't take it: ${failed[0]!.error}`);
      else {
        setData({ ...data, chosen: pick });
        setEditing(false);
        onApplied?.();
        onContinue?.();
      }
    } catch (e) {
      setProblem(e instanceof SignInRequired ? "Your session ended. Sign in again to continue." : /only the owner/.test((e as Error).message) ? "Only the owner can choose the organisation." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (chosen && !editing && !onContinue && !bare) {
    return (
      <section className={`setup-card org${compact ? " org-compact" : ""}`} aria-label="Your organisation">
        <div className="org-chosen">
          <span className="org-mark" aria-hidden>{chosen.name.slice(0, 1)}</span>
          <div>
            <strong>Signing in with {chosen.name}'s apps</strong>
            <small>{list(chosen.connections.map(displayName))} use {chosen.name}'s own sign-in. Connect each one when you want it.</small>
          </div>
          <Button size="sm" onClick={() => setEditing(true)}>Change</Button>
        </div>
      </section>
    );
  }
  if (bare) {
    return (
      <section className="org-bare" aria-label="Your organisation">
        <label className="setup-field">
          <span>Your organisation</span>
          <select className="ui-select" value={pick ?? ""} onChange={(e) => setPick(e.target.value || null)}>
            <option value="">Choose your organisation</option>
            {offered.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.domains.join(", ")}){o.id === data.suggested ? ", matches your email" : ""}
              </option>
            ))}
          </select>
        </label>
        {problem && <Banner tone="danger">{problem}</Banner>}
        <div className="setup-actions">
          <Button variant="primary" disabled={busy || !pick} onClick={() => void apply()}>
            {busy ? "Saving…" : pick ? `Use ${offered.find((o) => o.id === pick)!.name}` : "Use this organisation"}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className={`setup-card org${compact ? " org-compact" : ""}`} aria-label="Your organisation">
      <header className="org-head">
        <h2>Your organisation</h2>
        <p>If your organisation runs its own apps for these, you sign in with them and make nothing yourself.</p>
      </header>
      {problem && <Banner tone="danger">{problem}</Banner>}
      <div className="setup-options" role="radiogroup" aria-label="Organisation">
        {data.organisations.map((o) => (
          <label key={o.id} className={`setup-option${pick === o.id ? " on" : ""}`}>
            <input type="radio" name="organisation" checked={pick === o.id} onChange={() => setPick(o.id)} />
            <span>
              <strong>
                {o.name}
                {o.id === data.suggested && <em className="org-match">Matches your email</em>}
              </strong>
              <small>
                {o.domains.join(", ")}. Fills in {list(o.connections.map(displayName))}.
              </small>
            </span>
          </label>
        ))}
        <label className={`setup-option${pick === null ? " on" : ""}`}>
          <input type="radio" name="organisation" checked={pick === null} onChange={() => setPick(null)} />
          <span>
            <strong>None of these</strong>
            <small>Each connection guides you through making your own app where it needs one.</small>
          </span>
        </label>
      </div>
      <div className="setup-actions">
        {onContinue ? (
          <Button variant="primary" disabled={busy} onClick={() => void apply()}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        ) : (
          pick && (
            <Button variant="primary" disabled={busy || pick === data.chosen} onClick={() => void apply()}>
              {busy ? "Saving…" : `Use ${data.organisations.find((o) => o.id === pick)!.name}`}
            </Button>
          )
        )}
        {editing && <Button onClick={() => setEditing(false)}>Cancel</Button>}
      </div>
    </section>
  );
}
