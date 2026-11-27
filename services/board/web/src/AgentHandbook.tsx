// An agent's Handbook tab (#/team/agents/<key>/handbook): Your rules, the main handbook (read-only until the owner opts into
// their own copy), what the agent really reads, its memory (read-only: the agent keeps it), and the history. Reads: services/board/src/agent-handbook.ts; every edit
// is a typed change (rules, handbook, unfork) that goes through the usual review and apply flow.
import { useCallback, useEffect, useRef, useState } from "react";
import { SignInRequired, api } from "./api";
import { ChangeProgress, ChangesScope, useChanges, useFiled } from "./settings-ui";
import { SkeletonLines } from "./Skeleton";
import type { SettingChange } from "./types";
import { ago } from "./util";
import { Segmented } from "./ui";

export interface HandbookData {
  kind: "module" | "local";
  main: { text: string; source: "module" | "fork" | "local"; module?: string; revision?: string };
  rules: string | null;
  compiled: string | null;
  fork: { base: string; moduleMovedOn: boolean; moduleText?: string } | null;
}
export interface HandbookHistory {
  rows: { sha: string; at: string; subject: string; files: string[]; source: "instance" | "module"; kind?: "rules" | "handbook"; after?: string | null; before?: string | null }[];
  note?: string;
}
/** An agent's memory (GET /api/agents/by-key/:key/memory): each fact with its date and source. */
export interface MemoryData { facts: { date: string; src: string; fact: string }[]; updated: string | null }
type HandbookChange = Extract<SettingChange, { kind: "rules" | "handbook" | "unfork" }>;
const kindOf = (c: SettingChange) => c.kind;
const agentOf = (c: SettingChange) => ("agent" in c ? c.agent : undefined);

/** A line diff (longest common subsequence), good enough for handbooks of a few hundred lines. */
export function lineDiff(a: string, b: string): { t: " " | "+" | "-"; s: string }[] {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { t: " " | "+" | "-"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ t: " ", s: x[i]! }), i++, j++);
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ t: "-", s: x[i++]! });
    else out.push({ t: "+", s: y[j++]! });
  }
  while (i < n) out.push({ t: "-", s: x[i++]! });
  while (j < m) out.push({ t: "+", s: y[j++]! });
  return out;
}

function Diff({ from, to }: { from: string; to: string }) {
  const lines = lineDiff(from, to).filter((l, i, all) => l.t !== " " || all.slice(Math.max(0, i - 2), i + 3).some((x) => x.t !== " "));
  return (
    <pre className="hb-diff">
      {lines.length ? lines.map((l, i) => <span key={i} className={l.t === "+" ? "add" : l.t === "-" ? "del" : undefined}>{l.t} {l.s}{"\n"}</span>) : "No difference."}
    </pre>
  );
}

/** The exact text change, as a diff, before it is filed. */
function Preview({ change, was, onDone, onCancel, note }: { change: HandbookChange; was: string; onDone: () => void; onCancel: () => void; note?: string }) {
  const { file, toast } = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const task = await file([change]);
      toast(`Change filed (${task}). You'll see it here as it moves.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-preview">
      <div className="st-preview-file">{change.kind === "rules" ? "Your rules" : change.kind === "handbook" ? "Your copy of the main handbook" : "Back to the module's handbook"}</div>
      <Diff from={was} to={"text" in change ? change.text : (note ?? "")} />
      <p className="st-preview-note">The change is reviewed before it goes live; nothing changes before that.</p>
      {error && <p className="st-error" role="alert">{error}</p>}
      <div className="st-preview-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={() => void go()} disabled={busy}>{busy ? "Filing…" : "File change"}</button>
      </div>
    </div>
  );
}

function Dialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && open && !d.open) d.showModal();
    if (d && !open && d.open) d.close();
  }, [open]);
  return <dialog ref={ref} className="hb-dialog" onClose={onClose}>{open && children}</dialog>;
}

function Edit({ agentKey, data }: { agentKey: string; data: HandbookData }) {
  const local = data.kind === "local";
  const savedRules = data.rules ?? "";
  const [rules, setRules] = useState(savedRules);
  const [review, setReview] = useState<HandbookChange | null>(null);
  const [warn, setWarn] = useState(false);
  const [unlocked, setUnlocked] = useState(data.main.source === "fork");
  const [main, setMain] = useState(data.main.text);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const inFlight = useFiled((c) => kindOf(c) === "rules" && agentOf(c) === agentKey);
  const inFlightMain = useFiled((c) => (kindOf(c) === "handbook" || kindOf(c) === "unfork") && agentOf(c) === agentKey);
  const busy = (f: typeof inFlight) => Boolean(f && !["applied", "failed", "rejected", "closed"].includes(f.stage));
  const module = data.main.module ?? "its";
  const name = agentKey;
  return (
    <div className="hb">
      <section>
        <div className="hb-head"><h4>{local ? "Handbook" : "Your rules"}</h4></div>
        <p className="muted">{local ? "Your agent's whole handbook." : "Kept across module updates. Put lasting preferences here."}</p>
        <textarea className="hb-box" aria-label="Your rules" value={rules} onChange={(e) => (setRules(e.target.value), setReview(null))} disabled={busy(inFlight)} />
        {review?.kind === "rules" ? (
          <Preview change={review} was={savedRules} onDone={() => setReview(null)} onCancel={() => setReview(null)} />
        ) : (
          <div className="hb-actions">
            <button className="btn primary" disabled={rules === savedRules || busy(inFlight)} onClick={() => setReview({ kind: "rules", agent: agentKey, text: rules })}>Save</button>
          </div>
        )}
        {inFlight && <ChangeProgress f={inFlight} />}
      </section>
      {!local && (
        <section>
          <div className="hb-head">
            <h4>Main handbook</h4>
            {data.fork && <span className="hb-badge">Forked</span>}
            {data.fork?.moduleMovedOn && <span className="hb-badge warn">module has a newer version</span>}
            <span className="muted">{data.main.source === "fork" ? "your copy" : `${module} module${data.main.revision ? ` ${data.main.revision}` : ""}`}</span>
          </div>
          <textarea className="hb-box" aria-label="Main handbook" value={main} readOnly={!unlocked} onChange={(e) => (setMain(e.target.value), setReview(null))} disabled={busy(inFlightMain)} />
          {review?.kind === "handbook" ? (
            <Preview change={review} was={data.main.text} onDone={() => setReview(null)} onCancel={() => setReview(null)} />
          ) : review?.kind === "unfork" ? (
            <Preview change={review} was={data.main.text} note="(the module's version)" onDone={() => setReview(null)} onCancel={() => setReview(null)} />
          ) : (
            <div className="hb-actions">
              {!unlocked && <button className="btn" onClick={() => setWarn(true)}>Edit main handbook</button>}
              {unlocked && <button className="btn primary" disabled={main === data.main.text || busy(inFlightMain)} onClick={() => setReview({ kind: "handbook", agent: agentKey, text: main })}>Save main handbook</button>}
              {data.fork && <button className="btn" disabled={busy(inFlightMain)} onClick={() => setConfirmUpdate(true)}>Update</button>}
              {data.fork?.moduleMovedOn && <button className="btn" onClick={() => setShowNew((v) => !v)}>{showNew ? "Hide diff" : "Module version vs yours"}</button>}
            </div>
          )}
          {showNew && data.fork?.moduleText !== undefined && <Diff from={data.main.text} to={data.fork.moduleText} />}
          {inFlightMain && <ChangeProgress f={inFlightMain} />}
        </section>
      )}
      <Dialog open={warn} onClose={() => setWarn(false)}>
        <p>Editing makes your own copy of this handbook. {name} stops getting handbook updates from the {module} module until you press Update, which replaces your edits with the module's version. Your rules are kept either way. For lasting preferences, add them to Your rules instead.</p>
        <div className="hb-actions">
          <button className="btn" onClick={() => setWarn(false)}>Use Your rules</button>
          <button className="btn primary" onClick={() => (setUnlocked(true), setWarn(false))}>I understand, edit</button>
        </div>
      </Dialog>
      <Dialog open={confirmUpdate} onClose={() => setConfirmUpdate(false)}>
        <p>Update replaces your edits to the main handbook with the {module} module's version. Your rules are kept.</p>
        <div className="hb-actions">
          <button className="btn" onClick={() => setConfirmUpdate(false)}>Keep my copy</button>
          <button className="btn primary" onClick={() => (setConfirmUpdate(false), setReview({ kind: "unfork", agent: agentKey }))}>Update</button>
        </div>
      </Dialog>
    </div>
  );
}

/** The compiled text split at its "## " headings, each labelled by where it comes from. */
function labelled(text: string, kind: HandbookData["kind"]): { label: string; body: string }[] {
  const parts = text.split(/\n(?=## )/);
  return parts.map((p, i) => {
    const heading = /^## (.+)/.exec(p)?.[1]?.trim();
    const label = i === 0 ? (kind === "local" ? "Your handbook" : "Main handbook") : heading === "Instance rules" ? "Your rules" : `Added for every agent: ${heading ?? "section"}`;
    return { label, body: p };
  });
}

function Reads({ data }: { data: HandbookData }) {
  if (data.compiled === null) return <p className="fleet-empty">The compiled handbook isn't available right now.</p>;
  return (
    <div className="hb">
      <p className="muted">Exactly what the agent gets, each part labelled by where it comes from.</p>
      {labelled(data.compiled, data.kind).map((p, i) => (
        <section key={i} className="hb-part"><header>{p.label}</header><pre>{p.body}</pre></section>
      ))}
    </div>
  );
}

function History({ agentKey, data, onSignIn }: { agentKey: string; data: HandbookData; onSignIn: () => void }) {
  const [h, setH] = useState<HandbookHistory | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [revert, setRevert] = useState<{ change: HandbookChange; was: string } | null>(null);
  const load = useCallback(() => void api.handbookHistory(agentKey).then(setH, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message))), [agentKey, onSignIn]);
  useEffect(load, [load]);
  if (error) return <p className="fleet-empty">Couldn't load the history: {error}</p>;
  if (!h) return <SkeletonLines lines={3} />;
  if (!h.rows.length) return <p className="fleet-empty">{h.note ?? "No changes yet."}</p>;
  const current = (kind: "rules" | "handbook") => (kind === "rules" ? (data.rules ?? "") : data.main.text);
  return (
    <div className="hb">
      {h.rows.map((r) => {
        const kind = r.kind ?? "rules";
        return (
          <div key={r.sha} className="hb-row">
            <div>
              <strong>{r.subject}</strong>
              <span className="muted">{r.sha.slice(0, 7)} · {ago(r.at)} · {r.source === "instance" ? (kind === "rules" ? "Your rules" : "your copy") : "module"}</span>
              <span className="spacer" />
              <button className="btn" onClick={() => setOpen(open === r.sha ? null : r.sha)}>{open === r.sha ? "Hide diff" : "Diff"}</button>
              {r.source === "instance" && r.before !== undefined && r.before !== null && (
                <button className="btn" onClick={() => setRevert({ change: { kind: instanceKind(data, kind), agent: agentKey, text: r.before! }, was: current(kind) })}>Revert</button>
              )}
            </div>
            {open === r.sha && <Diff from={r.before ?? ""} to={r.after ?? ""} />}
          </div>
        );
      })}
      {revert && <Preview change={revert.change} was={revert.was} onDone={() => (setRevert(null), load())} onCancel={() => setRevert(null)} />}
    </div>
  );
}
/** The agent's memory, read-only: each fact with its date and its source (a link when it is one). */
function Memory({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const [m, setM] = useState<MemoryData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api.memory(agentKey).then(setM, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message))), [agentKey, onSignIn]);
  if (error) return <p className="fleet-empty">Couldn't load the memory: {error}</p>;
  if (!m) return <SkeletonLines lines={3} />;
  if (!m.facts.length) return <p className="fleet-empty">Nothing yet. The agent saves what its work teaches it here; ask it to remember or forget something.</p>;
  return (
    <div className="hb">
      <p className="muted">What {agentKey} has learned, in every run's handbook.{m.updated ? ` Updated ${ago(m.updated)}.` : ""} Ask it to remember or forget something to change it.</p>
      {m.facts.map((f, i) => (
        <div key={i} className="hb-row">
          <span>{f.fact}</span>
          <span className="muted">{f.date} · {f.src.startsWith("https://") ? <a href={f.src} target="_blank" rel="noreferrer noopener">{f.src}</a> : f.src}</span>
        </div>
      ))}
    </div>
  );
}

/** A local agent's whole handbook is its rules; a fork's text is a handbook change. */
const instanceKind = (data: HandbookData, kind: "rules" | "handbook") => (data.kind === "local" ? "rules" : kind);

const SUBS = [["edit", "Edit"], ["reads", "What it reads"], ["memory", "Memory"], ["history", "History"]] as const;

export function AgentHandbook({ agentKey, onSignIn }: { agentKey: string; onSignIn: () => void }) {
  const [data, setData] = useState<HandbookData | null>(null);
  const [error, setError] = useState("");
  const [sub, setSub] = useState<(typeof SUBS)[number][0]>("edit");
  useEffect(() => {
    void api.handbook(agentKey).then(setData, (e) => (e instanceof SignInRequired ? onSignIn() : setError((e as Error).message)));
  }, [agentKey, onSignIn]);
  if (error) return <p className="fleet-empty">Couldn't load the handbook: {error}</p>;
  if (!data) return <SkeletonLines lines={5} />;
  return (
    <ChangesScope onSignIn={onSignIn}>
      <div className="hb-subs">
        <Segmented label="Handbook" options={SUBS} value={sub} onChange={setSub} />
      </div>
      {sub === "edit" && <Edit agentKey={agentKey} data={data} />}
      {sub === "reads" && <Reads data={data} />}
      {sub === "memory" && <Memory agentKey={agentKey} onSignIn={onSignIn} />}
      {sub === "history" && <History agentKey={agentKey} data={data} onSignIn={onSignIn} />}
    </ChangesScope>
  );
}
