// The code-review module's write.filed check on its posts and replies (kernel/src/writes.ts filedRaises): a GitHub thread is
// outside the instance, so text naming its hosts, home paths or addresses is refused at filing, whatever tier the write runs at
// (they run at Tier 0: no AI reviewer reads them). The scan is the one the reviewer's own code check uses (sdk/src/reviewer.ts).
import { instanceDetailsIn } from "../sdk/src/reviewer.ts";

export function check({ details }: { details?: string } = {}) {
  const leaked = instanceDetailsIn(String(details ?? ""));
  return leaked.length
    ? { verdict: "deny", rule: "instance-details", reason: `instance details in a GitHub write: ${leaked.slice(0, 8).join(", ")}. A GitHub thread is outside the instance; leave out its hosts, addresses and paths and file the call again.` }
    : { verdict: "ok" };
}
