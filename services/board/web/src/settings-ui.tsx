// Settings' building blocks, shared by every page: the page header, grouped rows that open in place, controls (switch,
// segmented choice), and the one way a change leaves the page: a preview of the exact instance.yaml lines, saved on the
// owner's authority (the kernel writes and applies it), then followed on the row (applying, live). Nothing here applies anything.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { SignInRequired, api } from "./api";
import type { ChangeStage, FiledChange, SettingChange } from "./types";
import { changeLines } from "./settings-format";
import { PageHeader } from "./ui";

export function Page({ title, sub, children, tools }: { title: string; sub?: ReactNode; children: ReactNode; tools?: ReactNode }) {
  return (
    <main className="st-page">
      <PageHeader title={title} sub={sub} actions={tools} />
      {children}
    </main>
  );
}

/** A titled group of rows: the heading says what they share, the count how many. */
export function Group({ title, count, hint, children, tone }: { title?: ReactNode; count?: number; hint?: ReactNode; children: ReactNode; tone?: "needs" }) {
  return (
    <section className={`st-group${tone ? ` st-group-${tone}` : ""}`}>
      {(title || hint) && (
        <header className="st-group-head">
          {title && <h2>{title}</h2>}
          {count !== undefined && <span className="st-count">{count}</span>}
          {hint && <span className="st-group-hint">{hint}</span>}
        </header>
      )}
      <div className="st-rows">{children}</div>
    </section>
  );
}

/** One row; `details` opens below it, with the row's chevron. `open` may be held by the caller. */
export function Row({ lead, title, sub, meta, action, details, tone, open: held, onToggle, id }: { lead?: ReactNode; title: ReactNode; sub?: ReactNode; meta?: ReactNode; action?: ReactNode; details?: ReactNode; tone?: string; open?: boolean; onToggle?: (open: boolean) => void; id?: string }) {
  const [own, setOwn] = useState(false);
  const open = held ?? own;
  const toggle = () => (onToggle ? onToggle(!open) : setOwn(!open));
  const panel = useId();
  return (
    <div className={`st-row${tone ? ` st-tone-${tone}` : ""}${open ? " open" : ""}`} id={id}>
      <div className="st-row-main">
        {details ? (
          <button className="st-row-hit" onClick={toggle} aria-expanded={open} aria-controls={panel}>
            {lead}
            <span className="st-row-text">
              <span className="st-row-title">{title}</span>
              {sub && <span className="st-row-sub">{sub}</span>}
            </span>
            {meta && <span className="st-row-meta">{meta}</span>}
            <Chevron />
          </button>
        ) : (
          <div className="st-row-hit static">
            {lead}
            <span className="st-row-text">
              <span className="st-row-title">{title}</span>
              {sub && <span className="st-row-sub">{sub}</span>}
            </span>
            {meta && <span className="st-row-meta">{meta}</span>}
          </div>
        )}
        {action && <div className="st-row-action">{action}</div>}
      </div>
      {details && (
        <div className="st-reveal" id={panel} aria-hidden={!open}>
          <div className="st-reveal-inner">{open && <div className="st-details">{details}</div>}</div>
        </div>
      )}
    </div>
  );
}

const Chevron = () => (
  <svg className="st-chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ------------------------------------------------------------------ changes: filed, followed

interface ChangesCtx {
  changes: FiledChange[];
  /** Files the change; resolves to its task, or throws with the board's reason. */
  file: (changes: SettingChange[]) => Promise<string>;
  toast: (text: string, tone?: "ok" | "bad") => void;
}
export const Changes = createContext<ChangesCtx>({ changes: [], file: async () => "", toast: () => {} });
export const useChanges = () => useContext(Changes);

export const IN_FLIGHT: ChangeStage[] = ["working", "waiting", "applying"];
const RECENT_MS = 15 * 60_000;

/** The newest filed change that touches what `match` picks, while it is under way or just finished. */
export function useFiled(match: (c: SettingChange) => boolean): FiledChange | undefined {
  const { changes } = useChanges();
  return changes.find((f) => f.items.some(match) && (IN_FLIGHT.includes(f.stage) || Date.now() - Date.parse(f.createdAt) < RECENT_MS));
}

const STEPS: { stage: ChangeStage; label: string }[] = [
  { stage: "working", label: "Filed" },
  { stage: "waiting", label: "Approve" },
  { stage: "applying", label: "Applying" },
  { stage: "applied", label: "Live" },
];

/** Where a filed change stands, as four steps; a refusal or a failed apply says so instead. */
export function ChangeProgress({ f, after }: { f: FiledChange; after?: ReactNode }) {
  const at = STEPS.findIndex((s) => s.stage === f.stage);
  const stopped = f.stage === "failed" || f.stage === "rejected" || f.stage === "closed";
  const line =
    f.stage === "working"
      ? "The kernel is writing the change."
      : f.stage === "waiting"
        ? f.tier === 1
          ? "With the AI reviewer, or you when autonomy is off."
          : "Waiting for your approval."
        : f.stage === "applying"
          ? "Approved: the host is applying it and restarting what changed."
          : f.stage === "applied"
            ? "Live."
            : f.stage === "rejected"
              ? "Rejected: nothing changed."
              : f.stage === "failed"
                ? "The apply failed: nothing changed."
                : "Closed without a change.";
  return (
    <div className={`st-progress${stopped ? " stopped" : ""}`} role="status">
      {!stopped && (
        <ol className="st-steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s.stage} className={i < at ? "done" : i === at ? (s.stage === "applied" ? "done" : "now") : ""}>
              <span className="st-step-dot" aria-hidden />
              {s.label}
            </li>
          ))}
        </ol>
      )}
      <p className="st-progress-line">
        {line}{" "}
        {f.stage === "waiting" && (
          <a href="#/" className="st-link">
            Open Home
          </a>
        )}{" "}
        <a href={`#/t/${f.identifier}`} className="st-link muted">
          {f.identifier}
        </a>
      </p>
      {f.detail && <pre className="st-progress-detail">{f.detail}</pre>}
      {after}
    </div>
  );
}

/** The exact change, before it is filed: the instance.yaml lines, and File change. */
export function ChangePreview({ items, was, onDone, onCancel, note }: { items: SettingChange[]; was: unknown[]; onDone?: (task: string) => void; onCancel: () => void; note?: ReactNode }) {
  const { file, toast } = useChanges();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      const task = await file(items);
      toast(`Change filed (${task}). You'll see it here as it moves.`);
      onDone?.(task);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-preview">
      <div className="st-preview-file">instance.yaml</div>
      <dl className="st-diff">
        {items.map((ch, i) => {
          const l = changeLines(ch, was[i]);
          return (
            <div key={i} className="st-diff-row">
              <dt>{l.path}</dt>
              <dd>
                <del>{l.from}</del>
                <ins>{l.to}</ins>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="st-preview-note">
        {note ? <>{note} </> : null}Saving is your approval: the kernel commits exactly this and applies it, usually within a few minutes.
      </p>
      {error && (
        <p className="st-error" role="alert">
          {error}
        </p>
      )}
      <div className="st-preview-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void go()} disabled={busy}>
          {busy ? "Filing…" : "File change"}
        </button>
      </div>
    </div>
  );
}

/** Settings' toasts: one line each, gone after a few seconds. */
export function Toasts({ items }: { items: { id: number; text: string; tone?: "ok" | "bad" }[] }) {
  return (
    <div className="st-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`st-toast${t.tone === "bad" ? " bad" : ""}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Polls `run` every `ms` while the page is visible. */
export function usePoll(run: () => void, ms: number) {
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && run(), ms);
    return () => clearInterval(t);
  }, [run, ms]);
}

/** The change context (filed changes, how to file one, toasts) for a page outside Settings that edits settings. */
export function ChangesScope({ onSignIn, children }: { onSignIn: () => void; children: ReactNode }) {
  const [changes, setChanges] = useState<FiledChange[]>([]);
  const [toasts, setToasts] = useState<{ id: number; text: string; tone?: "ok" | "bad" }[]>([]);
  const loadChanges = useCallback(() => api.settingsChanges().then((r) => setChanges(r.changes), () => {}), []);
  useEffect(() => {
    void loadChanges();
    const t = setInterval(() => document.visibilityState === "visible" && void loadChanges(), 10_000);
    return () => clearInterval(t);
  }, [loadChanges]);
  const ctx = useMemo(
    () => ({
      changes,
      file: async (items: SettingChange[]) => {
        try {
          const { identifier } = await api.changeSettings(items);
          void loadChanges();
          return identifier;
        } catch (e) {
          if (e instanceof SignInRequired) onSignIn();
          throw e;
        }
      },
      toast: (text: string, tone?: "ok" | "bad") => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, text, tone }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4_500);
      },
    }),
    [changes, loadChanges, onSignIn],
  );
  return (
    <Changes.Provider value={ctx}>
      {children}
      <Toasts items={toasts} />
    </Changes.Provider>
  );
}
