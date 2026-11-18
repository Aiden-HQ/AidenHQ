// What an empty list says, and the one thing to do about it.
export function EmptyState({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="ui-empty">
      <p>{children}</p>
      {action}
    </div>
  );
}
