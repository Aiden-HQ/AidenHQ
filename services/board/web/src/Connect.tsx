// One Connect for every module sign-in (board.signins), wherever a connection is listed: Settings > Connections, a module's
// page, the sign-in banners, a setup flow. The vendor's sign-in opens in a new tab and the board turns Connected when it
// lands (the server's `connections` event). Before that, in one small dialog and only when needed: the sign-in's per-install
// values (its `secrets`: saved to the vault, then the proxy restarts with them) and the choice of scopes the vendor offers.
import { useEffect, useMemo, useState } from "react";
import { SignInRequired, api, type SignInView } from "./api";
import { connectionStatus, displayName, type SignIn } from "./connections";
import { useEvents } from "./events";
import { changes, groupScopes } from "./scopes";
import { Banner, Button, Dialog, type ButtonVariant } from "./ui";
import "./setup-flow.css";

export interface Connectable {
  id: string;
  label: string;
  signIn: Pick<SignIn, "state" | "offer" | "fields"> | null;
}

export type Can = { signIn: boolean; google: boolean };

/** Each module's sign-in waiting for a Connect (as Settings > Connections has it), refetched when a sign-in lands. */
export function useConnectNeeded(can: Can): Map<string, { c: Connectable; word: string }> {
  const [needed, setNeeded] = useState<Map<string, { c: Connectable; word: string }>>(new Map());
  const load = () =>
    api.connections().then(
      (d) =>
        setNeeded(
          new Map(
            d.connections.flatMap((r) => {
              const v = connectionStatus(r, can);
              return r.signIn && v.action ? [[r.module, { c: { id: r.name, label: displayName(r.name), signIn: r.signIn }, word: v.action.label }] as const] : [];
            }),
          ),
        ),
      () => {},
    );
  useEvents(["connections"], load);
  useEffect(() => void load(), [can.signIn, can.google]);
  return needed;
}

/** "Connect", "Reconnect" or (connected, with scopes on offer) "Change access". */
export const connectWord = (s: Connectable["signIn"]) => (s?.state === "ok" || s?.state === "none" ? (s.offer ? "Change access" : "Reconnect") : s?.state === "expired" ? "Reconnect" : "Connect");

/** A new tab for the vendor's sign-in, opened in the click itself (so no popup blocker stops it), cut off from this one. */
function newTab(): Window | null {
  const w = window.open("", "_blank");
  if (w) w.opener = null;
  return w;
}
const go = (w: Window | null, path: string) => {
  const url = new URL(path, location.href).href;
  if (w) w.location.href = url;
  else location.href = url; // the browser refused a tab: sign in here, and come back to Connections
};

export function ConnectButton({ c, variant, size, word, open: startOpen, error, onClose }: { c: Connectable; variant?: ButtonVariant; size?: "sm"; word?: string; open?: boolean; error?: string | null; onClose?: () => void }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  // Nothing to ask: straight to the vendor.
  const direct = !c.signIn?.fields?.length && !c.signIn?.offer && !error;
  const close = () => (setOpen(false), onClose?.());
  return (
    <>
      <Button variant={variant} size={size} onClick={() => (direct ? go(newTab(), `/${c.id}/connect`) : setOpen(true))}>
        {word ?? connectWord(c.signIn)}
      </Button>
      {open && <ConnectDialog c={c} error={error ?? null} onClose={close} />}
    </>
  );
}

/** A value against its declared pattern (the kernel checks again on save); a pattern the browser can't read passes. */
function fits(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ConnectDialog({ c, error, onClose }: { c: Connectable; error: string | null; onClose: () => void }) {
  const [view, setView] = useState<SignInView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState(error ? error.replace(/^Couldn't connect [^:]+: /, "") : "");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    api.signIn(c.id).then(
      (v) => (setView(v), setOn(v.scopes ? new Set(v.scopes.recommended.filter((s) => v.scopes!.supported.includes(s))) : null)),
      (e) => setProblem(e instanceof SignInRequired ? "Your session ended. Sign in again, then press Connect." : `Couldn't load this connection: ${(e as Error).message}`),
    );
  }, [c.id]);
  const fields = view && !view.configured ? view.fields : [];
  const bad = fields.filter((f) => !fits(f.pattern, (values[f.secret] ?? "").trim()));

  const connect = async () => {
    setTouched(true);
    if (!view || bad.length || (on && !on.size)) return;
    const w = newTab();
    setProblem("");
    try {
      if (fields.length) {
        setBusy("Saving…");
        for (const f of fields) await api.signInSecret(c.id, f.secret, values[f.secret]!.trim());
        // The proxy restarts to read it; the sign-in can start once it reports itself set up.
        setBusy(`Starting ${view.label}…`);
        let ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
          await sleep(2000);
          ready = await api.signIn(c.id).then((v) => v.configured, () => false);
        }
        if (!ready) throw new Error(`Saved. ${view.label} is still restarting: press Connect again in a minute.`);
      }
      const q = new URLSearchParams();
      if (on) {
        q.set("picked", "1");
        for (const s of view.scopes!.supported) if (on.has(s)) q.append("scope", s);
      }
      go(w, `${view.connect}${on ? `?${q}` : ""}`);
      onClose();
    } catch (e) {
      w?.close();
      const msg = e instanceof SignInRequired ? "Your session ended. Sign in again, then press Connect." : (e as Error).message;
      setProblem(/only the owner/.test(msg) ? "Only the owner can set this up. Ask them to press Connect." : msg);
      setBusy("");
    }
  };

  const label = view?.label ?? c.label;
  return (
    <Dialog
      open
      onClose={onClose}
      title={connectWord(c.signIn) === "Change access" ? `${label} access` : `${connectWord(c.signIn)} ${label}`}
      wide={Boolean(view?.scopes)}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!view || Boolean(busy) || (on !== null && !on.size)} onClick={() => void connect()}>
            {busy || (error ? "Try again" : "Connect")}
          </Button>
        </>
      }
    >
      {problem && <Banner tone="danger">{problem}</Banner>}
      {fields.map((f) => {
        const wrong = touched && bad.includes(f);
        return (
          <label key={f.secret} className="ui-field">
            <span className="ui-field-label">{f.label}</span>
            <input
              className="ui-input"
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              value={values[f.secret] ?? ""}
              aria-invalid={wrong}
              onChange={(e) => setValues({ ...values, [f.secret]: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && void connect()}
            />
            <span className={wrong ? "ui-field-error" : "ui-field-help"}>{wrong ? `That doesn't look right. ${f.help ?? ""}` : f.help}</span>
          </label>
        );
      })}
      {view?.scopes && on && <Picker offer={view.scopes} on={on} setOn={setOn} />}
      {view && !fields.length && !view.scopes && !problem && <p>{label} opens in a new tab. Sign in there and allow access.</p>}
    </Dialog>
  );
}

/** What agents may do as the owner in the vendor: its scopes grouped by product, the recommended ones on. */
function Picker({ offer, on, setOn }: { offer: NonNullable<SignInView["scopes"]>; on: Set<string>; setOn: (s: Set<string>) => void }) {
  const groups = useMemo(() => groupScopes(offer.supported), [offer.supported]);
  const [raw, setRaw] = useState(false);
  const toggle = (scope: string) => {
    const next = new Set(on);
    if (!next.delete(scope)) next.add(scope);
    setOn(next);
  };
  const writes = groups.flatMap((g) => g.items).filter((i) => on.has(i.scope) && changes(i.access)).length;
  return (
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
      <p className="connect-sum">
        {on.size} of {offer.supported.length} on{writes ? `, ${writes} that can change things. Anything agents write is still reviewed before it runs.` : ", read only."}
      </p>
    </section>
  );
}

/** "Read, Search and Write". */
const describe = (labels: string[]) => (labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);
