// The release train's loop (W3; the runner's runReleases, moved): once a minute, over cached inputs (no GitHub read on the
// timer: instance.yaml read at start and on each push to the instance repo, `refresh`; the product tip and whether it is green
// from the change feed's snapshot of that head, `github.tip`), the instance target's bump decided by
// release.ts trainStep, written by code and filed as a kernel.apply through the kernel's /v1/writes with this module's own
// token (role kernel.apply). The kernel plans it (kernel/src/apply-tier.ts) and tiers it like any apply, with no branch for who
// filed it. Its task is one the kernel
// files for the agent holding the platform-engineer role (POST /v1/tasks, role kernel.tasks), once per tip.
//
// No apply runs twice: the bump's commit is deterministic for the same instance main and pins, the bump being filed is
// written down before it is filed (a restart files the same commit again, which the kernel answers with the same open
// record), and a filed bump is followed by its record until it ends; the executor launches each record once. A bump whose
// written-down state is lost is recovered through the kernel's idempotent task filing (release:instance:<sha>) and the card
// on that task, so a replaced process still settles the task it opened: a failed or unknown card closes it "Not landed".
// A bump filed by a process that is gone (the runner's own ms stamp, or a train that restarted onto a newer tip) is settled by
// a sweep on every poll: it lists the open tasks of the train's source family and acts on each one's newest card, with no
// memory of it at all. The family is the only one it can list or close this way (kernel/src/modtasks.ts).
//
// Only the instance's product pin: the official modules are the product's modules/ (owner, 2026-11-18). The task is filed
// when the bump files (no description updates as merges land), filed quiet so its assignment wakes nobody: the card carries
// the work and the train follows it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinOwner } from "./aidenhq-sdk/pin-owner.ts";
import { bumpInstance, trainDescription, trainStep } from "./release.ts";

export type Commit = { repo: string; sha: string; subject: string };
export type TrainOptions = {
  dir: string; productRepo: string; instanceRepo: string; windowMinutes: number;
  /** The kernel with this module's token: POST /v1/tasks, /v1/tasks/:id/close, /v1/writes; GET /v1/work?task=, /v1/tasks?source=. */
  kernel(method: "GET" | "POST", path: string, body?: unknown): Promise<any>;
  github: {
    /** A repo's default branch head and whether every check on it passed; undefined while not known yet. */
    tip(repo: string): Promise<{ tip?: string; green: boolean } | undefined>;
    /** A file at the default branch's head, undefined when it isn't there. */
    text(repo: string, path: string, at?: string): Promise<string | undefined>;
    commits(repo: string, from: string, to: string): Promise<Commit[]>;
  };
  /** The bump's commit on the instance's main, in this service's cache: `edit` reads the file at the head it builds on. */
  commit(repo: string, path: string, edit: (text: string) => string, message: string): Promise<string>;
  /**
   * Compiles the instance as it stands on its main against product commit `to`, the way the apply stages it (the kernel's
   * /v1/compile/check): `{ok: true}`, or the compiler's first message when the target would refuse it. Throws when the check
   * itself couldn't run (a transient read), which is retried on the next poll, never read as a refusal.
   */
  compile(to: string): Promise<{ ok: true } | { ok: false; error: string }>;
  now?: () => Date; log?: (msg: string, f?: Record<string, unknown>) => void;
};
type State = {
  open?: { since: string };
  /** The bump's task, filed; `sha` once its commit is made. */
  filing?: { to: string; sha?: string; task: string; identifier: string };
  flight?: { to: string; record: string; task: string; identifier: string };
  lastTried?: string;
};
const MOVING = ["review", "owner", "approved", "claimed"];
/** A land refused because main moved on, or the eval still running: that bump is over, and its commits are filed again. */
const REFILE = /moved on since this commit's base|not landed: .*(eval|isn't at)/;

export function createReleaseTrain(o: TrainOptions) {
  const log = o.log ?? (() => {});
  /** instance.yaml as last read (refresh): at start, then on each push to the instance repo. */
  let instanceText: Promise<string | undefined> | undefined;
  const refresh = (at?: string) => { const p = o.github.text(o.instanceRepo, "instance.yaml", at); instanceText = p; p.catch(() => { if (instanceText === p) instanceText = undefined; }); return p; };
  const now = o.now ?? (() => new Date());
  mkdirSync(o.dir, { recursive: true });
  const file = join(o.dir, "release-instance.json");
  const load = (): State => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const save = (s: State) => { writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file); };
  /** A close the kernel refuses answers false, never throws: the bump stays on record and the next poll retries it. */
  const close = async (task: string, status: "done" | "cancelled", body: string) => {
    try { await o.kernel("POST", `/v1/tasks/${task}/close`, { status, body }); return true; }
    catch (e) { log("release task not closed", { task, err: (e as Error).message }); return false; }
  };

  /**
   * The kernel.apply filed on this bump's task: the newest, or the one `id` names. Read from the kernel's work log by task, never
   * from this process's memory, so a card another process filed is followed too. A task holds one source (one bump), so its
   * kernel.apply is that bump's card. A failed read throws; so does a named card the log doesn't have (never silently stranded).
   */
  async function cardOn(task: string, id?: string): Promise<{ id: string; state: string; text: string } | undefined> {
    const work = await o.kernel("GET", `/v1/work?task=${encodeURIComponent(task)}`);
    const r = ((work?.records ?? []) as { id: string; kind: string; state: string; outcome_text?: string | null }[]).find((x) => x.kind === "kernel.apply" && (!id || x.id === id));
    if (!r && id) throw new Error(`no kernel.apply ${id} on ${task}`);
    return r && { id: r.id, state: r.state, text: String(r.outcome_text ?? "").split("\n")[0]!.slice(0, 300) };
  }

  /** A filed bump: over once its card is. A land refused because main moved on, or the eval still running, is filed again. */
  async function follow(s: State) {
    const f = s.flight!;
    const r = await cardOn(f.task, f.record);
    if (!r || MOVING.includes(r.state)) return;
    const retry = r.state === "failed" && REFILE.test(r.text);
    const body = settleBody(r.state, r.text, retry);
    // Only an install closes the task done: every other settled ending leaves the bump not landed, so the task is cancelled.
    // A close the kernel refused leaves the flight entry where it is, so the next poll settles the task rather than abandoning it.
    if (!(await close(f.task, r.state === "done" ? "done" : "cancelled", body))) return;
    log("release bump over", { task: f.identifier, state: r.state, retry });
    if (!retry) s.lastTried = f.to;
    delete s.flight;
  }

  /**
   * A settled bump's note: `retry` (a land refused on a moved base or a running eval) says the same commits are filed again.
   */
  function settleBody(state: string, text: string, retry = false) {
    if (state === "done") return "Applied: this instance runs the bump.";
    const why = state === "rejected" ? "the card was rejected" : state === "failed" || state === "unknown" ? `it was approved but failed: ${text}` : `the card was ${state}`;
    return `**Not landed:** ${why}. ${retry ? "The same commits are filed again as the next bump." : "The next merge to the product files the next bump."}`;
  }

  /**
   * Every poll, whether or not this process has a bump in flight: the open tasks stamped `release:instance:` by any process (this
   * train's 40-hex sha or the runner's old ms stamp), settled by the newest kernel.apply on each. A card still moving is left
   * alone; a task filed by a process that is gone is closed with the note follow() writes, so it never strands. The task in
   * flight is skipped: follow() owns it, and the two must not race to close it.
   */
  async function sweep(skip?: string) {
    const open = await o.kernel("GET", "/v1/tasks?source=release:instance:");
    for (const task of ((open?.tasks ?? []) as { id: string; identifier?: string; status?: string }[])) {
      if (!task.id || task.id === skip) continue;
      // One task's refused read is logged and retried next poll; it never stops the train's own follow and filing.
      try {
        // No card at all: a task filed before its card (the gap between filing the task and filing the apply) or one whose
        // process died in it. Nothing is known about its bump, so it is left open rather than closed as never carded.
        // Any card that has ended settles its task: done, failed, unknown, rejected, and also cancelled (expired, replaced) or stale.
        const r = await cardOn(task.id);
        if (!r || MOVING.includes(r.state)) continue;
        const body = settleBody(r.state, r.text);
        // A close the kernel refuses is logged by close() and retried on the next poll: it never throws the sweep.
        if (await close(task.id, r.state === "done" ? "done" : "cancelled", body)) log("release bump swept", { task: task.identifier ?? task.id, state: r.state });
      } catch (e) {
        log("release bump sweep read failed", { task: task.identifier ?? task.id, err: (e as Error).message.slice(0, 300) });
      }
    }
  }

  /**
   * The bump's task, its commit and its kernel.apply, each written down as soon as it exists: a restart files the same one, and
   * a lasting refusal after the task is filed closes that task (step), never strands it.
   */
  async function fileBump(s: State, to: string, pinned: string, text: string) {
    // The edit is made on instance.yaml as it is at the head the commit builds on, never on the text read in step.
    const edit = (t: string) => {
      try {
        return bumpInstance(t, { product: to });
      } catch (e) {
        throw Object.assign(new Error(`instance.yaml can't be bumped in place: ${(e as Error).message}`), { lasting: true });
      }
    };
    // `adopt`: the bump's task was filed before, by this process (its own file) or one this process replaced (the kernel's
    // idempotent re-file answers `deduplicated`). Either way its card, if any, is on that task.
    let adopt = Boolean(s.filing?.to === to);
    if (!s.filing || s.filing.to !== to) {
      edit(text); // refused before a task is filed for it
      // The target must compile the instance it would pin, before anything is committed or filed: the apply's own staged
      // compile against the target product (#1730). A target that doesn't is never tried again (the next merge files the next
      // attempt, at a target that may compile); a check that couldn't run throws and is retried on the next poll with no state
      // touched, so nothing is closed for a transient failure.
      const compiled = await o.compile(to);
      if (!compiled.ok) {
        log(`release bump not filed: the target product ${to.slice(0, 12)} doesn't compile the instance`, { to, err: compiled.error });
        s.lastTried = to;
        delete s.open;
        return;
      }
      const carries = await o.github.commits(o.productRepo, pinned, to);
      const source = `release:instance:${to}`;
      // Idempotent per source: a restart adopts the task an earlier process filed for this commit instead of opening a second.
      const task = await o.kernel("POST", "/v1/tasks", {
        title: "Pin bump: this instance's product", role: "platform-engineer", source, quiet: true,
        description: trainDescription({ what: `Moves this instance's product pin (\`product:\` in ${o.instanceRepo}'s instance.yaml) to the newest green commit of ${o.productRepo}'s main, as one apply.`, carries, windowMinutes: o.windowMinutes, marker: source }),
      });
      s.filing = { to, task: task.id, identifier: task.identifier };
      adopt ||= Boolean(task.deduplicated);
      save(s);
    }
    const f = s.filing;
    if (!f.sha) {
      f.sha = await o.commit(o.instanceRepo, "instance.yaml", edit, `chore: product ${to.slice(0, 8)} (${f.identifier})\n\nWritten by the code host's release train; no agent wrote it.`);
      save(s);
    }
    // A bump whose task already existed may already have its card: it is followed, never filed a second time. Moving, it is left
    // alone; settled, it settles the task. A card that ended where the same commits are filed again is that bump's end, not one
    // to adopt. A read that fails throws: the next poll retries with the same task, never a second card.
    if (adopt) {
      const had = await cardOn(f.task);
      if (had && !(had.state === "failed" && REFILE.test(had.text))) {
        s.flight = { to, record: had.id, task: f.task, identifier: f.identifier };
        delete s.filing;
        delete s.open;
        log("release bump adopted", { task: f.identifier, to, record: had.id });
        await follow(s);
        return;
      }
    }
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
      // The task follow() is about to settle is skipped by the sweep below, even once follow() has cleared the flight.
      const flown = s.flight?.task;
      if (s.flight) await follow(s);
      // A bump whose task this process never had in hand is still settled: before the train decides whether it has work at all.
      await sweep(flown);
      const instance = await (instanceText ?? refresh());
      // An instance that installs releases (a `release:` key) is the kernel's updater's: the train stays idle.
      if (pinOwner(instance ?? "") !== "train") return;
      const pinned = /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(instance ?? "")?.[1];
      const head = await o.github.tip(o.productRepo);
      if (!head) return;
      const { tip, green } = head;
      const d = trainStep({ tip, green, pinned, lastTried: s.lastTried, open: s.open, flight: s.flight, now: now().toISOString(), windowMinutes: o.windowMinutes });
      if (d.do === "open") s.open = { since: now().toISOString() };
      else if (d.do === "close") delete s.open;
      else if (d.do === "file" || s.filing) {
        try {
          await fileBump(s, s.filing?.to ?? tip!, pinned!, instance!);
        } catch (e) {
          if (!(e as { lasting?: boolean }).lasting) throw e;
          // Refused for good (the rules, the eval, the edit): said on the bump's task if it has one; the next merge files the next.
          // A close that doesn't land keeps the filing, so the next poll says it again instead of leaving the task open.
          if (s.filing && !(await close(s.filing.task, "cancelled", `**Not filed:** ${(e as Error).message.slice(0, 1000)}`))) return;
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
    /** Reads instance.yaml again at the commit a push to the instance repo moved its default branch to. */
    refresh: (at?: string) => refresh(at).then(() => undefined),
    start(everyMs = 60_000) {
      let busy = false;
      const tick = () => { if (busy) return; busy = true; step().catch((e: Error) => log("release train step failed", { err: e.message.slice(0, 300) })).finally(() => { busy = false; }); };
      setInterval(tick, everyMs).unref();
      tick();
    },
  };
}
