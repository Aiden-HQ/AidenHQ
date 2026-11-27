// A job that stops making progress is stopped, one that waits on CI is not (dispatch's follow loop, loop.ts). Read from the
// kernel's view of the job (`progress.steps`: every tool call, the engine's own words for it), so every engine is judged
// alike: no edit, commit or test run for the window, or one file read READS times with no edit between, stops the job; time
// spent sleeping or watching CI doesn't count toward the window. The kernel keeps only the job's hard deadline.

export const WINDOW_MS = 35 * 60_000;
const READS = 20;

const COMMAND = /^(?:Running|Bash|bash|shell)\b/;
const EDIT = /^(?:Editing|Edit|Write|MultiEdit|NotebookEdit|edit|write|multiedit|patch|apply_patch)\b|\bapply_patch\b|\bsed\s+-i|\bgit\s+apply\b|\bperl\s+-pi|\btee\b|<<-?\s*['"]?\w+|(?<![\d&<>=-])>{1,2}\s*(?!&|\/dev\/null)[\w./~-]+/;
const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b/;
const TEST = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|typecheck|lint)\b|\btsc\b|\bvitest\b|\bjest\b|\bbun\s+(?:run\s+)?(?:test|build|typecheck|lint)\b|\bnode\s+(?:--\S+\s+)*--test\b|\bpytest\b|\bgo\s+(?:test|build|vet)\b|\bcargo\s+(?:test|build|check)\b|\bmake\s+(?:test|build|check)\b/;
const WAIT = /\bsleep\s+\d|--watch\b|\baidenhq[- ]wait\b/;
const FILE = /[\w@./-]+\.(?:tsx?|mjs|cjs|jsx?|json|md|ya?ml|py|go|rs|sh|css|html)\b/g;

export interface Step { at: string; text: string }

export function progressTracker({ start = Date.now(), windowMs = WINDOW_MS }: { start?: number; windowMs?: number } = {}) {
  let last = start; // the last edit, commit or test run
  let waited = 0; // waiting since then
  let waitFrom: number | undefined; // a wait the job is in
  let activity = "";
  let seenAt = 0;
  const seenSame = new Set<string>();
  const reads = new Map<string, number>();

  const endWait = (t: number) => {
    if (waitFrom === undefined) return;
    waited += t - waitFrom;
    waitFrom = undefined;
  };

  return {
    /** Feed the steps of a progress event (the whole recent list each time: the ones already seen are skipped). */
    add(steps: Step[] = []) {
      for (const { at, text } of steps) {
        const t = Date.parse(at) || Date.now();
        if (t < seenAt || (t === seenAt && seenSame.has(text))) continue;
        if (t > seenAt) seenSame.clear();
        seenAt = t;
        seenSame.add(text);
        endWait(t);
        activity = text;
        const cmd = COMMAND.test(text);
        if (cmd && WAIT.test(text)) {
          waitFrom = t;
          continue;
        }
        const edit = EDIT.test(cmd ? text : text.split(/[:\s]/)[0] ?? "");
        if (edit || (cmd && (COMMIT.test(text) || TEST.test(text)))) {
          last = t;
          waited = 0;
        }
        if (edit) reads.clear();
        else for (const f of new Set(text.match(FILE) ?? [])) reads.set(f, (reads.get(f) ?? 0) + 1);
      }
    },
    /** Why the job should stop, or undefined. */
    check(now = Date.now()): string | undefined {
      const idle = now - last - waited - (waitFrom === undefined ? 0 : now - waitFrom);
      const lastly = `last activity: ${activity || "none"}`;
      if (idle > windowMs) return `no progress for ${Math.round(windowMs / 60_000)} min; ${lastly}`;
      for (const [file, n] of reads) if (n >= READS) return `${file} read ${n} times with no edit; ${lastly}`;
    },
  };
}
