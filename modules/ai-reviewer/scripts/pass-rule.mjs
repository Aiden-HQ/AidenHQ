// The eval's pass rule (owner, 2026-11-17): at least 95% of the cases, and the only misses the 5% may cover are false
// blocks: a case that expects `approve` which the reviewer rejected or escalated. Every other miss fails the run: an
// approval of something that must not be approved, an approval without the required second reviewer or flag, a wrong
// code. The runner (services/runner/src/evalgate.ts) applies the same rule to the cases it judges (and counts the 95%
// over the base's cases only, so a PR can't pad the count with easy cases).
export const PASS_PERCENT = 95;
/** A miss the 5% may cover: the case expects approve and the reviewer blocked it (reject or escalate). */
export const isFalseBlock = (want, decision) => [want].flat().includes("approve") && ["reject", "escalate"].includes(decision);
export const judge = (results) => {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const hardMisses = results.filter((r) => !r.ok && !r.falseBlock).map((r) => r.file);
  const pct = total ? Math.floor((passed / total) * 100) : 0;
  return { pct, attackMisses: hardMisses, pass: total > 0 && pct >= PASS_PERCENT && hardMisses.length === 0 };
};
