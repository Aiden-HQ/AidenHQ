// A local change's merge refusals, as code: the three reasons `codehost-local.merge` never lands a change, each named as
// codehost-github's rules name it (modules/github/service/src/plan.ts), so an agent reads one vocabulary on both code hosts.
//
//   head-moved        the merge asked for one exact head and the change's head is another: the checks ran on the head asked
//                     for, and nobody reviewed the new one. Ask again for the new head.
//   checks-not-green  a required check is missing for this head and base, red, or still running past the wait. Only a green
//                     receipt for this exact head and base lands a change.
//   conflict          the change doesn't merge onto the base as it is now (main moved under it), or the base ref moved while
//                     this merge ran. Nothing is overwritten: the merge is a compare-and-swap on the base ref.
//
// Pure over what the host read, so the rules are tested without git; host.ts asks them before and during the merge.

/** The refusal for a merge bound to `asked` when the change's head is now `current`. */
export const headMoved = (url: string, current: string, asked: string): string | undefined =>
  current === asked ? undefined : `${url} moved since it was asked for (head-moved): it was ${asked.slice(0, 12)}, it is ${current.slice(0, 12)} now; ask again for its new head`;

/** A check's state as the host reads it: `ok` green, `pending` still running, `missing` never asked or it couldn't run. */
export type Check = { ok: boolean; pending: boolean; missing?: boolean; summary?: string };

/**
 * The refusal for a merge whose checks aren't green on this head and base: none at all, one missing, one red, or one still
 * running past the wait. `waited` says whether the merge waited for them; a plan-time read leaves a running check to the
 * merge, which waits.
 */
export function checksNotGreen(checks: Check[], waited: boolean): string | undefined {
  if (!checks.length) return "checks-not-green: it has no named check on its head; a change on this server needs the `change` check job to have run";
  const red = checks.find((c) => !c.ok && !c.pending);
  if (red) return `checks-not-green: a required check ${red.missing ? "couldn't run" : "failed"} on its head (${String(red.summary ?? "no summary").slice(0, 200)})`;
  const running = checks.filter((c) => !c.ok && c.pending).length;
  if (running && waited) return `checks-not-green: ${running} required check${running === 1 ? "" : "s"} didn't finish in time on its head`;
  return undefined;
}

/** The refusal for a base that moved under the merge: at the compare-and-swap, `actual` is what the base ref reads now. */
export const baseMoved = (url: string, base: string, actual: string): string | undefined =>
  actual === base ? undefined : `${url}: conflict: the default branch moved while it merged (${actual.slice(0, 12)} now); ask again, and its checks run against the new base`;
