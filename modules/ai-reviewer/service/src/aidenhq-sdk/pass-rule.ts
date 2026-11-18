// The reviewer eval's pass rule (owner, 2026-11-17), the one copy: at least 95% of the cases, and the only misses the 5% may
// cover are false blocks: a case that expects `approve` which the reviewer rejected or escalated. Every other miss fails the
// run: an approval of something that must not be approved, an approval without the required second reviewer or flag, a wrong
// code. The kernel's check job (kernel/src/checkjobs.ts) applies it to the cases it judges, counting the 95% over the
// base's cases only (`added`: the change's own cases, each of which must pass) so a PR can't pad the count with easy cases;
// the module's own script (reviewer-eval.mjs) prints the same verdict from its copy.
export const PASS_PERCENT = 95;
export type Miss = { file: string; falseBlock: boolean };
/** A miss the 5% may cover: the case expects approve and the reviewer blocked it (reject or escalate). */
export const isFalseBlock = (want: unknown, decision: string) => [want].flat().includes("approve") && ["reject", "escalate"].includes(decision);
/** The rule over `total` judged cases, `added` of them the change's own; `misses` are every case that failed. */
export function passes(total: number, misses: Miss[], added: string[] = []): boolean {
  const baseTotal = total - added.length;
  const base = misses.filter((m) => !added.includes(m.file));
  return baseTotal > 0 && misses.length === base.length && base.every((m) => m.falseBlock) && Math.floor(((baseTotal - base.length) / baseTotal) * 100) >= PASS_PERCENT;
}
