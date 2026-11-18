// A state as a coloured dot and a word. `tone` picks the colour; "hue" takes the surrounding item's colour (hue.ts).
export type StatusTone = "working" | "needs" | "failed" | "done" | "idle" | "hue";

export function StatusDot({ tone, children, title }: { tone: StatusTone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`ui-status ui-status-${tone}`} title={title}>
      <i aria-hidden />
      <span className="ui-status-word">{children}</span>
    </span>
  );
}

/** A task or chat state (ChatState, or "stopped") as a tone and a short word. */
export function taskStatus(state: string): { tone: StatusTone; word: string } {
  switch (state) {
    case "working": return { tone: "working", word: "Working" };
    case "queued": return { tone: "working", word: "Queued" };
    case "waiting for you": return { tone: "needs", word: "Needs you" };
    case "waiting for approval": return { tone: "needs", word: "Approval" };
    case "in review": return { tone: "working", word: "In review" };
    case "failed": return { tone: "failed", word: "Failed" };
    case "done": return { tone: "done", word: "Done" };
    case "stopped": return { tone: "idle", word: "Stopped" };
    default: return { tone: "idle", word: state ? state[0]!.toUpperCase() + state.slice(1) : "Idle" };
  }
}
