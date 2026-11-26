// The one way a teammate is set up (onboarding, hiring, Home's Next up): its module turned on through the module change
// (apply tracked), each setup flow it still needs inline, its routines resumed, its trial run once, then its name. Every
// stage is read back from the server (the module list, the filed changes, the setup flows, the trial), so a reload or a
// Retry picks up where it was and never files or starts anything twice.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { HttpStatusError, SignInRequired, api, type SetupFlowView } from "./api";
import { SetupFlow } from "./SetupFlow";
import { ChangeProgress, IN_FLIGHT } from "./settings-ui";
import { Bone } from "./Skeleton";
import type { FiledChange, HireRow, ModuleRow, TrialView } from "./types";
import { Button, Face, Field, Input, Monogram, faceProps } from "./ui";
import { teammateNameProblem } from "../../src/teammate-name";
import "./onboarding.css";

/** A module name as a title, until its setup flow (which names it) is readable. */
export const moduleTitle = (m: string, flows?: SetupFlowView[] | null) => flows?.find((f) => f.module === m)?.title ?? m.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => `${d ? " " : ""}${c.toUpperCase()}`);

/** A teammate's face; a third-party listing without a kit face gets a monogram (its features would hash from a stranger's key). */
export function RowFace({ row, size }: { row: Pick<HireRow, "key" | "name" | "job" | "face" | "browse">; size: number }) {
  if (row.browse && !row.face) return <Monogram name={row.job} size={size} />;
  return <Face seed={row.key} {...faceProps(row.face)} size={size} label={row.name} />;
}

/** A teammate's sample result in quotes, unless it brings its own. */
export const quoted = (s: string) => (/^[“"]/.test(s) ? s : `“${s}”`);

/** The name the owner typed for a teammate before its module was on (a rename waits for the apply): this tab only. */
const NAME_KEY = (ref: string) => `aidenhq.teammate-name.${ref}`;
export function pendingName(ref: string): string | null {
  try {
    return sessionStorage.getItem(NAME_KEY(ref));
  } catch {
    return null;
  }
}
export function holdName(ref: string, name: string | null) {
  try {
    if (name) sessionStorage.setItem(NAME_KEY(ref), name);
    else sessionStorage.removeItem(NAME_KEY(ref));
  } catch {
    /* no storage: the name is filed from this page's state */
  }
}

/** Changes this tab filed, by module id: StrictMode's double effect and a quick remount never file one twice. */
const filedHere = new Set<string>();
const RECENT_MS = 15 * 60_000;

type Stage = "enable" | "connect" | "start" | "name" | "done";

export function TeammateSetup({ row, name, nameStep, onDone, onSignIn }: { row: HireRow; name?: string; nameStep?: boolean; onDone: (r: { trial: TrialView }) => void; onSignIn: () => void }) {
  const [mod, setMod] = useState<ModuleRow | null | undefined>(undefined);
  const [filed, setFiled] = useState<FiledChange | undefined>();
  const [flows, setFlows] = useState<SetupFlowView[] | null>(null);
  const [trial, setTrial] = useState<TrialView | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  // A Retry of the module change: only changes filed since count, so the failed one no longer stops it.
  const [since, setSince] = useState("");
  const fail = useCallback((e: unknown) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)), [onSignIn]);

  // The module and its newest change, until the module reads as on.
  const applied = row.onTeam || (!!mod && mod.state !== "off" && !mod.browse);
  const readModule = useCallback(
    () =>
      Promise.all([api.modules(), api.settingsChanges()]).then(([m, c]) => {
        setMod(m.modules.find((x) => x.id === row.id) ?? null);
        // Under way or just finished (as useFiled reads it): an old applied change from before a later turn-off says nothing.
        setFiled(c.changes.find((f) => f.createdAt >= since && (IN_FLIGHT.includes(f.stage) || Date.now() - Date.parse(f.createdAt) < RECENT_MS) && f.items.some((i) => i.kind === "module" && i.name === row.id && i.on)));
      }, fail),
    [row.id, since, fail],
  );
  useEffect(() => {
    if (applied) return;
    void readModule();
    const t = setInterval(() => document.visibilityState === "visible" && void readModule(), 4000);
    return () => clearInterval(t);
  }, [applied, readModule]);

  // Enable: file the module change once the reads say none is under way (its requirements come on with it).
  const stopped = filed && (filed.stage === "failed" || filed.stage === "rejected" || filed.stage === "closed");
  const waiting = filed && (IN_FLIGHT.includes(filed.stage) || filed.stage === "applied");
  useEffect(() => {
    if (applied || mod === undefined || waiting || stopped || filedHere.has(`${row.id}:${retry}`)) return;
    filedHere.add(`${row.id}:${retry}`);
    api.changeSettings([{ kind: "module", name: row.id, on: true }]).then(
      () => void readModule(),
      // Already on (filed elsewhere meanwhile): the next read shows it.
      (e) => (e instanceof HttpStatusError && /already/i.test(e.message) ? void readModule() : fail(e)),
    );
  }, [applied, mod, waiting, stopped, row.id, retry, readModule, fail]);

  // Once on: the setup flows its modules still need. One the owner skipped (dismissed) is left for later.
  const readFlows = useCallback(() => api.setupFlows().then((r) => setFlows(r.flows), fail), [fail]);
  useEffect(() => void (applied && readFlows()), [applied, readFlows]);
  // Which flows it needs, read again once its module is on: a module that was off publishes no flow, so the row listed none.
  const [conns, setConns] = useState<string[] | null>(row.onTeam ? row.connections : null);
  useEffect(() => {
    if (!applied || conns) return;
    const read = () => api.teammates().then((t) => setConns(t.rows.find((r) => r.ref === row.ref)?.connections ?? row.connections), fail);
    void read();
    // A failed read is tried again, so the setup goes on by itself once the board answers.
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 5000);
    return () => clearInterval(t);
  }, [applied, conns, row.ref, row.connections, fail]);
  const connections = conns ?? row.connections;
  const needed = (flows ?? []).filter((f) => connections.includes(f.module) && !f.done);
  const pending = needed.filter((f) => !f.dismissed);
  const skipped = needed.filter((f) => f.dismissed);

  // A rename typed before the module was on: filed once it is (the name rule needs the compiled agent).
  const renamed = useRef(false);
  useEffect(() => {
    const want = name ?? pendingName(row.ref);
    if (!applied || renamed.current || !want || want === row.name) return;
    renamed.current = true;
    void api.changeSettings([{ kind: "agent", agent: row.key, field: "name", value: want }]).then(() => holdName(row.ref, null), fail);
  }, [applied, name, row.ref, row.key, row.name, fail]);

  // Its routines resumed and its trial run, once its flows are done or skipped. A skipped connection means no trial.
  const ready = applied && conns !== null && flows !== null && pending.length === 0;
  const withTrial = skipped.length === 0;
  const [started, setStarted] = useState(false);
  // The server's start is idempotent (it resumes, and runs a trial once unless it failed), so a remount simply asks again.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    api.teammateStart(row.ref, { trial: withTrial }).then(() => !stop && setStarted(true), fail);
    return () => void (stop = true);
  }, [ready, row.ref, withTrial, retry, fail]);
  useEffect(() => {
    if (!started) return;
    let stop = false;
    const look = () => api.teammateTrial(row.ref).then((t) => !stop && setTrial(t), fail);
    void look();
    const t = setInterval(() => document.visibilityState === "visible" && void look(), 5000);
    return () => ((stop = true), clearInterval(t));
  }, [started, row.ref, fail]);
  const settled = !withTrial ? started : !!trial && trial.state !== "running";
  // A failed trial waits for Retry, or for the owner to go on without it.
  const [without, setWithout] = useState(false);
  const through = settled && (trial?.state !== "failed" || without);

  const [naming, setNaming] = useState(false);
  const stage: Stage = !applied ? "enable" : conns === null || flows === null || pending.length ? "connect" : !through ? "start" : nameStep && !naming ? "name" : "done";
  const reported = useRef(false);
  useEffect(() => {
    if (stage !== "done" || reported.current) return;
    reported.current = true;
    onDone({ trial: trial ?? { state: "none", found: [] } });
  }, [stage, trial, onDone]);

  const again = () => (setError(""), setTrial(null), setStarted(false), setRetry((n) => n + 1));
  const n = row.name;
  const titles = (fs: SetupFlowView[]) => fs.map((f) => f.title).join(" and ");
  return (
    <div className="tms" aria-live="polite">
      <Line n={1} state={applied ? "done" : stopped ? "failed" : "now"} title={applied ? `${n} is on your team` : `Turning on ${n}`} meta={row.requires.length ? `with ${row.requires.join(", ")}` : undefined}>
        {!applied && (
          <>
            {filed ? <ChangeProgress f={filed} /> : <p className="tms-hint">Filing the change…</p>}
            {stopped && (
              <div className="tms-actions">
                <Button variant="primary" className="press" onClick={() => (setSince(new Date().toISOString()), setFiled(undefined), again())}>Retry</Button>
              </div>
            )}
          </>
        )}
      </Line>
      {connections.map((m, i) => {
        const full = flows?.find((x) => x.module === m);
        const current = applied && pending[0]?.module === m;
        // Once on, a module with no flow has nothing to set up.
        const state = !full ? (applied && flows ? "done" : "wait") : full.done ? "done" : full.dismissed ? "skipped" : current ? "now" : "wait";
        return (
          <Line key={m} n={i + 2} state={state} title={`Connect ${moduleTitle(m, flows)}`} meta={state === "skipped" ? "Skipped" : state === "done" ? "Connected" : "Read-only until you say otherwise"}>
            {current && <SetupFlow inline module={m} onDone={() => void readFlows()} onSignIn={onSignIn} />}
          </Line>
        );
      })}
      <Line n={connections.length + 2} state={settled ? (trial?.state === "failed" ? "failed" : "done") : stage === "start" ? "now" : "wait"} title={withTrial ? `${n}'s first look at your data` : `${n} starts`}>
        {stage === "start" && withTrial && (
          <div className="tms-trial" role="status">
            <p className="tms-hint">{n} is reading the last week. The first result shows here in about a minute.</p>
            {[0, 1, 2].map((i) => <Bone key={i} h={14} w={`${88 - i * 14}%`} />)}
          </div>
        )}
        {settled && !withTrial && (
          <p className="tms-hint">
            {n} is on. Connect {titles(skipped)} and {n} starts on its next run.{" "}
            {skipped.map((f) => <a key={f.module} className="tms-link" href={`#/setup/${f.module}`}>Connect {f.title}</a>)}
          </p>
        )}
        {settled && trial?.state === "failed" && (
          <>
            <p className="tms-hint">{n}'s first run didn't finish. <a className="tms-link" href={`#/team/${row.key}`}>Open {n}'s page</a></p>
            <div className="tms-actions">
              <Button variant="primary" className="press" onClick={again}>Retry</Button>
              {!without && <Button variant="quiet" className="press" onClick={() => setWithout(true)}>Go on without it</Button>}
            </div>
          </>
        )}
      </Line>
      {nameStep && (
        <Line n={connections.length + 3} state={stage === "done" ? "done" : stage === "name" ? "now" : "wait"} title="Name your teammate">
          {stage === "name" && <NameStep row={row} onSaved={() => setNaming(true)} onSignIn={onSignIn} />}
        </Line>
      )}
      {error && <p className="tms-error" role="alert">{error}</p>}
    </div>
  );
}

/** One stage: its mark (number, check, a pulse while it runs), its title and a note, and its body while it is the current one. */
function Line({ n, state, title, meta, children }: { n: number; state: "now" | "done" | "wait" | "failed" | "skipped"; title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <section className={`tms-line ${state}`} style={{ "--i": n } as CSSProperties}>
      <span className="tms-mark" aria-hidden>
        {state === "done" ? (
          <svg width="12" height="12" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : state === "failed" ? "!" : n}
      </span>
      <div className="tms-body">
        <h3 className="tms-title">
          {title}
          {meta && <span className="tms-meta">{meta}</span>}
        </h3>
        {children}
      </div>
    </section>
  );
}

/** The name step: the default prefilled, checked as it is typed with the rule the board and kernel enforce; filed only when changed. */
function NameStep({ row, onSaved, onSignIn }: { row: HireRow; onSaved: () => void; onSignIn: () => void }) {
  const [name, setName] = useState(() => pendingName(row.ref) ?? row.name);
  const [others, setOthers] = useState<Record<string, { name: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void api.roster().then((r) => setOthers(Object.fromEntries(r.roster.filter((a) => a.key).map((a) => [a.key!, { name: a.name }]))), () => {}), []);
  const problem = name === row.name ? undefined : teammateNameProblem(name, row.key, others);
  const save = async () => {
    if (name === row.name) return onSaved();
    setBusy(true);
    setError("");
    try {
      await api.changeSettings([{ kind: "agent", agent: row.key, field: "name", value: name }]);
      holdName(row.ref, null);
      onSaved();
    } catch (e) {
      if (e instanceof SignInRequired) onSignIn();
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="tms-name" onSubmit={(e) => (e.preventDefault(), !problem && void save())}>
      <Field label="Name" error={problem || error || null} help={`${row.job} · you can rename them any time.`}>
        {(id, note) => <Input id={id} aria-describedby={note} value={name} maxLength={24} aria-invalid={!!problem || !!error} onChange={(e) => (setName(e.target.value), holdName(row.ref, e.target.value))} />}
      </Field>
      <Button type="submit" variant="primary" className="press" disabled={busy || !!problem}>{busy ? "Saving…" : name === row.name ? `Keep ${row.name}` : `Name them ${name}`}</Button>
    </form>
  );
}
