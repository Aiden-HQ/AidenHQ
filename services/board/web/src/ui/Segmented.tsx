// A small set of exclusive choices (a filter, a view, a setting with two to four values), side by side in one track.
export function Segmented<T extends string>({ options, value, onChange, label }: { options: readonly (readonly [T, React.ReactNode])[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map(([v, name]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {name}
        </button>
      ))}
    </div>
  );
}
