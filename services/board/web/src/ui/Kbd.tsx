// A key cap, for a keyboard shortcut beside the thing it does ("J K move", "⌘J").
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
