// A plain surface for a few facts or a short note, and the label/value list that usually goes in it.
export const Card = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => <div className={`ui-card ${className}`}>{children}</div>;

/** Label/value rows; an optional third item is the label's help, shown on hover. */
export function Facts({ items }: { items: readonly (readonly [string, React.ReactNode, string?] | false | null | undefined)[] }) {
  return (
    <dl className="ui-facts">
      {items.filter((x): x is readonly [string, React.ReactNode, string?] => Boolean(x)).map(([k, v, help], i) => (
        <div key={`${i}:${k}`} style={{ display: "contents" }}>
          <dt title={help}>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A thin meter, 0 to 1. */
export function Meter({ value, tone, label }: { value: number; tone?: "needs" | "failed"; label: string }) {
  return (
    <div className={`ui-meter${tone ? ` ${tone}` : ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
