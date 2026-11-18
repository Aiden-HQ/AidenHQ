// The parts of one page (Overview, Settings, ...): links with an underline in the item's hue. Each tab is its own URL,
// so Back and a reload keep it. For a filter or a view choice inside a section, use Segmented.
export function Tabs<T extends string>({ tabs, value, href, label }: { tabs: readonly (readonly [T, string])[]; value: T; href: (tab: T) => string; label: string }) {
  return (
    <nav className="ui-tabs" aria-label={label} role="tablist">
      {tabs.map(([t, name]) => (
        <a key={t} href={href(t)} role="tab" aria-selected={value === t}>
          {name}
        </a>
      ))}
    </nav>
  );
}
