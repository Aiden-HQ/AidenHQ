// Test helpers: code review's verdict for a classified head and the Risk ship reads from it (full preset: every tier approves and merges).
import { riskOf, type Verdict } from "../service/src/safe.ts";
import { PRESETS, type Tier } from "../service/src/settings.ts";

export const verdict = (tier: Tier = "standard", o: Partial<Verdict> = {}): Verdict => ({
  verdict: "pass", reasons: [], requires_review: true, tier: { state: "classified", tier, rule: 0, why: "a test" }, policy: "p1", kind: "completed", reviewed: "h", ...o,
});
export const RISK = riskOf(PRESETS.full, verdict());
