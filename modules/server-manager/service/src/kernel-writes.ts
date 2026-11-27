// The service's own filings, through the kernel with the module's token (spec §3, §6, §13): a write record for the two kinds, a
// quiet holder task that keeps a machine's records (so a Tier 2 card still has a task to land on), and the wake the agent gets
// when a run needs a judgement. The token is read fresh per call, so a token written after start works.
import { kernelClient, KernelError } from "./aidenhq-sdk/kernel-client.ts";
import { fence } from "./aidenhq-sdk/fence.ts";

export interface Filed { id: string; tier: number; state: string }

export class KernelWrites {
  private readonly client: () => ReturnType<typeof kernelClient>;
  private readonly log: (msg: string, f?: Record<string, unknown>) => void;
  private readonly holders = new Map<string, string>();

  constructor(i: { url: string; token: () => string; log?: (msg: string, f?: Record<string, unknown>) => void }) {
    this.client = () => kernelClient(i.url, i.token());
    this.log = i.log ?? (() => undefined);
  }

  /** Files one of the module's kinds. The plan derives the rest of the args; only what the page names is sent, plus its task. */
  async file(kind: "server-manager.patch" | "server-manager.reboot", args: Record<string, unknown>, task?: string): Promise<Filed> {
    const r = (await this.client().call("POST", "/v1/writes", { kind, args, ...(task ? { task } : {}) })) as Filed;
    this.log("write filed", { kind, id: r.id, tier: r.tier, state: r.state });
    return r;
  }

  /** A record's state and, when it has one, its outcome text (the executor's report). */
  async read(id: string): Promise<{ id: string; state: string; outcome?: { ok: boolean; text: string } | null }> {
    return (await this.client().call("GET", `/v1/writes/${id}`)) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
  }

  /**
   * The quiet task that holds a machine's records: filed in the backlog, so it wakes nobody, and keyed by its source so every run
   * on that machine files onto the same one. A Tier 2 record needs a task (the kernel insists: an approval has somewhere to land),
   * and this is that place — never a task the owner is asked to act on.
   */
  async holder(machine: string, agent: string): Promise<string> {
    const had = this.holders.get(machine);
    if (had) return had;
    const r = (await this.client().call("POST", "/v1/tasks", {
      title: `Server Manager records: ${machine}`,
      description: `Holds the write records for ${machine} (its patch and reboot runs). It is filed quiet on purpose: the owner's cards and the run outcomes land here, and it wakes nobody. Its records are on the kernel, one per run.`,
      agent, source: `server-manager:records:${machine}`, quiet: true,
    })) as { id: string };
    this.holders.set(machine, r.id);
    return r.id;
  }

  /** Wakes the module's agent with one machine and its evidence (§13). Never throws: a lost wake is logged, not a failed run. */
  async wake(i: { agent: string; machine: string; title: string; body: string; source: string }): Promise<void> {
    try {
      await this.client().call("POST", "/v1/tasks", {
        title: i.title.slice(0, 200),
        // What a host printed (an apt error, a unit's log) is data: fenced, so it can never read as an instruction in the task.
        description: `${fence(i.body, `${i.source}`)}\n\nRead your maintenance skill: report what happened on ${i.machine} in plain words, say what was not done and why, and stop on that machine.`,
        agent: i.agent, source: i.source.slice(0, 200),
      });
    } catch (e) {
      const why = e instanceof KernelError ? `${e.status}` : String((e as Error).message ?? e).slice(0, 200);
      this.log("wake failed; the run is unaffected", { machine: i.machine, source: i.source, err: why });
    }
  }

  /** The module agent's Paperclip id, read from the kernel's directory by its key. Cached once found. */
  async agentId(): Promise<string> {
    for (const [id, a] of Object.entries((await this.client().call("GET", "/v1/agents"))?.agents ?? {})) {
      if ((a as { key?: string }).key === "server-manager") return id;
    }
    throw new Error("no agent with the key server-manager is in the grants table");
  }
}
