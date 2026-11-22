// The code-review module's write.filed check on its posts and replies (kernel/src/writes.ts filedRaises): a GitHub thread is
// outside the instance, so text naming its hosts, home paths or addresses is refused at filing, whatever tier the write runs at
// (they run at Tier 0: no AI reviewer reads them). It reads the card's details and every string of the args, so text the poster
// renders longer than the card (a finding's summary fallback) is checked too. The scan is the reviewer's own code check
// (sdk/src/reviewer.ts).
import { instanceDetailsIn } from "../sdk/src/reviewer.ts";

export function check({ details, args }: { details?: string; args?: unknown } = {}) {
  const parts = [String(details ?? "")];
  // The args' text that can reach a comment: not the review's list of reviewed files, which no comment publishes.
  const { review, ...rest } = (args ?? {}) as { review?: { coverage?: unknown } };
  const { coverage: _coverage, ...published } = review ?? {};
  JSON.parse(JSON.stringify({ ...rest, review: published }), (_k, v) => { if (typeof v === "string") parts.push(v); return v; });
  const leaked = instanceDetailsIn(parts.join("\n"));
  return leaked.length
    ? { verdict: "deny", rule: "instance-details", reason: `instance details in a GitHub write: ${leaked.slice(0, 8).join(", ")}. A GitHub thread is outside the instance; leave out its hosts, addresses and paths and file the call again.` }
    : { verdict: "ok" };
}
