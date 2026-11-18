// A sign-in's page at #/connect/<id>: what to let agents do as the owner in a vendor (its scopes, grouped by product, the
// recommended ones on), then on to the vendor; or, back from a failed sign-in (#/connect/<id>?error=…), why and the way on.
// The server's /<id>/connect sends the browser here and takes back `picked` and the chosen scopes.
import { useEffect, useMemo, useState } from "react";
import { SignInRequired, api, type SignInView } from "./api";
import { changes, groupScopes } from "./scopes";
import { Banner, Button, LinkButton, PageHeader } from "./ui";
import "./settings.css";
import "./setup-flow.css";

export function ConnectPage({ id, error, onSignIn }: { id: string; error: string | null; onSignIn: () => void }) {
  const [view, setView] = useState<SignInView | null>(null);
  const [failed, setFailed] = useState("");
  useEffect(() => {
    api.signIn(id).then(setView, (e) => (e instanceof SignInRequired ? onSignIn() : setFailed((e as Error).message)));
  }, [id, onSignIn]);
  const back = view?.setup ? `#/setup/${view.setup}` : "#/settings/connections";
  const name = view?.label ?? "the service";

  return (
    <div className="setup-overlay">
      <main className="st-page setup-page">
        <PageHeader title={error ? `Couldn't connect ${name}` : `Connect ${name}`} sub={error ? undefined : view?.scopes ? `Choose what agents may do as you in ${name}. The recommended access is already on.` : undefined} />
        {error && <Banner tone="danger">{error.replace(/^Couldn't connect [^:]+: /, "")}</Banner>}
        {failed && <Banner tone="danger">{`Couldn't load this sign-in: ${failed}`}</Banner>}
        {!error && view && (view.scopes ? <Picker view={view} back={back} /> : <Plain view={view} back={back} />)}
        {(error || failed) && (
          <footer className="setup-foot">
            <span className="setup-hint">{view ? `Nothing changed in ${name}. Try again, or come back to it later.` : ""}</span>
            <div className="setup-actions">
              <LinkButton href={view ? back : "#/"}>{view ? "Back" : "Back to the board"}</LinkButton>
              {error && view && <LinkButton variant="primary" href={view.connect}>Try again</LinkButton>}
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}

/** A vendor that offers no choice of access: straight on. */
function Plain({ view, back }: { view: SignInView; back: string }) {
  return (
    <footer className="setup-foot">
      <LinkButton href={back}>Back</LinkButton>
      <LinkButton variant="primary" href={view.connect}>Continue to {view.label}</LinkButton>
    </footer>
  );
}

function Picker({ view, back }: { view: SignInView; back: string }) {
  const offer = view.scopes!;
  const groups = useMemo(() => groupScopes(offer.supported), [offer.supported]);
  const [on, setOn] = useState(() => new Set(offer.recommended.filter((s) => offer.supported.includes(s))));
  const [raw, setRaw] = useState(false);
  const toggle = (scope: string) => setOn((was) => (was.delete(scope) ? new Set(was) : new Set(was).add(scope)));
  const writes = groups.flatMap((g) => g.items).filter((i) => on.has(i.scope) && changes(i.access)).length;
  const go = () => {
    const q = new URLSearchParams({ picked: "1" });
    for (const s of offer.supported) if (on.has(s)) q.append("scope", s);
    location.href = `${view.connect}?${q}`;
  };

  return (
    <>
      <Banner>
        Agents act as you with what you allow here. <b>Anything they write is still reviewed before it runs.</b>
      </Banner>
      <section className="setup-card connect-card">
        <header className="connect-head">
          <h2>Access</h2>
          <div className="connect-tools">
            <Button size="sm" variant="quiet" onClick={() => setOn(new Set(offer.recommended))}>Recommended</Button>
            <Button size="sm" variant="quiet" onClick={() => setOn(new Set(groups.flatMap((g) => g.items).filter((i) => i.access === "read" || i.access === "search" || (!i.access && offer.recommended.includes(i.scope))).map((i) => i.scope)))}>
              All read access
            </Button>
            <Button size="sm" variant="quiet" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? "Hide scope names" : "Show scope names"}</Button>
          </div>
        </header>
        <div className="connect-rows">
          {groups.map((g) => (
            <div key={g.key} className="connect-row">
              <div className="connect-name">
                <b>{g.name}</b>
                <span>{g.items.filter((i) => on.has(i.scope)).length ? describe(g.items.filter((i) => on.has(i.scope)).map((i) => i.label)) : "No access"}</span>
              </div>
              <div className="ui-checks" role="group" aria-label={g.name}>
                {g.items.map((i) => (
                  <label key={i.scope} title={i.scope} className={`ui-check${on.has(i.scope) ? " on" : ""}${changes(i.access) ? " connect-change" : ""}`}>
                    <input type="checkbox" checked={on.has(i.scope)} onChange={() => toggle(i.scope)} />
                    {raw ? <code>{i.scope}</code> : i.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <footer className="setup-foot">
        <span className="setup-hint">
          {on.size} of {offer.supported.length} on{writes ? `, ${writes} that can change things` : ", read only"}.
        </span>
        <div className="setup-actions">
          <LinkButton href={back}>Back</LinkButton>
          <Button variant="primary" disabled={!on.size} onClick={go}>Continue to {view.label}</Button>
        </div>
      </footer>
    </>
  );
}

/** "Read, Search and Write". */
const describe = (labels: string[]) => (labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);
