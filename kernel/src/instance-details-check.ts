// The code-review module's write.filed check on its posts and replies (kernel/src/writes.ts filedRaises): a GitHub thread is
// outside the instance, so comment text naming its hosts, home paths or addresses is refused at filing, whatever tier the write
// runs at (they run at Tier 0: no AI reviewer reads them). The service removes such text from its own posts first (adapters.ts),
// so this is the backstop. The repo, a finding's path and the reviewed-files lists are not read.
import { instanceDetailsIn, publishedText } from "../sdk/src/instance-details.ts";

export function check({ args }: { args?: unknown } = {}) {
  const leaked = instanceDetailsIn(publishedText(args).join("\n"));
  return leaked.length
    ? { verdict: "deny", rule: "instance-details", reason: `instance details in a GitHub write: ${leaked.slice(0, 8).join(", ")}. A GitHub thread is outside the instance; leave out its hosts, addresses and paths and file the call again.` }
    : { verdict: "ok" };
}
