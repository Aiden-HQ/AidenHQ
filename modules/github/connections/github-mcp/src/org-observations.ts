// The order of one org's answers, per process: a call that names the org may have succeeded, and a call that refuses it raised an
// sso/restricted need. A success's delayed retry (reportOrgOk, which retries a transient kernel failure) must not clear a need the
// kernel recorded after that success: a later refusal is the newer truth. Keyed by the org, lowercased (GitHub logins are
// case-insensitive); one clock for the process, so every caller's order is comparable.

const seen = new Map<string, { success: number; failed: number }>();
let seq = 0;

/** A success named `org`: returns its place in the order, for a retry to compare against later refusals. */
export function noteOrgOk(org: string): number {
  const key = org.toLowerCase();
  const at = ++seq;
  const e = seen.get(key) ?? { success: 0, failed: 0 };
  e.success = at;
  seen.set(key, e);
  return at;
}

/** A call for `org` was refused (an sso/restricted need): every success for it before now is stale. */
export function noteOrgNeed(org: string | undefined): void {
  if (!org) return;
  const key = org.toLowerCase();
  const e = seen.get(key) ?? { success: 0, failed: 0 };
  e.failed = ++seq;
  seen.set(key, e);
}

/** Whether a refusal of `org` landed after the success at `at` (so that success must not be repeated). */
export const orgRefusedSince = (org: string, at: number): boolean => (seen.get(org.toLowerCase())?.failed ?? 0) > at;
