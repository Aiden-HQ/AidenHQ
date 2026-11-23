// A setup flow with two options (a basic flow and its `mode: advanced` one, e.g. Slack: read as you, or that plus the bot):
// both side by side in plain words, then only the chosen option's steps. The vendor app is made or updated from a pasted
// short-lived token (the flow's `app`); an option can be added to later, and an app that predates today's manifest is
// offered its update. Nothing here knows which module it is.
import { useState, type ReactNode } from "react";
import { api, type SetupAppView, type SetupFlowView } from "./api";
import { ConnectButton } from "./Connect";
import { Effort, Pairing, SecretFields, Step, Steps } from "./SetupFlow";
import { Button } from "./ui";

type Path = "basic" | "advanced";
type Board = { url: string };
type Stage = { key: string; title: string; state: "open" | "done" | "wait"; body: ReactNode };

const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Dash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
    <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export function SetupPaths({ flow, board, org, reload, fail, restartFor, onSaved }: { flow: SetupFlowView; board: Board; org: string | null; reload: () => Promise<void>; fail: (e: unknown) => void; restartFor?: number; onSaved: (ms: number) => void }) {
  const a = flow.advanced!;
  const app = flow.app;
  const status = app?.status ?? null;
  const fields = flow.fields ?? [];
  const advFields = a.fields ?? [];
  // The organisation's app is the sign-in: its client is never the person's to make.
  const orgSigns = org !== null && fields.length > 0 && fields.every((f) => app?.org_secrets.includes(f.secret));
  const clientReady = orgSigns || fields.every((f) => flow.present[f.secret]);
  const botSaved = advFields.length > 0 && advFields.every((f) => flow.present[f.secret]);
  const botStarted = botSaved || advFields.some((f) => flow.present[f.secret]) || status?.part === "advanced";
  // An app updated here takes its new events only once reinstalled in Slack: the install step stays open until the owner says so
  // (remembered in this browser across reloads; a convenience, so a browser without storage just forgets it).
  const key = `setup-reinstall:${flow.module}`;
  const [reinstall, setReinstall] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const markReinstall = (on: boolean) => {
    setReinstall(on);
    try {
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {
      /* no storage: this page only */
    }
  };
  const [path, setPath] = useState<Path | null>(a.done || botStarted ? "advanced" : flow.done || clientReady ? "basic" : null);
  const appUrl = status?.url ?? app?.console_url ?? "";
  // {app_url}/<page> is that page of the app made here; for an app made elsewhere (id unknown), the vendor's list of apps.
  const fill = (text: string) => text.split("{board_url}").join(board.url).split("{redirect_url}").join(flow.redirect_url ?? "").replace(/\{app_url\}(\/[\w-]+)?/g, (_, page: string | undefined) => (status?.url ? `${status.url}${page ?? ""}` : appUrl));

  const connect: Stage = {
    key: "connect",
    title: "Connect",
    state: flow.signedIn ? "done" : clientReady ? "open" : "wait",
    body: (
      <>
      {flow.signedIn ? (
        <div className="setup-actions setup-paired">
          <p className="setup-ok-line">Connected{org && orgSigns ? ` with ${org}'s app` : ""}.</p>
          {flow.signin && <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "ok", offer: flow.scopes, mode: flow.signin_mode } }} />}
        </div>
      ) : clientReady && flow.signin ? (
        <ConnectButton c={{ id: flow.signin, label: flow.title, signIn: { state: "missing", offer: flow.scopes, mode: flow.signin_mode } }} variant="primary" />
      ) : (
        <p className="setup-hint">Make the app first; then connect here and allow access.</p>
      )}
      <details className="paths-more">
        <summary>What you grant</summary>
        <Steps text={fill(flow.steps)} />
      </details>
      </>
    ),
  };

  const basicSteps: Stage[] = [
    { key: "app", title: orgSigns ? `${org}'s app` : "Your Slack app", state: clientReady ? "done" : "open", body: orgSigns ? (
        <p className="setup-hint">{org} runs the sign-in app for you, so there is nothing to make. Connect with your {org} account.</p>
      ) : clientReady ? (
        <p className="setup-hint">Your app is ready{status?.app_id ? <> (<a href={status.url ?? appUrl} target="_blank" rel="noreferrer">open it in Slack ↗</a>)</> : null}.</p>
      ) : app ? (
        <MakeApp module={flow.module} app={app} part="basic" action="Make my app" reload={reload} fail={fail} onSaved={onSaved} />
      ) : (
        <SecretFields module={flow.module} fields={fields} present={flow.present} done={clientReady} reload={reload} fail={fail} onSaved={onSaved} />
      ) },
    connect,
  ];

  // The bot's app: made here, or one made before that predates today's manifest (its update), or the sign-in app made here
  // (the bot is added to it), or a new one beside the organisation's sign-in.
  const upToDate = status?.part === "advanced" && status.current;
  const update = botSaved && !upToDate;
  const addTo = !orgSigns && status?.part === "basic" && status.app_id ? status.app_id : undefined;
  // A sign-in app made elsewhere (its client saved, its id unknown here): the bot is added to it by its App ID, so the sign-in stays.
  const ownUnknown = !orgSigns && !addTo && clientReady;
  const botApp: Stage = {
    key: "bot",
    title: update ? "Update your bot app" : orgSigns ? "Your bot app" : "Your Slack app",
    state: update ? "open" : botStarted ? "done" : "open",
    body: update ? (
        <>
          <p className="setup-hint">An app made before this page lacks events Slack triage needs (📌 tasks). Update it to today's manifest, then reinstall it from the next step. Your tokens stay.</p>
          {app && <MakeApp module={flow.module} app={app} part="advanced" action="Update my app" askAppId={status?.part === "advanced" ? status.app_id ?? undefined : ""} reload={reload} fail={fail} onSaved={onSaved} onDone={() => markReinstall(true)} />}
        </>
      ) : botStarted ? (
        <p className="setup-ok-line">{upToDate || status?.part === "advanced" ? "Your app is made" : "Your app is set up"}.</p>
      ) : app ? (
        <>
          <p className="setup-hint">
            {orgSigns
              ? `Your own app, for the bot; ${org}'s app stays your sign-in. A bot is never shared.`
              : addTo || ownUnknown
                ? "The bot is added to the app you sign in with."
                : "One app for both: the sign-in and the bot."}
          </p>
          <MakeApp module={flow.module} app={app} part="advanced" action={orgSigns ? "Make my bot app" : addTo || ownUnknown ? "Add the bot" : "Make my app"} appId={addTo} {...(ownUnknown ? { askAppId: "" } : {})} reload={reload} fail={fail} onSaved={onSaved} />
        </>
      ) : null,
  };
  const advancedSteps: Stage[] = [
    botApp,
    {
      key: "install",
      title: "Install it and copy two tokens",
      state: botSaved && !update && !reinstall ? "done" : botStarted ? "open" : "wait",
      body: (
        <>
          {reinstall && (
            <div className="setup-actions setup-paired">
              <p className="setup-hint">Updated. Reinstall it in Slack (the Install page below), then come back.</p>
              <Button size="sm" onClick={() => markReinstall(false)}>I reinstalled it</Button>
            </div>
          )}
          <Steps text={fill(a.steps)} />
          <SecretFields module={flow.module} fields={advFields} present={flow.present} done={botSaved} reload={reload} fail={fail} onSaved={onSaved} />
        </>
      ),
    },
    connect,
    ...(a.pair_url
      ? [
          {
            key: "pair",
            title: "Pair your DM",
            state: flow.paired ? "done" : botSaved ? "open" : "wait",
            body: botSaved ? <Pairing flow={flow} reload={reload} fail={fail} restartFor={restartFor} /> : <p className="setup-hint">Save the tokens first. Then DM the bot a code, so it knows your Slack account and your DM is your chat with Aiden.</p>,
          } satisfies Stage,
        ]
      : []),
  ];
  const steps = path === "basic" ? basicSteps : path === "advanced" ? advancedSteps : [];

  return (
    <>
      <div className="paths" role="radiogroup" aria-label={`How to set up ${flow.title}`}>
        <PathCard
          id="basic"
          picked={path}
          onPick={setPath}
          title={flow.label ?? flow.title}
          why={flow.why}
          gives={flow.capabilities ?? []}
          lacks={a.capabilities}
          effort={orgSigns ? "about a minute" : flow.effort}
          admin={orgSigns ? undefined : flow.admin}
          state={flow.done && !botStarted ? "Set up" : undefined}
        />
        <PathCard id="advanced" picked={path} onPick={setPath} title={a.title} why={a.why} gives={a.capabilities} effort={a.effort} admin={a.admin} state={a.done ? (update ? "Update available" : "Set up") : flow.done && !botStarted ? "Add it any time" : undefined} />
      </div>
      {path === null ? (
        <p className="setup-hint paths-pick">Pick one to see its steps. You can start with the first and add the bot later.</p>
      ) : (
        <div className="paths-steps">
          {steps.map((s, i) => (
            <Step key={s.key} n={i + 1} title={s.title} state={s.state}>
              {s.body}
            </Step>
          ))}
        </div>
      )}
    </>
  );
}

/** One option: what it gives (and, for the first, what only the second adds), how long it takes, who may need to approve. */
function PathCard({ id, picked, onPick, title, why, gives, lacks, effort, admin, state }: { id: Path; picked: Path | null; onPick: (p: Path) => void; title: string; why: string; gives: string[]; lacks?: string[]; effort: string; admin?: string; state?: string }) {
  const on = picked === id;
  return (
    <button type="button" role="radio" aria-checked={on} className={`path path-${id}${on ? " on" : ""}`} onClick={() => onPick(id)}>
      <span className="path-head">
        <span className="path-radio" aria-hidden />
        <strong>{title}</strong>
        {state && <em className="path-state">{state}</em>}
      </span>
      <span className="path-why">{why}</span>
      <span className="path-list">
        {gives.map((g) => (
          <span key={g} className="path-give">
            <Check />
            <span>{g}</span>
          </span>
        ))}
        {lacks?.map((g) => (
          <span key={g} className="path-lack">
            <Dash />
            <span>
              {g} <small>needs the bot</small>
            </span>
          </span>
        ))}
      </span>
      <span className="path-foot">
        <Effort effort={effort} admin={admin} />
      </span>
    </button>
  );
}

/**
 * The token paste that makes (or updates) the app: the token goes to the module once and is never kept, here or there.
 * `appId` updates that app; `askAppId` asks which app to update (prefilled when known).
 */
function MakeApp({ module, app, part, action, appId, askAppId, reload, fail, onSaved, onDone }: { module: string; app: SetupAppView; part: Path; action: string; appId?: string; askAppId?: string; reload: () => Promise<void>; fail: (e: unknown) => void; onSaved: (ms: number) => void; onDone?: () => void }) {
  const [token, setToken] = useState("");
  const [id, setId] = useState(askAppId ?? "");
  const [busy, setBusy] = useState(false);
  const ok = (() => {
    try {
      return new RegExp(app.pattern).test(token.trim());
    } catch {
      return true;
    }
  })();
  const idOk = askAppId === undefined || /^A[A-Z0-9]{6,20}$/.test(id.trim());
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.setupApp(module, token.trim(), part, askAppId !== undefined ? id.trim() : appId);
      setToken("");
      if (r.saved.length) onSaved(60_000);
      onDone?.();
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="paths-make">
      <Steps text={app.help} />
      <label className="setup-field">
        <span>{app.label}</span>
        <input type="password" autoComplete="off" spellCheck={false} placeholder="xoxe.xoxp-…" aria-invalid={Boolean(token.trim()) && !ok} value={token} onChange={(e) => setToken(e.target.value)} />
        {token.trim() && !ok && <small className="setup-bad">That doesn't look like an {app.label}.</small>}
      </label>
      {askAppId !== undefined && (
        <label className="setup-field">
          <span>App ID</span>
          <input type="text" autoComplete="off" spellCheck={false} placeholder="A0…" aria-invalid={Boolean(id.trim()) && !idOk} value={id} onChange={(e) => setId(e.target.value)} />
          <small className="setup-help">At the top of your app's Basic Information page in Slack.</small>
        </label>
      )}
      <div className="setup-actions">
        <Button variant="primary" disabled={busy || !ok || !idOk} onClick={() => void go()}>
          {busy ? "Working…" : action}
        </Button>
      </div>
    </div>
  );
}
