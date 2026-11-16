// The 3b parity table: representative classify() outputs (as tiers.mjs builds them), the model verdicts a review can come
// back with, and representative card args. gen-before.mjs ran them through today's code once; parity-3b.test.mjs runs
// them through the kernel.
export const LUNA = "~openai/gpt-luna-latest";
const SECOND = "~deepseek/deepseek-flash-latest";
const T = (tier, rule, extra = {}) => ({ tier, rule, reason: `because ${rule}`, ...extra });

/** `wrap`: the tiers.mjs step applied to `t` before autonomyCap (classify's own meritOwner and routineCapped). */
export const CASES = [
  { name: "tier 0", t: T(0, "own-branch") },
  { name: "tier 1", t: T(1, "app-repo") },
  { name: "tier 1 panel", t: T(1, "gate-core", { panel: true }) },
  { name: "tier 2 on its merits", t: T(2, "unknown-repos"), wrap: ["meritOwner"] },
  { name: "owner veto part", t: T(2, "owner-veto"), wrap: ["meritOwner"] },
  { name: "new module authority", t: T(2, "new-authority", { reviewFirst: true }) },
  { name: "new module authority panel", t: T(2, "new-authority", { reviewFirst: true, panel: true }) },
  { name: "new authority over a merit part", t: T(2, "owner-approval-record", { reviewFirst: true, byMerit: true }) },
  { name: "tier 0 under a routine off", t: T(0, "own-branch"), wrap: ["routineCapped", "off"] },
  { name: "tier 1 under a routine tier0", t: T(1, "app-repo"), wrap: ["routineCapped", "tier0"] },
  { name: "tier 1 panel under a routine off", t: T(1, "gate-core", { panel: true }), wrap: ["routineCapped", "off"] },
  { name: "refused", t: T(2, "closed-task", { reject: true }) },
];

export const VERDICTS = {
  approve: { decision: "approve", reason: "fine.", model: LUNA },
  "approve with a second": { decision: "approve", reason: "fine.", model: LUNA, second: SECOND },
  "approve, panel marked": { decision: "approve", reason: "fine.", model: LUNA, panel_marked: true },
  "approve, panel marked, second": { decision: "approve", reason: "fine.", model: LUNA, second: SECOND, panel_marked: true },
  reject: { decision: "reject", reason: "no.", model: LUNA, code: "policy" },
  "reject stale_head": { decision: "reject", reason: "moved.", model: LUNA, code: "stale_head" },
  "reject refused_by_code": { decision: "reject", reason: "code says no.", model: LUNA, code: "refused_by_code" },
  "reject unsure": { decision: "reject", reason: "unsure.", model: LUNA, second: SECOND, code: "reviewer_unsure" },
  escalate: { decision: "escalate", reason: "owner please.", model: LUNA, code: "needs_owner" },
  "failed 6 times": { decision: "failed" },
};

const SHA = (c) => c.repeat(40);
export const CARDS = {
  "push one": ["push", { only: [{ repo: "acme/app", branch: "feat/x", sha: SHA("a"), base: SHA("b"), patch: "c".repeat(64) }] }],
  "push two": ["push", { only: [{ repo: "acme/app", branch: "feat/x", sha: SHA("a") }, { repo: "acme/web", branch: "fix/y", sha: SHA("d") }] }],
  "pr with text": ["pr", { only: [{ repo: "acme/app", branch: "feat/x", sha: SHA("a") }], text: { title: "Add x", body: "Line one.\n\nLine two." } }],
  "product pr that merges": ["pr", { only: [{ repo: "acme/aidenhq", branch: "fix/z", sha: SHA("e") }], text: { title: "fix: z", body: "Why." }, merge: true }],
  "merge two": ["merge", { prs: [{ repo: "acme/app", number: 4, url: "https://github.com/acme/app/pull/4", head: SHA("f") }, { repo: "acme/app", number: 5, url: "https://github.com/acme/app/pull/5", noReview: true }], gap: 10 }],
  "create repo": ["create_repo", { repo: "acme-agents/sales-board" }],
  "apply": ["apply", { repo: "acme-agents/aidenhq-instance", branch: "fleet/x", sha: SHA("1"), files: ["instance.yaml", "agents/x/AGENTS.md"] }, "diff --git a/instance.yaml b/instance.yaml\n-product: 1\n+product: 2"],
  "apply with authority": ["apply", { repo: "acme-agents/aidenhq-instance", branch: "fleet/x", sha: SHA("2"), files: ["instance.yaml"], authority: ["engine-claude: secrets anthropic_key (owner)", "tasks: tools read (review)"], ownerRequired: true }, "diff --git a/instance.yaml b/instance.yaml"],
  "raise cap": ["raise_cap", { scope: "task", agentId: "agent-1", subject: "i-1", cap: 10, spent: 10.5 }],
};
