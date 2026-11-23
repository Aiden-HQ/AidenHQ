// The platform check (P5, spec §3.5) at write.filed on the code hosts' pushes, PRs and merges: the kernel runs it in process
// on every such filing (kernel/src/writes.ts filedRaises), a hard gate (kernel/src/gates.ts): it always enforces. It raises
// or refuses, never lowers. It holds what a tier can't: a change to the owner-approval records goes alone, so one approval
// never also approves other files.
// Pure and dependency-free: the files come from the plan (`paths`, one { repo, files: [{ path, from? }] } per branch or PR,
// read by the code host from git).

/**
 * The owner-approved source exceptions (review-request.mjs reads them from the base). A record says `approved_by: owner`, and code
 * cannot tell an owner's word from an agent's: a change to this file goes alone (a `.github/` change, the AI reviewer's).
 */
export const OWNER_APPROVAL_FILE = ".github/supply-chain-source-exceptions.yaml";

/** `{ kind, args, paths, facts }` → `{ verdict: "ok" }` or `{ verdict: "deny", rule, reason }`. */
export function check({ paths }: { paths?: unknown } = {}) {
  const files = new Set((Array.isArray(paths) ? paths : []).flatMap((p) => (Array.isArray(p?.files) ? p.files : []).flatMap((f: { path?: unknown; from?: unknown } | null) => [f?.path, f?.from])).filter((f) => typeof f === "string"));
  if (files.has(OWNER_APPROVAL_FILE) && files.size > 1) return { verdict: "deny", rule: "owner-approval-alone", reason: `${OWNER_APPROVAL_FILE} changes with other files: file the source approval on its own` };
  return { verdict: "ok" };
}
