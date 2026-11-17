// Board accounts: the Accounts page (people and your own signed-in browsers), and the pointer to the kernel's sign-in pages.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SignInRequired, accountsApi, api, type Account, type AppAdmins, type AuthSession, type Session } from "./api";
import { SkeletonLines } from "./Skeleton";
import { agoLabel } from "./util";

function Screen({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <img src="/icon.png" alt="" />
      <h1>{title}</h1>
      {sub && <p className="muted">{sub}</p>}
      {children}
    </div>
  );
}

/** A form that shows its own busy state and error. */
function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

/**
 * Signing in, enrolling an authenticator and claiming a link happen on the kernel's admin pages; /auth/start then has the
 * kernel hand this board its own session (and sends the browser to sign in there first when it isn't).
 */
export function SignInScreen() {
  return (
    <Screen title="Sign in" sub="Admins sign in on the AidenHQ sign-in page, then come back here.">
      <a className="btn primary" href="/auth/start">
        Sign in
      </a>
    </Screen>
  );
}

const browserOf = (ua: string | null) => {
  if (!ua) return "A browser";
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac OS|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
};

function statusOf(a: Account): { label: string; pill: string } {
  if (a.disabled) return { label: "Disabled", pill: "" };
  if (a.lockedUntil) return { label: `Sign-ins paused until ${new Date(a.lockedUntil).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`, pill: "pill-needs" };
  if (a.role === "admin" && !a.twoFactorEnabled) return { label: "No authenticator yet", pill: "" };
  return { label: "Active", pill: "pill-working" };
}

/** People with accounts (admins: the board; users: shared apps only), and this account's signed-in browsers. */
export function AccountsView({ session, onSignIn }: { session: Session; onSignIn: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [error, setError] = useState("");
  const [link, setLink] = useState<{ email: string; url: string | null } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [appAdmins, setAppAdmins] = useState<AppAdmins[]>([]);
  const [adminEmail, setAdminEmail] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [a, s, apps] = await Promise.all([accountsApi.list(), accountsApi.sessions(), accountsApi.appAdmins()]);
      setAccounts(a.accounts);
      setAppAdmins(apps.apps);
      setSessions(s.sessions);
      setError("");
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      else setError((e as Error).message);
    }
  }, [onSignIn]);
  useEffect(() => void load(), [load]);

  const act = (run: () => Promise<unknown>) => () => void run().then(load, (e: Error) => setError(e.message));
  const invite = useSubmit(async () => {
    const r = await accountsApi.invite(email, name, role);
    setLink({ email: r.account.email, url: r.url });
    setEmail("");
    setName("");
    await load();
  });
  const newLink = (a: Account) => act(async () => setLink({ email: a.email, url: (await accountsApi.newLink(a.id)).url }));
  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <main className="page wide">
      <header className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="page-sub">
            Signed in as {session.account?.email}
            {session.account?.owner ? " (owner)" : ""}.{" "}
            <a className="link-btn" href={`${session.adminUrl ?? ""}/auth/password`}>
              Password
            </a>{" "}
            <button className="link-btn" onClick={() => void api.signOut().then(() => location.reload())}>
              Sign out of the board
            </button>
          </p>
        </div>
      </header>
      {error && <div className="offline">{error}</div>}

      <section className="accounts-section">
        <h2>Add someone</h2>
        <p className="muted small">Admins sign in to this board (with an authenticator). Users only open the shared apps they aren't blocked from (each app's admins set roles on its Access page, linked from My apps). You get a one-time link (72 hours) to pass on yourself; nothing is emailed.</p>
        <form className="invite-form" onSubmit={(e) => void invite.submit(e)}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <div className="seg" role="radiogroup" aria-label="Role">
            {(["user", "admin"] as const).map((r) => (
              <button key={r} type="button" role="radio" aria-checked={role === r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
                {r === "admin" ? "Admin" : "User"}
              </button>
            ))}
          </div>
          <button className="btn primary" disabled={invite.busy}>
            {invite.busy ? "Adding…" : "Add"}
          </button>
        </form>
        {invite.error && <p className="auth-error">{invite.error}</p>}
        {link && (
          <div className="alert ok link-box">
            {link.url ? (
              <>
                <span>
                  Link for <b>{link.email}</b> (works once, for 72 hours; any older link stops working):
                </span>
                <code>{link.url}</code>
                <button className="btn" onClick={() => copy(link.url!)}>
                  Copy
                </button>
              </>
            ) : (
              <span>
                <b>{link.email}</b> signs in to shared apps through your Cloudflare Access login: no link needed.
              </span>
            )}
          </div>
        )}
      </section>

      <section className="accounts-section">
        <h2>People</h2>
        {!accounts ? (
          !error && <SkeletonLines lines={4} />
        ) : (
          <div className="account-list">
            {accounts.map((a) => {
              const st = statusOf(a);
              return (
                <article key={a.id} className={`account-row${a.disabled ? " off" : ""}`}>
                  <div className="account-who">
                    <b>{a.name || a.email}</b>
                    <span className="muted small">{a.email}</span>
                  </div>
                  <span className="pill">{a.owner ? "Owner" : a.role === "admin" ? "Admin" : "User"}</span>
                  <span className={`pill ${st.pill}`}>{st.label}</span>
                  <span className="spacer" />
                  {!a.owner && (
                    <div className="account-actions">
                      <button className="btn" onClick={act(() => accountsApi.setRole(a.id, a.role === "admin" ? "user" : "admin"))}>
                        {a.role === "admin" ? "Make user" : "Make admin"}
                      </button>
                      <button className="btn" onClick={newLink(a)} title="A new one-time link; older links stop working">
                        New link
                      </button>
                      <button className="btn" onClick={act(() => accountsApi.setDisabled(a.id, !(a.disabled)))}>
                        {a.disabled ? "Enable" : "Disable"}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {appAdmins.length > 0 && (
        <section className="accounts-section">
          <h2>App admins</h2>
          <p className="muted small">Each shared app's admins set who may open it (roles and its default) on its Access page, and can name other admins of that app. Admins here are admins of every app.</p>
          <div className="account-list">
            {appAdmins.map((a) => (
              <article key={a.app} className="account-row">
                <div className="account-who">
                  <b>{a.app}</b>
                  <span className="muted small">
                    default {a.default} ·{" "}
                    <a href={`https://${a.host}/.aidenhq/access`} target="_blank" rel="noreferrer">
                      Access page
                    </a>
                  </span>
                </div>
                {a.admins.map((e) => (
                  <span key={e} className="pill">
                    {e}{" "}
                    <button className="link-btn" title="Remove as admin" onClick={act(() => accountsApi.setAppAdmin(a.app, e, false))}>
                      ×
                    </button>
                  </span>
                ))}
                <span className="spacer" />
                <form
                  className="invite-form"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    act(() => accountsApi.setAppAdmin(a.app, adminEmail[a.app] ?? "", true).then(() => setAdminEmail({ ...adminEmail, [a.app]: "" })))();
                  }}
                >
                  <input type="email" placeholder="Admin's email" value={adminEmail[a.app] ?? ""} onChange={(ev) => setAdminEmail({ ...adminEmail, [a.app]: ev.target.value })} required aria-label={`New admin of ${a.app}`} />
                  <button className="btn">Add admin</button>
                </form>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="accounts-section">
        <h2>Your signed-in browsers</h2>
        {sessions.map((s) => (
          <div key={s.id} className="device">
            <span>{browserOf(s.userAgent)}</span>
            <span className="muted small">{s.current ? "this browser" : `active ${agoLabel(s.updatedAt)}`}</span>
            <span className="spacer" />
            {!s.current && (
              <button className="btn" onClick={act(() => accountsApi.revokeSession(s.id))}>
                Sign out
              </button>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}
