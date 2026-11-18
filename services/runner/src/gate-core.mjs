// The gate's own core in the product repo: the product's half of the platform check's list (the official modules list their
// own paths in modules/platform/src/check.mjs). Each repo owns the paths it holds, so a new gate file and its entry land in
// one PR. The runner passes these to the check (tiers.mjs, `facts.gateCore`) and gate-coverage.test.mjs holds both halves.
//
// The gate's own core and anything that can bypass or widen it (owner, 2026-11-14): authority-expanding, so the AI reviewer
// and a second, independent reviewer on another model family must both approve (`panel`); a split goes to the owner. The
// approval path (tiers, the reviewer's request side, the owner's-words check, the merge queue's writes, apply), the state
// classify() trusts and the runner's GitHub writes (main, state, config), the job jail, who an agent is and what it may call
// (the kernel's identity and tool proxy, the compiler's grants, setup), the board's approval records, decision routes and
// sign-in, the sandboxes, the kernel (its model gateway: key and spend caps), host privileges, the security checks, and the
// product's CI (the checks a merge waits on). A file stays here when it moves from `.mjs` to `.ts` (the TypeScript
// conversion), so each name matches either extension.
export const GATE_CORE = [
  // One entry per file, so a renamed or moved gate file shows up as a dead entry (gate-coverage.test.mjs).
  ...["tiers", "gate-core", "review-request", "siblings", "cards", "evalgate", "apply", "state", "config", "progress", "main", "engines", "files", "agents", "typed-change", "url-setting", "release", "release-sync"].map((n) => new RegExp(`^services\\/runner\\/src\\/${n}\\.(mjs|ts)$`)),
  // What a job can reach: the computer box rules (computers).
  /^scripts\/computers\.(mjs|ts)$/,
  /^kernel\/sdk\//,
  // The changed files as the reviewer reads them (synced into the reviewer module; the runner imports this copy).
  /^services\/shared\/review-files\.(mjs|ts)$/,
  // The kernel (the tool proxy, caller identity and assertions, the model gateway) and each server's copy of the SDK's caller
  // check (scripts/sync-shared.mjs).
  /^kernel\//,
  /(^|\/)aidenhq-sdk\/caller\.ts$/,
  // The compiler (moved out of the kernel): compose isolation, the grants it writes, the authority diff.
  /^scripts\/compiler\//,
  /^scripts\/modules\.(mjs|ts)$/,
  /^scripts\/paperclip-setup\.(mjs|ts)$/,
  /^scripts\/no-shell\.(mjs|ts)$/,
  /^services\/board\/src\/app\.ts$/,
  /^services\/board\/src\/fleet\.ts$/,
  // The board's sign-in: its own session, handed off and checked by the kernel (3g); the board opens no accounts file.
  /^services\/board\/src\/kernel-auth\.ts$/,
  /^services\/board\/src\/session\.ts$/,
  /^services\/computer\//,
  /^ops\//,
  /^scripts\/verify-security\.sh$/,
  // The path inventory and its compiler (the kernel's tier function reads what they make: kernel/src/paths.ts).
  /^paths\.yaml$/,
  /^scripts\/paths\.(mjs|ts)$/,
  /^scripts\/supply-chain\//,
  /^\.gitleaks\.toml$/,
  // The lean counters and checklists, and the tests that hold this list: loosening either would hide an ungated file.
  /^scripts\/lean\//,
  /^scripts\/test\/lean\.test\.mjs$/,
  /^services\/runner\/test\/gate-coverage\.test\.mjs$/,
  /(^|\/)\.github\//,
];
/** Where gate files live: every tracked file here must match a GATE_CORE entry or be listed in OUTSIDE_GATE. A trailing
 * `/` is a prefix; anything else is an exact path. */
export const GATE_DIRS = [
  "services/runner/src/",
  "kernel/",
  "services/computer/",
  "ops/",
  "services/shared/review-files.mjs",
  "services/board/src/app.ts",
  "services/board/src/fleet.ts",
  "services/board/src/kernel-auth.ts",
  "services/board/src/session.ts",
];
/** Files in a gate dir deliberately outside the core. Adding one here is a gate-core change. */
export const OUTSIDE_GATE = [
  "advise.ts", "answered.ts", "branch.ts", "busy.ts", "describe.ts", "evidence.ts", "gcp.ts", "grade.ts",
  "images.ts", "intake.ts", "metrics.ts", "models.mjs", "notices.ts", "paperclip.ts", "primer.ts", "prompt.ts",
  "recurring.ts", "repohelper.ts", "retry.ts", "reviews.ts", "thread.ts", "types.ts", "usage.ts",
].map((f) => `services/runner/src/${f}`);
/** `uncovered: <file>` for a file in a gate dir that no entry matches and OUTSIDE_GATE doesn't list; `dead entry: <source>`
 * for an entry that matches no file. */
export function coverageProblems(files, core = GATE_CORE, outside = OUTSIDE_GATE, dirs = GATE_DIRS) {
  const inDir = (f) => dirs.some((d) => (d.endsWith("/") ? f.startsWith(d) : f === d));
  return [
    ...files.filter((f) => inDir(f) && !outside.includes(f) && !core.some((g) => g.test(f))).map((f) => `uncovered: ${f}`),
    ...core.filter((g) => !files.some((f) => g.test(f))).map((g) => `dead entry: ${g.source}`),
  ];
}
