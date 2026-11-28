// One card of settings on one page: a row per setting (title, one-line help, its control flush right), one local draft, and
// one Save/Discard bar that files every change as a single settings change. Used by the general Settings pages and by a
// module's Settings tab, so a setting is edited the same way everywhere. Saving files the change (the owner's own save is
// his approval, docs/design/settings-changes.md); the card then follows it until it is live and starts over from the result.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { urlSettingProblem } from "../../src/url-setting";
import { parseInput, settingSummary, settingTitle } from "./settings-format";
import { ChangeProgress, IN_FLIGHT, useChanges } from "./settings-ui";
import type { SettingChange, SettingRow } from "./types";
import { Button, Checks, Disclosure, FieldRow, Input, Segmented, Select } from "./ui";

/** How one row differs from its declaration: its words, its control, a unit. */
export interface RowOpts {
  /** Replaces the first sentence of the setting's comment. */
  sub?: ReactNode;
  /** Words for a choice's stored values ("tier0" is "Tier 0"). */
  labels?: Record<string, string>;
  prefix?: string;
  placeholder?: string;
  /** The value may not be empty (beyond the setting's own `required`). */
  required?: boolean;
  /** A number's allowed range. */
  min?: number;
  max?: number;
  /** A control of its own: the draft value, and how to change it. */
  control?: (value: unknown, set: (v: unknown) => void) => ReactNode;
}

const words = (v: unknown) => String(v).replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
/** The first sentence of a setting's comment, for the one-line help (the whole comment is its hover). */
const firstSentence = (doc?: string) => {
  const t = (doc ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.{20,160}?[.:;])(\s|$)/.exec(t);
  return m ? m[1]!.replace(/[:;]$/, ".") : t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

const effective = (s: SettingRow) => s.value ?? s.default;
const textOf = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));
const multi = (s: SettingRow) => Array.isArray(effective(s)) && Boolean(s.values?.length);
const isChoice = (s: SettingRow) => Boolean(s.values?.length) && !multi(s);
/** A map, or a list of maps (maintainer_repos, ship, code_review): a feature page edits it, never a row of text. */
export const isStructured = (s: SettingRow) => {
  const v = effective(s);
  return Boolean(v) && typeof v === "object" && (!Array.isArray(v) || v.some((x) => x && typeof x === "object"));
};

/** Whether the draft holds the value itself (a choice, several, a control of its own) rather than the text of an input. */
const holdsValue = (s: SettingRow, o: RowOpts) => isChoice(s) || multi(s) || Boolean(o.control);
/** The value a row sends: a held value as it is, text parsed back to the setting's type. */
const typed = (s: SettingRow, o: RowOpts, draft: unknown): unknown => {
  if (holdsValue(s, o)) return draft;
  const text = String(draft ?? "");
  // An emptied number is no number (Number("") is 0): it stays a problem until the owner types one.
  return typeof effective(s) === "number" && !text.trim() ? NaN : parseInput(s, text);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

function problemOf(s: SettingRow, o: RowOpts, next: unknown): string | null {
  if (holdsValue(s, o)) return null;
  if (s.type === "url") return next === "" ? null : urlSettingProblem(next, s.host);
  if (typeof effective(s) === "number") {
    const lo = o.min ?? 0;
    const hi = o.max;
    const ok = typeof next === "number" && !Number.isNaN(next) && next >= lo && (hi === undefined || next <= hi);
    return ok ? null : hi !== undefined ? `a number from ${lo} to ${hi}` : "a number";
  }
  const bad = [next].flat().find((x) => s.pattern && typeof x === "string" && x !== "" && !new RegExp(s.pattern).test(x));
  if (bad !== undefined) return `a value like ${s.pattern}`;
  if ((s.required || o.required) && (next === "" || next === undefined)) return "a value";
  return null;
}

function Control({ s, o, value, set, disabled, invalid }: { s: SettingRow; o: RowOpts; value: unknown; set: (v: unknown) => void; disabled: boolean; invalid: boolean }) {
  const name = settingTitle(s);
  if (o.control) return <>{o.control(value, set)}</>;
  const values = (s.values ?? []).map(String);
  if (multi(s)) return <Checks options={values} value={(value as unknown[]).map(String)} onChange={set} label={name} disabled={disabled} />;
  if (isChoice(s)) {
    const options = values.map((x) => [x, o.labels?.[x] ?? words(x)] as const);
    const pick = (x: string) => set((s.values ?? []).find((y) => String(y) === x));
    return values.length <= 4 ? <Segmented value={String(value)} label={name} options={options} onChange={pick} /> : <Select value={String(value)} options={options} onChange={pick} disabled={disabled} aria-label={name} />;
  }
  if (isStructured(s)) return <span className="st-readonly" title="A map: its feature page edits it, or ask Aiden.">{settingSummary(effective(s))}</span>;
  const numeric = typeof effective(s) === "number";
  return (
    <span className="st-numfield">
      {o.prefix && <span className="st-prefix">{o.prefix}</span>}
      <Input
        value={String(value ?? "")}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
        type={s.type === "url" ? "url" : numeric ? "number" : "text"}
        inputMode={numeric ? "decimal" : undefined}
        spellCheck={false}
        aria-label={name}
        aria-invalid={invalid || undefined}
        placeholder={o.placeholder ?? (Array.isArray(effective(s)) ? "comma, separated" : "")}
      />
    </span>
  );
}

/**
 * One card of settings. `rows` are the settings it edits (a row hidden by its `when` is left out); `all` lets a row's `when` read
 * a setting on another card. `lead` and `trail` are FieldRows of their own (a browser's permission, a pointer) in the same card;
 * `advanced` are rows kept under a collapsed Advanced row. `reload` re-reads the rows once a saved change is live.
 */
export function SettingsCard({ rows, advanced = [], all, opts = {}, lead, trail, reload }: { rows: SettingRow[]; advanced?: SettingRow[]; all?: SettingRow[]; opts?: Record<string, RowOpts>; lead?: ReactNode; trail?: ReactNode; reload?: () => void }) {
  const { changes, file, toast } = useChanges();
  // What the owner has typed or picked, by key, as the control holds it (raw text for an input).
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const task = useRef<string | null>(null);
  const [error, setError] = useState("");
  const mine = useMemo(() => [...rows, ...advanced], [rows, advanced]);
  // What the server now has changed (an apply landed): start over from it.
  const sig = JSON.stringify(mine.map((r) => [r.key, r.value]));
  useEffect(() => (setDraft({}), setSent(null), setError("")), [sig]);

  const keys = useMemo(() => new Set(mine.map((r) => r.key)), [mine]);
  const filed = changes.find((f) => f.items.some((c) => c.kind === "setting" && keys.has(c.key)) && (IN_FLIGHT.includes(f.stage) || (["failed", "rejected", "closed"].includes(f.stage) && Date.now() - Date.parse(f.createdAt) < 15 * 60_000)));
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));
  // The change this card filed went live (even if no in-flight stage was seen): the module's rows are read again (the Settings pages reload themselves).
  useEffect(() => {
    if (task.current && changes.some((f) => f.identifier === task.current && f.stage === "applied")) {
      task.current = null;
      reload?.();
    }
  }, [changes, reload]);

  const optsOf = (s: SettingRow) => opts[s.key] ?? {};
  const valueOf = (s: SettingRow) => (s.key in draft ? draft[s.key] : holdsValue(s, optsOf(s)) ? effective(s) : textOf(effective(s)));
  const settled = (k: string) => { const s = (all ?? mine).find((x) => x.key === k); return s ? String(typed(s, optsOf(s), valueOf(s))) : ""; };
  const visible = (s: SettingRow) => Object.entries(s.when ?? {}).every(([k, v]) => settled(k) === String(v));
  const shownRows = rows.filter(visible);
  const shownAdvanced = advanced.filter(visible);
  // Only a row the owner touched is a change, and only while it differs from the live value.
  const edits = [...shownRows, ...shownAdvanced].filter((s) => s.key in draft && !isStructured(s)).map((s) => ({ s, next: typed(s, optsOf(s), draft[s.key]) })).filter(({ s, next }) => !same(next, effective(s)));
  const problems = new Map(edits.flatMap(({ s, next }) => { const p = problemOf(s, optsOf(s), next); return p ? [[s.key, p] as const] : []; }));
  const set = (s: SettingRow, v: unknown) => (setDraft((d) => ({ ...d, [s.key]: v })), setSent(null), setError(""));
  // Saved and under way (or just filed): the card's own progress says so, and the bar steps aside until it lands or fails.
  const waiting = busy || (sent !== null && sent === JSON.stringify(draft) && !(filed && !IN_FLIGHT.includes(filed.stage)));
  async function save() {
    setSaving(true);
    setError("");
    try {
      const items: SettingChange[] = edits.map(({ s, next }) => ({ kind: "setting", key: s.key, value: next }));
      const id = await file(items);
      task.current = id;
      setSent(JSON.stringify(draft));
      toast(`Saved as ${id}: it goes live in a moment.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const row = (s: SettingRow) => {
    const o = optsOf(s);
    const drift = s.live !== undefined && s.known && s.value !== null && s.live !== String(s.value);
    const note = problems.has(s.key) ? `Needs ${problems.get(s.key)}.` : drift ? `Running as ${s.live}: the last apply may not have finished.` : undefined;
    const edited = edits.some((e) => e.s.key === s.key) && !problems.has(s.key);
    return (
      <div key={s.key} className={`st-set-wrap${edited ? " edited" : ""}`} title={s.doc}>
        <FieldRow title={settingTitle(s)} help={<>{o.sub ?? firstSentence(s.doc)}{note && <span className={`st-set-note${problems.has(s.key) ? " bad" : ""}`}>{note}</span>}</>}>
          <Control s={s} o={o} value={valueOf(s)} set={(v) => set(s, v)} disabled={busy} invalid={problems.has(s.key)} />
        </FieldRow>
      </div>
    );
  };
  return (
    <div className="st-card-wrap">
      {filed && <ChangeProgress f={filed} />}
      <section className="st-card">
        {lead}
        {shownRows.map(row)}
        {!shownRows.length && !lead && !trail && !shownAdvanced.length && <p className="st-empty">Nothing to set.</p>}
        {shownAdvanced.length > 0 && (
          <div className="st-advanced">
            <Disclosure summary="Advanced">{shownAdvanced.map(row)}</Disclosure>
          </div>
        )}
        {trail}
      </section>
      {edits.length > 0 && !waiting && (
        <div className="st-bar" role="region" aria-label="Unsaved changes">
          <div className="st-bar-text">
            <b>{edits.length === 1 ? "1 change" : `${edits.length} changes`}</b>
            <span>{edits.map(({ s, next }) => `${settingTitle(s)}: ${settingSummary(effective(s), s.values)} → ${settingSummary(next, s.values)}`).join("; ")}</span>
            {error && <span className="st-bar-error" role="alert">{error}</span>}
          </div>
          <div className="st-bar-actions">
            <Button variant="quiet" onClick={() => setDraft({})} disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving || problems.size > 0}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
