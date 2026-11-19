// One Connect for every module sign-in (board.signins), wherever a connection is listed: Settings > Connections, a module's
// page, the sign-in banners, a setup flow. The vendor's sign-in opens in a new tab and ends on a loopback address that
// doesn't load (no domain for a company to allow): the dialog asks for that address and finishes the sign-in with it. The
// board turns Connected when it lands (the server's `connections` event). Before that, in the same dialog and only when
// needed: the sign-in's per-install values (its `secrets`: saved to the vault, then the proxy restarts with them) and the
// choice of scopes the vendor offers. One click (back to the board's https address) stays as a link where it exists.
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
const abs = (path: string) => new URL(path, location.href).href;
const go = (w: Window | null, path: string) => {
  if (w) w.location.href = abs(path);
  else location.href = abs(path); // the browser refused a tab: sign in here, and come back to Connections
};
/** How a Connect with nothing to ask started its sign-in: in a new tab, or (the browser refused one) a link in the dialog. */
type Started = "tab" | "link";

export function ConnectButton({ c, variant, size, word, open: startOpen, error, onClose }: { c: Connectable; variant?: ButtonVariant; size?: "sm"; word?: string; open?: boolean; error?: string | null; onClose?: () => void }) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [started, setStarted] = useState<Started | undefined>();
  // Nothing to ask: straight to the vendor, and the dialog waits for the address the sign-in ends on.
  const direct = !c.signIn?.fields?.length && !c.signIn?.offer && !error;
  const close = () => (setOpen(false), setStarted(undefined), onClose?.());
  const press = () => {
    if (direct) {
      const w = newTab();
      if (w) w.location.href = abs(`/${c.id}/connect`);
      setStarted(w ? "tab" : "link");
    }
    setOpen(true);
  };
  return (
    <>
      <Button variant={variant} size={size} onClick={press}>
        {word ?? connectWord(c.signIn)}
      </Button>
      {open && <ConnectDialog c={c} error={error ?? null} started={started} onClose={close} />}
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

export function ConnectDialog({ c, error, started, onClose }: { c: Connectable; error: string | null; started?: Started; onClose: () => void }) {
  const [view, setView] = useState<SignInView | null>(null);
  // "paste": the sign-in is open; waiting for the address it ended on. `link`: where it is, when the browser refused a tab.
  const [phase, setPhase] = useState<"ask" | "paste">(started ? "paste" : "ask");
  const [link, setLink] = useState<string | null>(started === "link" ? abs(`/${c.id}/connect`) : null);
  const [pasted, setPasted] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState(error ? error.replace(/^Couldn't connect [^:]+: /, "") : "");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    api.signIn(c.id).then(
      (v) => {
        // A vendor that takes only https redirects (Slack) finishes on the board by itself: nothing to paste.
        if (started && !v.redirect) return started === "link" ? go(null, v.connect) : onClose();
        setView(v);
        setOn(v.scopes ? new Set((v.scopes.granted ?? v.scopes.recommended).filter((s) => v.scopes!.supported.includes(s))) : null);
      },
      (e) => setProblem(e instanceof SignInRequired ? "Your session ended. Sign in again, then press Connect." : `Couldn't load this connection: ${(e as Error).message}`),
    );
  }, [c.id]);
  // Through a tunnel (or one click) the sign-in lands on the board itself: a first sign-in turning ok closes the dialog.
  useEvents(["connections"], () => {
    if (phase === "paste" && view && view.state !== "ok") void api.signIn(c.id).then((v) => v.state === "ok" && onClose(), () => {});
  });
  const fields = view?.asks ? view.fields : [];
  /** The owner's pick of scopes, for the Connect path. */
  const picked = () => {
    const q = new URLSearchParams();
    if (on) {
      q.set("picked", "1");
      for (const s of view!.scopes!.supported) if (on.has(s)) q.append("scope", s);
    }
    return q;
  };
  /** The sign-in back to the board's https address (one click, where a company allows that domain). */
  const oneClick = () => {
    const q = picked();
    q.set("oneclick", "1");
    go(newTab(), `${view!.connect}?${q}`);
    onClose();
  };
  const finish = async () => {
    if (!pasted.trim()) return;
    setProblem("");
    setBusy("Finishing…");
    try {
      await api.signInFinish(c.id, pasted.trim());
      onClose();
    } catch (e) {
      setProblem(e instanceof SignInRequired ? "Your session ended. Sign in again, then press Connect." : (e as Error).message.replace(/^Couldn't connect [^:]+: (.)/, (_m, c: string) => c.toUpperCase()));
      setBusy("");
    }
  };
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
          ready = await api.signIn(c.id).then((v) => !v.asks || Boolean(v.detail), () => false);
        }
        if (!ready) throw new Error(`Saved. ${view.label} is still restarting: press Connect again in a minute.`);
        const fresh = await api.signIn(c.id);
        // A pasted token that Primer accepts is the whole sign-in; one it refused says why, and stays to be pasted again.
        if (fresh.asks) throw new Error(fresh.detail ?? "That value didn't work.");
        if (fresh.state === "ok") return (w?.close(), onClose());
        // Its scopes are on offer only once it knows its address: the picker comes now, and Connect again.
        if (fresh.scopes && !on) {
          w?.close();
          setView(fresh);
          setOn(new Set((fresh.scopes.granted ?? fresh.scopes.recommended).filter((s) => fresh.scopes!.supported.includes(s))));
          setBusy("");
          return;
        }
      }
      const path = `${view.connect}${on ? `?${picked()}` : ""}`;
      if (!view.redirect) return (go(w, path), onClose());
      if (w) w.location.href = abs(path);
      setLink(w ? null : abs(path));
      setPhase("paste");
      setBusy("");
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
        phase === "paste" ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!view || Boolean(busy) || !pasted.trim()} onClick={() => void finish()}>
              {busy || "Finish"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!view || Boolean(busy) || (on !== null && !on.size)} onClick={() => void connect()}>
              {busy || (error ? "Try again" : "Connect")}
            </Button>
          </>
        )
      }
    >
      {problem && <Banner tone="danger">{problem}</Banner>}
      {phase === "paste" && view?.redirect && (
        <>
          <ol className="connect-steps">
            <li>
              Sign in to {label} in {link ? <a href={link} target="_blank" rel="noopener noreferrer">its sign-in page</a> : "the tab that opened"} and allow access.
            </li>
            <li>After you approve, your browser shows a page that can't load. Copy its full address and paste it here.</li>
          </ol>
          <label className="ui-field">
            <span className="ui-field-label">Address of that page</span>
            <input
              className="ui-input"
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              placeholder={`${view.redirect}?code=…`}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void finish()}
            />
            <span className="ui-field-help">It starts with {view.redirect} and holds a one-time code for this sign-in.</span>
          </label>
          {view.oneClick && (
            <p className="connect-alt">
              <Button size="sm" variant="quiet" onClick={oneClick}>Use one-click sign-in</Button> (needs your admin to allow {view.oneClick})
            </p>
          )}
        </>
      )}
      {phase === "ask" && fields.map((f) => {
        const wrong = touched && bad.includes(f);
        return (
          <label key={f.secret} className="ui-field">
            <span className="ui-field-label">{f.label}</span>
            <input
              className="ui-input"
              type={f.pattern.startsWith("^https") ? "url" : "text"}
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
      {phase === "ask" && view?.scopes && on && <Picker offer={view.scopes} on={on} setOn={setOn} />}
      {phase === "ask" && view && !fields.length && !view.scopes && !problem && <p>{label} opens in a new tab. Sign in there and allow access.</p>}
    </Dialog>
  );
}

/** What agents may do as the owner in the vendor: its scopes grouped by product, what is granted now (else the recommended ones) on. */
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
