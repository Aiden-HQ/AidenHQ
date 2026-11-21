// The computer pool's fair share: agent jobs (admission.ts) and check jobs (checkbox.ts) draw on one pool (settings.computers_max),
// and each kind is guaranteed half of it. Either may borrow the other's idle boxes, but a kind over its half never takes a box
// from the other kind's waiting work that is still under its own half: it waits until something of its own kind ends.
// A kind over its share waits queued, it never fails.

/** A kind's guaranteed share of a pool. */
export const share = (pool: number) => Math.max(1, Math.floor(pool / 2));
/** How long a refused agent wake counts as waiting (dispatch asks again every tick). */
const DEMAND_MS = 60_000;

export function createPool({ capacity, agentLive, now = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: { capacity: () => number; agentLive: () => number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  let checks = 0, checksWaiting = 0;
  const agentsWaiting = new Map<string, number>();
  const demand = () => { for (const [k, at] of agentsWaiting) if (now() - at > DEMAND_MS) agentsWaiting.delete(k); return agentsWaiting.size > 0; };
  const mayCheck = () => {
    const live = agentLive(), cap = capacity();
    return live + checks < cap && (checks < share(cap) || !(demand() && live < share(cap)));
  };
  return {
    /** Inside admission's transaction (synchronous): may this wake's agent job take a box now? A refusal is demand the checks respect. */
    mayAgent(wake: string): boolean {
      const live = agentLive(), cap = capacity();
      const ok = live + checks < cap && (live < share(cap) || !(checksWaiting > 0 && checks < share(cap)));
      if (ok) agentsWaiting.delete(wake); else agentsWaiting.set(wake, now());
      return ok;
    },
    /** A check job's slot: resolves when it may take a box; hold it until the box is released (`freeCheck`). */
    async takeCheck() {
      checksWaiting++;
      try { while (!mayCheck()) await sleep(2_000); checks++; } finally { checksWaiting--; }
    },
    /** A box a previous kernel launched for a check, followed by this one: it holds a slot without waiting for one. */
    adopt() { checks++; },
    freeCheck() { checks = Math.max(0, checks - 1); },
    checks: () => checks,
  };
}
export type Pool = ReturnType<typeof createPool>;
