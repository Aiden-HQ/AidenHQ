// The order of one org's answers, per process: a call that names the org may have succeeded, and a call that refuses it raised an
// sso/restricted need. A success must not clear a need newer than it, so a success whose org was refused again before it is
// reported is dropped rather than sent. Keyed by the org, lowercased (GitHub logins are case-insensitive); one clock for the
// process, so every caller's order is comparable.

const seen = new Map<string, { success: number; failed: number }>();
let seq = 0;

/**
 * Take this success into the org's order: true when it is the newest answer (the caller may report it), false when a refusal of
 * the org came after the last success (a newer need stands, so this success must not be reported).
 */
export function claimOrgOk(org: string): boolean {
  const key = org.toLowerCase();
  const e = seen.get(key) ?? { success: 0, failed: 0 };
  if (e.failed > e.success) return false;
  e.success = ++seq;
  seen.set(key, e);
  return true;
}

/** A call for `org` was refused (an sso/restricted need): every success for it before now is stale. */
export function noteOrgNeed(org: string | undefined): void {
  if (!org) return;
  const key = org.toLowerCase();
  const e = seen.get(key) ?? { success: 0, failed: 0 };
  e.failed = ++seq;
  seen.set(key, e);
}
