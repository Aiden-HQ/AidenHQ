// The release train's loop (W3; the runner's runReleases, moved): once a minute, the instance target's bump decided by
// release.mjs trainStep, written by code and filed as a kernel.apply through the kernel's /v1/writes with this module's own
// token (role kernel.apply). The kernel plans it (kernel/src/apply-tier.ts) and tiers it like any apply: the instance rules,
// the module authority the move brings and the path inventory, with no branch for who filed it. Its task is one the kernel
// files for the agent holding the platform-engineer role (POST /v1/tasks, role kernel.tasks), once per tip.
//
// No apply runs twice: the bump's commit is deterministic for the same instance main and pins, the bump being filed is
// written down before it is filed (a restart files the same commit again, which the kernel answers with the same open
// record), and a filed bump is followed by its record until it ends; the executor launches each record once.
//
// Built here, started at the switch (`startReleases`), when the runner's copy is deleted: nothing calls it before.
// Only the instance target: the `modules` target (the product's modules-pin.json PR) ends with the modules monorepo (owner,
// 2026-11-18). The task is filed when the bump files (no description updates as merges land), and its assignment wakes the
// Platform Engineer once.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bumpInstance, pinOf, trainDescription, trainStep } from "./release.mjs";

type Gate = undefined | { wait: string } | { stop: string };
export type Commit = { repo: string; sha: string; subject: string };
export type TrainOptions = {
  dir: string; productRepo: string; instanceRepo: string; modulesRepo: string; windowMinutes: number;
  /** The kernel with this module's token: POST /v1/tasks, /v1/tasks/:id/close, /v1/writes; GET /v1/writes/:id. */
  kernel(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  github: {
    /** A repo's default branch head and whether every check on it passed. */
    tip(repo: string): Promise<{ tip?: string; green: boolean }>;
    /** A file at a commit (or the default branch's head), undefined when it isn't there. */
    text(repo: string, path: string, at?: string): Promise<string | undefined>;
    commits(repo: string, from: string, to: string): Promise<Commit[]>;
  };
  /** The bump's commit on the instance's main, in this service's cache: `edit` reads the file at the head it builds on. */
  commit(repo: string, path: string, edit: (text: string) => string, message: string): Promise<string>;
  /** The reviewer-eval gate on the official modules' move (evalgate.ts bump). */
  evalBump(from: string, to: string): Promise<Gate>;
  now?: () => Date; log?: (msg: string, f?: Record<string, unknown>) => void;
};
/**
 * The official modules' sha as bumpInstance edits it (its one `- { name: aidenhq, …, sha }` line), for starting the reviewer
 * eval before filing. Advisory only: the land's gate reads the pin structurally (the kernel's officialMove) and decides.
 */
const listedPin = (text: string) => /^\s*-\s*\{.*\bname:\s*aidenhq\b.*\bsha:\s*([0-9a-f]{40})/m.exec(text)?.[1] ?? null;
type State = {
  open?: { since: string };
  filing?: { to: string; sha: string; task: string; identifier: string };
  flight?: { to: string; record: string; task: string; identifier: string };
  lastTried?: string;
};
const MOVING = ["review", "owner", "approved", "claimed"];

export function createReleaseTrain(o: TrainOptions) {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  mkdirSync(o.dir, { recursive: true });
  const file = join(o.dir, "release-instance.json");
  const load = (): State => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const save = (s: State) => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };
  const close = (task: string, status: "done" | "cancelled", body: string) => o.kernel("POST", `/v1/tasks/${task}/close`, { status, body }).catch((e: Error) => log("release task not closed", { task, err: e.message }));

  /** A filed bump: over once its record is. A land refused because main moved on, or the eval still running, is filed again. */
  async function follow(s: State) {
    const f = s.flight!;
    const r = await o.kernel("GET", `/v1/writes/${f.record}`);
    if (MOVING.includes(r.state)) return;
    const text = String(r.outcome?.text ?? "").split("\n")[0]!.slice(0, 300);
    const retry = r.state === "failed" && /moved on since this commit's base|not landed: .*(eval|isn't at)/.test(text);
    if (r.state === "done") await close(f.task, "done", "Applied: this instance runs the bump.");
    else await close(f.task, "done", `**Not landed:** ${r.state === "rejected" ? "the card was rejected" : r.state === "failed" ? `it was approved but failed: ${text}` : `the card was ${r.state}`}. ${retry ? "The same commits are filed again as the next bump." : "The next merge to the product files the next bump."}`);
    log("release bump over", { task: f.identifier, state: r.state, retry });
    if (!retry) s.lastTried = f.to;
    delete s.flight;
  }

  /** The bump's task, its commit and its kernel.apply: written down before filing, so a restart files the same one. */
  async function fileBump(s: State, to: string, pinned: string, text: string) {
    if (!s.filing || s.filing.to !== to) {
      const modules = pinOf(await o.github.text(o.productRepo, "modules-pin.json", to));
      if (!modules) throw Object.assign(new Error(`product ${to.slice(0, 12)} pins no modules`), { lasting: true });
      const from = listedPin(text);
      const gate = from && from !== modules ? await o.evalBump(from, modules) : undefined;
      if (gate && "wait" in gate) return void log("release bump waits for the reviewer eval", { to, why: gate.wait });
      if (gate) throw Object.assign(new Error(gate.stop), { lasting: true });
      const carries = [...(await o.github.commits(o.productRepo, pinned, to)), ...(from && from !== modules ? await o.github.commits(o.modulesRepo, from, modules) : [])];
      const source = `release:instance:${to}`;
      const task = await o.kernel("POST", "/v1/tasks", {
        title: "Pin bump: this instance's product and modules", role: "platform-engineer", source,
        description: trainDescription({ target: "instance", what: `Moves this instance's product pin (\`product:\` in ${o.instanceRepo}'s instance.yaml) to the newest green commit of ${o.productRepo}'s main, and its official modules to the commit that product pins, as one apply.`, carries, windowMinutes: o.windowMinutes, marker: source }),
      });
      // The edit is made on instance.yaml as it is at the head the commit builds on, never on the text read above.
      const edit = (t: string) => {
        try {
          return bumpInstance(t, { product: to, modules, official: "aidenhq" });
        } catch (e) {
          throw Object.assign(new Error(`instance.yaml can't be bumped in place: ${(e as Error).message}`), { lasting: true });
        }
      };
      edit(text); // refused before a task is filed for it
      const sha = await o.commit(o.instanceRepo, "instance.yaml", edit, `chore: product ${to.slice(0, 8)} + modules ${modules.slice(0, 8)} (${task.identifier})\n\nWritten by the code host's release train; no agent wrote it.`);
      s.filing = { to, sha, task: task.id, identifier: task.identifier };
      save(s);
    }
    const f = s.filing;
    // The kernel's refusal (its rules, the grant) is lasting; anything else is tried again next poll with the same commit.
    const r = await o.kernel("POST", "/v1/writes", { kind: "kernel.apply", args: { repo: o.instanceRepo, branch: `fleet/release-${f.identifier.toLowerCase()}`, sha: f.sha }, task: f.task })
      .catch((e: Error) => { throw Object.assign(e, { lasting: /answered (403|422)\b/.test(e.message) }); });
    s.flight = { to, record: r.id, task: f.task, identifier: f.identifier };
    delete s.filing;
    delete s.open;
    log("release bump filed", { task: f.identifier, to, record: r.id, tier: r.tier });
  }

  async function step() {
    const s = load();
    try {
      if (s.flight) await follow(s);
      const instance = await o.github.text(o.instanceRepo, "instance.yaml");
      const pinned = /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(instance ?? "")?.[1];
      const { tip, green } = await o.github.tip(o.productRepo);
      const d = trainStep({ tip, green, pinned, lastTried: s.lastTried, open: s.open, flight: s.flight, now: now().toISOString(), windowMinutes: o.windowMinutes });
      if (d.do === "open") s.open = { since: now().toISOString() };
      else if (d.do === "close") delete s.open;
      else if (d.do === "file" || s.filing) {
        try {
          await fileBump(s, s.filing?.to ?? tip!, pinned!, instance!);
        } catch (e) {
          if (!(e as { lasting?: boolean }).lasting) throw e;
          // Refused for good (the rules, the eval, the edit): said on the bump's task if it has one; the next merge files the next.
          if (s.filing) await close(s.filing.task, "done", `**Not filed:** ${(e as Error).message.slice(0, 1000)}`);
          log("release bump refused", { to: tip, err: (e as Error).message.slice(0, 300) });
          s.lastTried = s.filing?.to ?? tip;
          delete s.filing;
          delete s.open;
        }
      }
    } finally {
      save(s);
    }
  }
  return {
    step,
    start(everyMs = 60_000) {
      let busy = false;
      const tick = () => { if (busy) return; busy = true; step().catch((e: Error) => log("release train step failed", { err: e.message.slice(0, 300) })).finally(() => { busy = false; }); };
      setInterval(tick, everyMs).unref();
      tick();
    },
  };
}
