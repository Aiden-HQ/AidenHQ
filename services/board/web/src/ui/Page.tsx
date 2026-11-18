// A page of the board: fluid gutters, its own scroll, sections stacked. Start every new page from
//   <Page><PageHeader title=… sub=… actions=… /><Section title=…>…</Section></Page>   (docs/design/board-ui.md)
export function Page({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <main className={`ui-page ${className}`} aria-label={label}>
      {children}
    </main>
  );
}
