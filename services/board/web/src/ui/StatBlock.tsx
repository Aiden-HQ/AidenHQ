// A number with its label and a line of context, and optionally a 7-day bar chart in the surrounding hue (hue.ts).
export interface Bar { label: string; value: number; title: string }

export function StatBlock({ label, value, sub, bars, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; bars?: Bar[]; tone?: "bad" }) {
  const max = Math.max(0, ...(bars ?? []).map((b) => b.value));
  return (
    <div className={`ui-stat${tone ? ` ui-stat-${tone}` : ""}`}>
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value">{value}</div>
      {sub && <div className="ui-stat-sub">{sub}</div>}
      {bars && (
        <div className="ui-bars" role="img" aria-label={`${label} per day: ${bars.map((b) => b.title).join("; ")}`}>
          {bars.map((b, i) => (
            <div key={i} className="ui-bar" title={b.title}>
              <div className="ui-bar-track">
                <div className={`ui-bar-fill${b.value ? "" : " zero"}`} style={b.value ? { height: `${Math.max(6, (b.value / max) * 100)}%` } : undefined} />
              </div>
              <span className="ui-bar-label" aria-hidden>{b.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
