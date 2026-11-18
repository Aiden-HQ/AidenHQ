// A state as a coloured dot and a word: the board's one status vocabulary. `tone` picks the colour:
//   working  under way (green dot, quiet word)       ok      healthy, connected, on (green)
//   needs    waiting on you (amber)                  failed  broken, rejected (red)
//   idle     off, stopped, unknown (grey)            done    finished (hollow)
//   info     built in, informational (accent)        busy    changing right now (accent, pulsing)
//   hue      the surrounding item's colour (hue.ts)
export type StatusTone = "working" | "ok" | "needs" | "failed" | "idle" | "done" | "info" | "busy" | "hue";

export function StatusDot({ tone, children, title }: { tone: StatusTone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`ui-status ui-status-${tone}`} title={title}>
      <i aria-hidden />
      <span className="ui-status-word">{children}</span>
    </span>
  );
}

/** A task or chat state (ChatState, or "stopped") as a tone and a short word. Only work under way is green. */
export function taskStatus(state: string): { tone: StatusTone; word: string } {
  switch (state) {
    case "working": return { tone: "working", word: "Working" };
    case "queued": return { tone: "idle", word: "Queued" };
    case "waiting for you": return { tone: "needs", word: "Needs you" };
    case "waiting for approval": return { tone: "needs", word: "Approval" };
    case "in review": return { tone: "idle", word: "In review" };
    case "failed": return { tone: "failed", word: "Failed" };
    case "done": return { tone: "done", word: "Done" };
    case "stopped": return { tone: "idle", word: "Stopped" };
    default: return { tone: "idle", word: state ? state[0]!.toUpperCase() + state.slice(1) : "Idle" };
  }
}
