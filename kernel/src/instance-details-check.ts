// The code-review module's write.filed check on its posts and replies (kernel/src/writes.ts filedRaises): a GitHub thread is
// outside the instance, so text naming its hosts, home paths or addresses is refused at filing, whatever tier the write runs at
// (they run at Tier 0: no AI reviewer reads them). The service removes such text from its own posts first (adapters.ts), so this
// is the backstop. It reads the card's details and every string of the args except what no comment publishes: the review's
// reviewed and excluded file lists, and a nit's evidence and reasoning (a nit shows its title and place only).
import { instanceDetailsIn } from "../sdk/src/instance-details.ts";

type Finding = { severity?: unknown; evidence?: unknown; why?: unknown };
export function check({ details, args }: { details?: string; args?: unknown } = {}) {
  const parts = [String(details ?? "")];
  const { review, ...rest } = (args ?? {}) as { review?: { coverage?: { reviewed?: unknown; excluded?: unknown }; findings?: Finding[] } };
  const { reviewed: _reviewed, excluded: _excluded, ...coverage } = review?.coverage ?? {};
  const findings = (Array.isArray(review?.findings) ? review.findings : []).map((f) => (f?.severity === "nit" ? { ...f, evidence: undefined, why: undefined } : f));
  JSON.parse(JSON.stringify({ ...rest, review: { ...review, coverage, findings } }), (_k, v) => { if (typeof v === "string") parts.push(v); return v; });
  const leaked = instanceDetailsIn(parts.join("\n"));
  return leaked.length
    ? { verdict: "deny", rule: "instance-details", reason: `instance details in a GitHub write: ${leaked.slice(0, 8).join(", ")}. A GitHub thread is outside the instance; leave out its hosts, addresses and paths and file the call again.` }
    : { verdict: "ok" };
}
