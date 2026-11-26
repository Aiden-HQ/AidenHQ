// A choice as a card: a real radio or checkbox inside a label (keyboard and screen readers work as for any input), a title,
// a line under it, an optional badge ("Recommended") and media (a face). Checked: an accent border and a filled mark.
export function OptionCard({ type, name, value, checked, onChange, title, sub, badge, media, disabled }: { type: "radio" | "checkbox"; name: string; value: string; checked: boolean; onChange: (checked: boolean) => void; title: React.ReactNode; sub?: React.ReactNode; badge?: React.ReactNode; media?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={`ui-opt ui-opt-${type}${checked ? " on" : ""}${disabled ? " off" : ""}`}>
      <input type={type} name={name} value={value} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-opt-mark" aria-hidden>
        {type === "checkbox" && <svg width="12" height="12" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      {media && <span className="ui-opt-media">{media}</span>}
      <span className="ui-opt-text">
        <span className="ui-opt-title">{title}{badge && <span className="ui-opt-badge">{badge}</span>}</span>
        {sub && <span className="ui-opt-sub">{sub}</span>}
      </span>
    </label>
  );
}
