// One card of settings on one page: a row per setting (title, one-line help, its control flush right), one local draft, and
// one Save/Discard bar that files every change as a single settings change. Used by the general Settings pages and by a
// module's Settings tab, so a setting is edited the same way everywhere. Saving files the change (the owner's own save is
// his approval, docs/design/settings-changes.md); the card then follows it until it is live.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { urlSettingProblem } from "../../src/url-setting";
import { parseInput, settingSummary, settingTitle } from "./settings-format";
import { ChangeProgress, IN_FLIGHT, useChanges } from "./settings-ui";
import type { SettingChange, SettingRow } from "./types";
import { Button, Segmented } from "./ui";

/** How one row differs from its declaration: its words, its control, a unit. */
export interface RowOpts {
  /** Replaces the first sentence of the setting's comment. */
  sub?: ReactNode;
  /** Words for a choice's stored values ("tier0" is "Tier 0"). */
  labels?: Record<string, string>;
  prefix?: string;
  /** The value may not be empty (beyond the setting's own `required`). */
  required?: boolean;
  placeholder?: string;
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

/** Whether the draft holds the value itself (a choice, several, a control of its own) rather than the text of an input. */
const holdsValue = (s: SettingRow, o: RowOpts) => isChoice(s) || multi(s) || Boolean(o.control);
/** The value a row sends: a held value as it is, text parsed back to the setting's type. */
const typed = (s: SettingRow, o: RowOpts, draft: unknown): unknown => (holdsValue(s, o) ? draft : parseInput(s, String(draft ?? "")));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

function problemOf(s: SettingRow, o: RowOpts, next: unknown): string | null {
  if (holdsValue(s, o)) return null;
  if (s.type === "url") return next === "" ? null : urlSettingProblem(next, s.host);
  if (typeof effective(s) === "number" && (Number.isNaN(next) || (next as number) < 0)) return "a number";
  const bad = [next].flat().find((x) => s.pattern && typeof x === "string" && x !== "" && !new RegExp(s.pattern).test(x));
  if (bad !== undefined) return `a value like ${s.pattern}`;
  if ((s.required || o.required) && (next === "" || next === undefined)) return "a value";
  return null;
}

/** A row of a settings card: the words on the left, the control on the right at the card's one control width. */
export function SetRow({ title, sub, help, children, tone, note }: { title: ReactNode; sub?: ReactNode; help?: string; children?: ReactNode; tone?: "bad"; note?: ReactNode }) {
  return (
    <div className="st-set" title={help}>
      <div className="st-set-text">
        <span className="st-set-title">{title}</span>
        {sub && <span className="st-set-sub">{sub}</span>}
        {note && <span className={`st-set-note${tone ? ` ${tone}` : ""}`}>{note}</span>}
      </div>
      {children && <div className="st-set-ctl">{children}</div>}
    </div>
  );
}

function Control({ s, o, value, set, disabled, invalid }: { s: SettingRow; o: RowOpts; value: unknown; set: (v: unknown) => void; disabled: boolean; invalid: boolean }) {
  const name = settingTitle(s);
  if (o.control) return <>{o.control(value, set)}</>;
  const values = s.values ?? [];
  if (multi(s))
    return (
      <div className="ui-checks" role="group" aria-label={name}>
        {values.map((x) => {
          const on = (value as unknown[]).includes(x);
          return (
            <label key={String(x)} className={`ui-check${on ? " on" : ""}`}>
              <input type="checkbox" checked={on} disabled={disabled} onChange={() => set(on ? (value as unknown[]).filter((y) => y !== x) : [...(value as unknown[]), x])} />
              {o.labels?.[String(x)] ?? words(x)}
            </label>
          );
        })}
      </div>
    );
  if (isChoice(s)) {
    const pick = (x: string) => set(values.find((y) => String(y) === x));
    if (values.length <= 4) return <Segmented value={String(value)} label={name} options={values.map((x) => [String(x), o.labels?.[String(x)] ?? words(x)] as const)} onChange={pick} />;
    return (
      <select className="ui-select" value={String(value)} disabled={disabled} onChange={(e) => pick(e.target.value)} aria-label={name}>
        {values.map((x) => (
          <option key={String(x)} value={String(x)}>
            {o.labels?.[String(x)] ?? words(x)}
          </option>
        ))}
      </select>
    );
  }
  const numeric = typeof effective(s) === "number";
  return (
    <span className="st-numfield">
      {o.prefix && <span className="st-prefix">{o.prefix}</span>}
      <input
        className="ui-input"
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
 * a setting on another card. `lead` and `trail` are SetRows of their own (a browser's permission, a pointer), kept in the same card.
 */
export function SettingsCard({ rows, all = rows, opts = {}, lead, trail, tail }: { rows: SettingRow[]; all?: SettingRow[]; opts?: Record<string, RowOpts>; lead?: ReactNode; trail?: ReactNode; tail?: ReactNode }) {
  const { changes, file, toast } = useChanges();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // What the server now has changed (an apply landed): start over from it.
  const sig = JSON.stringify(rows.map((r) => [r.key, r.value]));
  useEffect(() => setDraft({}), [sig]);

  const keys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const filed = changes.find((f) => f.items.some((c) => c.kind === "setting" && keys.has(c.key)) && (IN_FLIGHT.includes(f.stage) || (f.stage === "failed" && Date.now() - Date.parse(f.createdAt) < 15 * 60_000)));
  const busy = Boolean(filed && IN_FLIGHT.includes(filed.stage));

  const optsOf = (s: SettingRow) => opts[s.key] ?? {};
  const valueOf = (s: SettingRow) => (s.key in draft ? draft[s.key] : holdsValue(s, optsOf(s)) ? effective(s) : textOf(effective(s)));
  const settled = (k: string) => { const s = all.find((x) => x.key === k); return s ? String(typed(s, optsOf(s), valueOf(s))) : ""; };
  const shownRows = rows.filter((s) => Object.entries(s.when ?? {}).every(([k, v]) => settled(k) === String(v)));
  const edits = shownRows.map((s) => ({ s, next: typed(s, optsOf(s), valueOf(s)) })).filter(({ s, next }) => !same(next, effective(s)));
  const problems = new Map(edits.flatMap(({ s, next }) => { const p = problemOf(s, optsOf(s), next); return p ? [[s.key, p] as const] : []; }));
  const set = (s: SettingRow, v: unknown) => {
    const back = same(typed(s, optsOf(s), v), effective(s));
    setDraft((d) => { const n = { ...d }; if (back) delete n[s.key]; else n[s.key] = v; return n; });
    setError("");
  };
  const discard = () => (setDraft({}), setError(""));
  async function save() {
    setSaving(true);
    setError("");
    try {
      const items: SettingChange[] = edits.map(({ s, next }) => ({ kind: "setting", key: s.key, value: next }));
      const task = await file(items);
      toast(`Saved as ${task}: it goes live in a moment.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="st-card-wrap">
      {filed && <ChangeProgress f={filed} />}
      <section className="st-card">
        {lead}
        {shownRows.map((s) => {
          const o = optsOf(s);
          const drift = s.live !== undefined && s.known && s.value !== null && s.live !== String(s.value);
          const edited = s.key in draft && !problems.has(s.key) && edits.some((e) => e.s.key === s.key);
          return (
            <div key={s.key} className={`st-set-wrap${edited ? " edited" : ""}`}>
              <SetRow
                title={settingTitle(s)}
                sub={o.sub ?? firstSentence(s.doc)}
                help={s.doc}
                tone="bad"
                note={problems.has(s.key) ? `Needs ${problems.get(s.key)}.` : drift ? `Running as ${s.live}: the last apply may not have finished.` : undefined}
              >
                <Control s={s} o={o} value={valueOf(s)} set={(v) => set(s, v)} disabled={busy} invalid={problems.has(s.key)} />
              </SetRow>
            </div>
          );
        })}
        {!shownRows.length && !lead && !trail && <p className="st-empty">Nothing to set.</p>}
        {trail}
      </section>
      {tail}
      {edits.length > 0 && (
        <div className="st-bar" role="region" aria-label="Unsaved changes">
          <div className="st-bar-text">
            <b>{edits.length === 1 ? "1 change" : `${edits.length} changes`}</b>
            <span>
              {edits.map(({ s, next }) => `${settingTitle(s)}: ${settingSummary(effective(s), s.values)} → ${settingSummary(next, s.values)}`).join("; ")}
            </span>
            {error && <span className="st-bar-error" role="alert">{error}</span>}
            {busy && <span>Another change to these settings is being applied: Save unlocks once it is live.</span>}
          </div>
          <div className="st-bar-actions">
            <Button variant="quiet" onClick={discard} disabled={saving}>Discard</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving || busy || problems.size > 0}>{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
