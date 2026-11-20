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
