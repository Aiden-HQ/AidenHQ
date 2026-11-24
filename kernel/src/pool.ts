// The computer pool: agent jobs (admission.ts) and check jobs (checkbox.ts) each have their own number of computers. Agent
// jobs take at most settings.computers_max (config/computers.json `max`), check jobs at most settings.check_computers_max
// (`checks`); the launcher keeps both (its pool is their sum). A check box mostly waits on remote model calls (measured about
// 250 MB and no CPU), so a repo review's many checks never take a computer from an agent job, nor wait on one.
// A check over its number waits queued, it never fails.

export function createPool({ capacity, checkCapacity, agentLive, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: { capacity: () => number; checkCapacity: () => number; agentLive: () => number; sleep?: (ms: number) => Promise<void> }) {
  let checks = 0;
  return {
    /** Inside admission's transaction (synchronous): may an agent job take a computer now? */
    mayAgent(): boolean {
      return agentLive() < capacity();
    },
    /** A check job's slot: resolves when it may take a box; hold it until the box is released (`freeCheck`). */
    async takeCheck() {
      while (checks >= checkCapacity()) await sleep(2_000);
      checks++;
    },
    /** A box a previous kernel launched for a check, followed by this one: it holds a slot without waiting for one. */
    adopt() { checks++; },
    freeCheck() { checks = Math.max(0, checks - 1); },
    checks: () => checks,
  };
}
export type Pool = ReturnType<typeof createPool>;
