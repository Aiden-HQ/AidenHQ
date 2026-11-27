// The two typed write kinds, as the kernel calls them (executor@1, spec §3, §6): `server-manager.patch` and `server-manager.reboot`.
// `plan` reads the host and proposes the exact set; `execute` re-derives it and refuses when the record's hash no longer matches
// (§11.1). Both run one connection per machine, close it in a finally, and never put a key on a command line or in a record.
//
// A reboot for an "ask me first" machine raises to Tier 2 in `plan` (the owner's decision, never the reviewer's), bound to a pending
// id over the boot ID, the kernel and the package set; `execute` re-derives the id and refuses a mismatch, and consent expires 12 h
// after it was granted. A write a run cannot finish is reported to the owner's agent as a task (§13), never retried blind.
import { readMachines, type Machine } from "./config.ts";
import { runPatch, revalidate, StalePatch, type PatchArgs, type PatchOutcome } from "./execute.ts";
import { ConsentStore, inWindow, pendingId, readRebootState, rebootAndProve } from "./reboot.ts";
import { withConnection, type Keys, type SshMachine, type Transport } from "./ssh.ts";
import type { Executor, ExecuteRequest, PlanRequest, PlanResult } from "./aidenhq-sdk/executor.ts";
import { detect, parseOsRelease, parseSimulatedUpgrade } from "./apt.ts";
import { parseDf, READ } from "./status.ts";
import * as apt from "./apt.ts";

type Dict = Record<string, unknown>;

/** What the executor needs from the service: its settings, its key map, the transport, the zone, and how to wake the agent. */
export interface ExecutorDeps {
  machines: () => string;
  keys: () => Keys;
  transport: () => Transport;
  /** The instance's timezone (§12). */
  timeZone: () => string;
  /** The data dir: known_hosts/, the durable slot records, reboot consent. */
  stateDir: string;
  log: (msg: string, f?: Record<string, unknown>) => void;
  /** Files a task for the agent when a run needs a judgement (§13): a failure, a changed key, a stopped service, expired consent. */
  wake: (i: { machine: string; title: string; body: string; source: string }) => Promise<void>;
  /** Files one of the module's kinds itself (a patch's own reboot record), through the kernel with the module's token. */
  file: (kind: "server-manager.patch" | "server-manager.reboot", args: Record<string, unknown>, task?: string) => Promise<{ id: string; tier: number; state: string }>;
  /** A machine's quiet holder task: where its records and their outcomes land. */
  taskFor: (machine: string) => Promise<string>;
}

const target = (m: Machine): SshMachine => ({ name: m.name, address: m.address, port: m.port, user: m.user, key: m.key, expected_fingerprint: m.expected_fingerprint });

function machineOf(list: string, name: unknown): Machine {
  const m = readMachines(list).machines.find((x) => x.name === name);
  if (!m) throw new Error(`no machine called ${String(name)} is saved and enabled`);
  // A machine switched off after its record was filed is not one a queued write may touch: off means off, and the record is reported
  // as such rather than running on a host the owner has taken out of service.
  if (!m.enabled) throw Object.assign(new Error(`${m.name} is switched off: its queued write is dropped, not run`), { code: "machine_off" });
  return m;
}

/** The card's plain words for a patch: what it will install, on which machine, and why the numbers are the ones shown. */
function patchCard(rec: PatchArgs): Record<string, string> {
  const n = rec.packages.length;
  return {
    target: rec.machine,
    sentence: `Installs ${n} ${rec.mode === "security" ? "security update" : "update"}${n === 1 ? "" : "s"} on ${rec.machine}, revalidated and re-derived over SSH at execution.`,
    changes: n ? rec.packages.slice(0, 12).join(", ") + (n > 12 ? `, and ${n - 12} more` : "") : "nothing: the last read found no upgrade left",
    reads: `Re-reads the upgradable set first and refuses if its hash is not ${rec.hash.slice(0, 12)}…; simulates the exact list; checks disk on / and /boot, dpkg's state, held packages, and never a release upgrade.`,
    details: `Kind server-manager.patch. Mode ${rec.mode}. Machine ${rec.machine}, pinned host key ${rec.fingerprint}. Reboot policy: ${rec.reboot_policy}. Package-set hash ${rec.hash}. The packages that actually change are in the outcome.`,
  };
}
type Planned = { name: string; version: string };

/** What `plan` reads for one patch: the list as the host has it now, and the trust anchor it was read over. */
async function planPatch(d: ExecutorDeps, m: Machine, mode: "security" | "full", rebootPolicy: "auto" | "ask"): Promise<{ rec: PatchArgs; list: Planned[]; reboot_needed: boolean }> {
  return withConnection(d.transport(), target(m), d.keys(), async (c, pin) => {
    const os = await c.exec([...READ.osRelease]);
    const fam = detect(parseOsRelease(os.stdout));
    if ("unsupported" in fam) throw Object.assign(new Error(`${m.name}: ${fam.unsupported}`), { code: "unsupported" });
    const sim = await c.exec([...apt.SIMULATE_UPGRADE]);
    const names = [...new Set(parseSimulatedUpgrade(sim.stdout).map((p) => p.name))].sort();
    const policy = names.length ? await c.exec(["apt-cache", "policy", ...names]) : { code: 0, stdout: "", stderr: "" };
    const holds = await c.probe([...READ.holds]);
    const dfRoot = await c.probe([...READ.diskRoot]);
    const dfBoot = await c.probe([...READ.diskBoot]);
    const boot = (await c.exec([...READ.bootId])).stdout.trim();
    const reboot = await c.probe(["test", "-f", "/var/run/reboot-required"]);
    const secStatus = await c.probe([...READ.securityStatus]);
    const fresh = revalidate({ os: os.stdout, policy: policy.stdout, simulated: sim.stdout, holds: holds.code === 0 ? holds.stdout : "", bootId: boot, rebootRequired: reboot.code === 0, freeRootGb: parseDf(dfRoot.stdout).root_free_gb, freeBootGb: parseDf(dfBoot.stdout).boot_free_gb, unattendedUpgrades: false, securityStatus: secStatus.code === 0 ? secStatus.stdout : undefined }, mode);
    if ("unsupported" in fresh) throw Object.assign(new Error(`${m.name}: ${fresh.unsupported}`), { code: "unsupported" });
    const list = fresh.list;
    // §11.3's guard is checked at plan time too, so a card the owner reads already says the disk is short.
    const disk = apt.diskVerdict(fresh.readout.disk, fresh.downloaded_bytes);
    if (!disk.ok) throw Object.assign(new Error(`${m.name}: ${disk.reason}`), { code: "low_disk" });
    const rec: PatchArgs = { machine: m.name, mode, reboot_policy: rebootPolicy, fingerprint: pin.fingerprint, packages: list.map(apt.word), hash: fresh.hash };
    return { rec, list, reboot_needed: fresh.readout.reboot_needed };
  });
}

export function createExecutor(d: ExecutorDeps): Executor {
  const consent = new ConsentStore(d.stateDir);
  // When a run's `apt-get update` moves the set, the replacement record is filed by this side (§11.1): the kernel's re-plan ran
  // before the refresh and cannot see it. The filing is held here until it answers, so the outcome can name the record it filed —
  // one per machine and mode at a time, so an index that keeps moving cannot turn into a chain. It is never *awaited* from the run:
  // the replacement's execute queues on this machine's guard behind the run that filed it, so waiting here would deadlock the queue.
  const filing = new Map<string, Promise<{ ok: true; id: string } | { ok: false; why: string }>>();
  // One write per machine at a time, in this process: a patch and a reboot for the same host must never run at once (both would
  // take the dpkg lock or race the boot ID). A second write waits for the first, then re-derives everything it needs.
  const queues = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(machine: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(machine) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // The queue's tail is a promise that never rejects, so one failed write does not poison the next; the entry is dropped once the
    // queue has drained, so a long-lived service does not keep a promise per machine it ever touched.
    const tail: Promise<unknown> = next.then(() => undefined, () => undefined);
    queues.set(machine, tail);
    void tail.then(() => { if (queues.get(machine) === tail) queues.delete(machine); });
    return next;
  };
  const log = d.log;

  return {
    async plan(req: PlanRequest): Promise<PlanResult> {
      const a = (req.args ?? {}) as Dict;
      if (req.requester?.kind !== "module" || req.requester.module !== "server-manager") throw Object.assign(new Error("only the server-manager service files these kinds"), { code: "filed_by" });
      if (req.kind === "server-manager.patch") {
        const m = machineOf(d.machines(), a.machine);
        const mode = a.mode === "full" ? "full" : a.mode === "security" ? "security" : undefined;
        if (!mode) throw new Error("mode is security or full");
        const { rec } = await planPatch(d, m, mode, m.reboot_policy);
        return { args: rec, targets: { machine: { name: m.name, fingerprint: rec.fingerprint } }, card: patchCard(rec) };
      }
      if (req.kind === "server-manager.reboot") {
        const m = machineOf(d.machines(), a.machine);
        // §6: consent is bound to what the host needs now, and the id is what an approval authorises.
        const st = await withConnection(d.transport(), target(m), d.keys(), (c, pin) => readRebootState(c).then((s) => ({ s, pin })));
        const id = pendingId({ boot_id: st.s.boot_id, kernel: st.s.kernel, reboot_pkgs: st.s.reboot_pkgs });
        // Consent is *not* written here (§6): planning reads the host and cards what it found, but only the kernel's decision that a
        // record runs — `execute`, below — is a consent the scheduler may act on. A card nobody answers, or one rejected, leaves none.
        const args = { machine: m.name, fingerprint: st.pin.fingerprint, pending_id: id, quiet_window: { start: m.quiet_start, end: m.quiet_end }, reboot_policy: m.reboot_policy };
        const card = {
          target: m.name,
          sentence: `Reboots ${m.name} inside its quiet window ${m.quiet_start}–${m.quiet_end}.`,
          changes: `Restarts ${m.name}. A reboot is done only when its boot ID changes, checked within 900 s.`,
          details: `Kind server-manager.reboot. Machine ${m.name}, pinned host key ${st.pin.fingerprint}. Pending reboot ${id.slice(0, 12)}… over boot ID ${st.s.boot_id.slice(0, 8)}…, kernel ${st.s.kernel}. ${st.s.reboot_pkgs.length ? `Packages that asked: ${st.s.reboot_pkgs.slice(0, 8).join(", ")}.` : ""}`,
        };
        // "Ask me first": the owner decides, never the AI reviewer (§6). A window that is not open yet still raises: the record is
        // the owner's yes for that reboot, and execute rechecks the window at the moment it reboots (§11.12). A decision already on
        // record for this exact pending id and pin is that approval — the window's refile resumes it instead of asking a second time.
        const live = consent.decided(m.name, id, st.pin.fingerprint);
        return m.reboot_policy === "ask" && !live
          ? { args, targets: { machine: { name: m.name, pending_id: id } }, card, raise: { tier: 2, reason: `${m.name} is set to ask before it reboots: the owner decides this one`, rule: "reboot-consent" } }
          : { args, targets: { machine: { name: m.name, pending_id: id } }, card };
      }
      throw new Error(`not a server-manager kind: ${req.kind}`);
    },

    async execute(rec: ExecuteRequest): Promise<{ ok: boolean; text: string }> {
      const a = rec.args as Dict;
      if (rec.kind === "server-manager.patch") {
        const m = machineOf(d.machines(), a.machine);
        const args = a as unknown as PatchArgs;
        // A record is for one reboot policy: a machine switched to "ask me first" since it was filed is not one this record may
        // reboot on its own, and one switched to "auto" is not one an approval can still be riding.
        if (args.reboot_policy !== m.reboot_policy) return { ok: false, text: `${m.name}: its reboot policy changed since this record was filed, so nothing was installed. File a new record.` };
        try {
          // §12's one-run-per-machine, across both kinds: a reboot must never land while this host's dpkg is unpacking. The queue is
          // taken before the connection, so the second write waits and then re-derives everything against the state the first left.
          const out = await oneAtATime(m.name, () => withConnection(d.transport(), target(m), d.keys(), async (c, pin) => {
            // §10, the same binding a reboot record gets: a pin that changed since the record was filed is a different identity, and
            // an older approval never patches the host behind a new key. The owner's re-pin is what would make a new record possible.
            if (pin.fingerprint !== args.fingerprint) {
              await d.wake({ machine: m.name, title: `Server Manager: ${m.name} presented a different host key`, body: `${m.name}: this patch's record named ${args.fingerprint}, and the host presented ${pin.fingerprint}. Nothing ran.`, source: `server-manager:host-key:${m.name}` }).catch(() => undefined);
              return { ok: false, machine: m.name, mode: args.mode, fingerprint: pin.fingerprint, hash: args.hash, installed: [], held: [], before: [], after: [], stopped: [], restarted: [], boot_id_before: "", boot_id_after: "", reboot_needed: false, unattended_upgrades: false, disk: { root_free_gb: null, boot_free_gb: null }, needed_gb: 1, refused: "host-key-changed", detail: `the host key changed since this record was filed (filed ${args.fingerprint}, presented ${pin.fingerprint}): nothing ran. Only the owner's re-pin gets past it.` };
            }
            return runPatch(c, m, args);
          }));
          if (out.ok) {
            const text = patchText(out);
            // §6, §11.11: a reboot the run needed files its own record, now — a Tier 0 run inside the window on an "auto" machine, the
            // owner's Tier 2 card on an "ask me first" one. The record is filed from the boot ID this run left, so its pending id is
            // re-derived against a host that has patched but not rebooted.
            if (out.reboot_needed) {
              const task = await d.taskFor(m.name).catch(() => "");
              await d.file("server-manager.reboot", { machine: m.name }, task || undefined)
                .catch((e: Error) => log("the reboot record did not file", { machine: m.name, err: e.message.slice(0, 200) }));
            }
            if (out.stopped.length) {
              await d.wake({ machine: m.name, title: `Server Manager: a service stopped on ${m.name}`, body: `${m.name}'s patch left a service stopped, and it was not restarted: ${out.stopped.join(", ")}. Read the record and report; a service restart is not this module's to do.`, source: `server-manager:service-stopped:${m.name}:${out.hash.slice(0, 12)}` }).catch((e: Error) => log("wake failed", { err: e.message.slice(0, 200) }));
            }
            return { ok: true, text };
          }
          // A refused run (a plan the simulation did not match, a release jump, low disk, a broken dpkg state) is a failure the agent
          // reports, with the numbers: never a silent skip. A changed host key already woke it above, with the two fingerprints, so
          // it is not woken a second time for the same event.
          if (out.refused !== "host-key-changed") await d.wake({ machine: m.name, title: `Server Manager: a patch run stopped on ${m.name}`, body: `${m.name}: ${out.detail ?? "the run stopped"}`, source: `server-manager:patch-failed:${m.name}:${(out.refused ?? "failed")}:${args.hash.slice(0, 12)}` }).catch((e: Error) => log("wake failed", { err: e.message.slice(0, 200) }));
          return { ok: false, text: patchText(out) };
        } catch (e) {
          if (e instanceof StalePatch) {
            // §11.1: stop, and file a new record for what the last read showed. The kernel re-plans before a run, but that re-plan
            // reads the index as it was; only this run's own `apt-get update` sees the newly published version, so the replacement is
            // filed from here, on the machine's holder task, and its id goes into this outcome the way the kernel words its own refile.
            const key = `${m.name}:${args.mode}`;
            let filed = filing.get(key);
            if (!filed) {
              // The filing runs off this run's guard (it is a kernel round trip, not a host command): started here, awaited below
              // with a bound, so the outcome names the record when the kernel answers quickly and still finishes if it does not.
              filed = (async () => {
                try {
                  const task = await d.taskFor(m.name).catch(() => "");
                  const r = await d.file("server-manager.patch", { machine: m.name, mode: args.mode }, task || undefined);
                  log("a stale patch was refiled", { machine: m.name, mode: args.mode, id: r.id, tier: r.tier });
                  return { ok: true as const, id: r.id };
                } catch (err) {
                  const why = String((err as Error).message ?? err).slice(0, 200);
                  log("a stale patch could not be refiled", { machine: m.name, mode: args.mode, err: why });
                  return { ok: false as const, why };
                }
              })();
              filing.set(key, filed);
              // A filed one is remembered five minutes, so an index that keeps moving cannot turn into a chain of records; a failed
              // one is dropped at once, so the next stale run retries rather than being told a replacement was filed when none was.
              void filed.then((r) => {
                if (!r.ok) { if (filing.get(key) === filed) filing.delete(key); return; }
                setTimeout(() => { if (filing.get(key) === filed) filing.delete(key); }, 5 * 60_000).unref?.();
              });
            }
            const done = await Promise.race([filed, new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 5_000))]);
            if (done && done.ok) return { ok: false, text: `${e.message} (hash ${e.actual.slice(0, 12)}…). Filed again as ${done.id} for the set this read showed.` };
            if (done && !done.ok) {
              await d.wake({ machine: m.name, title: `Server Manager: a stale patch could not be refiled on ${m.name}`, body: `${m.name}: the ${args.mode} patch found the set had moved and stopped before installing; its replacement record could not be filed (${done.why}). The next scheduled run follows the set.`, source: `server-manager:refile-failed:${m.name}:${args.mode}:${e.actual.slice(0, 12)}` }).catch(() => undefined);
              return { ok: false, text: `${e.message} (hash ${e.actual.slice(0, 12)}…): nothing was installed, and the replacement record could not be filed, so the agent was woken to file it.` };
            }
            // The kernel has not answered yet: the record is on its way, and the outcome says so rather than claiming an id it has not.
            return { ok: false, text: `${e.message} (hash ${e.actual.slice(0, 12)}…): nothing was installed, and a replacement record is being filed for the set this read showed.` };
          }
          throw e;
        }
      }
      if (rec.kind === "server-manager.reboot") {
        const m = machineOf(d.machines(), a.machine);
        const args = a as unknown as { machine: string; fingerprint: string; pending_id: string; quiet_window: { start: string; end: string }; reboot_policy: "auto" | "ask" };
        // §6: a record is for one policy. A machine switched to "ask me first" after this record was filed is not one a Tier 0
        // record may reboot, and one switched to "auto" is not one an approval can still be riding.
        if (args.reboot_policy !== m.reboot_policy) return { ok: false, text: `${m.name}: its reboot policy changed since this record was filed (${args.reboot_policy} → ${m.reboot_policy}), so nothing was rebooted. File a new record.` };
        // §6: the kernel's decision is what authorises this reboot, so the consent is written here — once the record has actually
        // been decided and claimed — not by `plan`. On an "ask me first" machine only a Tier 2 record is that decision; a lower tier
        // may resume one already on record for this same pending id and pin (the scheduler's window refile), never make one.
        const live = consent.decided(m.name, args.pending_id, args.fingerprint);
        if (m.reboot_policy === "ask" && rec.tier !== 2 && !live) {
          return { ok: false, text: `${m.name}: this machine asks before it reboots, and no owner decision for this reboot is on record, so nothing was rebooted.` };
        }
        consent.decide(m.name, args.pending_id, args.fingerprint, new Date(), live);
        // §10: a changed host key refuses the run before anything else. Both kinds share the machine's queue (§12), so a reboot
        // never starts while a patch on the same host is still installing.
        return oneAtATime(m.name, () => withConnection(d.transport(), target(m), d.keys(), async (c, pin) => {
          if (args.fingerprint !== pin.fingerprint) {
            await d.wake({ machine: m.name, title: `Server Manager: ${m.name} presented a different host key`, body: `${m.name}: this reboot's record named ${args.fingerprint}, and the host presented ${pin.fingerprint}. Nothing ran.`, source: `server-manager:host-key:${m.name}` }).catch(() => undefined);
            return { ok: false, text: `${m.name}: the host key changed since the record was filed (filed ${args.fingerprint}, presented ${pin.fingerprint}): nothing ran. Only the owner's re-pin gets past it.` };
          }
          // §11.12: the state is read first and the clock sampled *after* it, so the consent, the window and the reboot are all judged
          // by a time taken once the reads are done — never by the instant the run started.
          const st = await readRebootState(c);
          const now = new Date();
          const id = pendingId({ boot_id: st.boot_id, kernel: st.kernel, reboot_pkgs: st.reboot_pkgs });
          if (id !== args.pending_id) {
            await d.wake({ machine: m.name, title: `Server Manager: a reboot approval no longer matches on ${m.name}`, body: `${m.name}: this approval was for another reboot (what the host needs now hashes to ${id.slice(0, 12)}…, the record to ${args.pending_id.slice(0, 12)}…), so nothing was rebooted.`, source: `server-manager:consent-mismatch:${m.name}:${args.pending_id.slice(0, 12)}` }).catch(() => undefined);
            return { ok: false, text: `${m.name}: this approval was for another reboot (what the host needs now hashes to ${id.slice(0, 12)}…, the record to ${args.pending_id.slice(0, 12)}…): nothing was rebooted.` };
          }
          // §6: consent expires 12 h after it was granted (the decision, not the plan); a grant recheck comes before the reboot,
          // and it must be the machine the decision was for.
          const granted = consent.check(m.name, args.pending_id, now, args.fingerprint);
          if (!granted.ok) {
            await d.wake({ machine: m.name, title: `Server Manager: a reboot consent was dropped on ${m.name}`, body: `${m.name}: ${granted.reason}`, source: `server-manager:consent-expired:${m.name}:${args.pending_id.slice(0, 12)}` }).catch(() => undefined);
            return { ok: false, text: `${m.name}: ${granted.reason}` };
          }
          // §11.12: the window is rechecked immediately before the reboot. Outside it the approval is not spent or failed: it stays
          // live (12 h at most) and the scheduler files a fresh record when the window opens (§6).
          if (!inWindow(args.quiet_window.start, args.quiet_window.end, now, d.timeZone())) {
            // Not `markFiled`: that is the scheduler's "a record is already filed for this pending id" guard, and marking it here
            // would stop the very refile this deferral is for. The decision alone (12 h from when it was taken, dropped on success)
            // bounds it; the scheduler files the same decision again when the window opens rather than asking the owner twice.
            return { ok: false, text: `${m.name}: outside its quiet window ${args.quiet_window.start}–${args.quiet_window.end} (${d.timeZone()}): the reboot is deferred to the next window, and nothing on the host was touched.` };
          }
          const r = await rebootAndProve(c, { before: st.boot_id, window: args.quiet_window, timeZone: d.timeZone(), at: now });
          if (!r.ok) {
            await d.wake({ machine: m.name, title: `Server Manager: a reboot was not proven on ${m.name}`, body: `${m.name}: ${r.reason}`, source: `server-manager:reboot-failed:${m.name}:${args.pending_id.slice(0, 12)}` }).catch(() => undefined);
            return { ok: false, text: `${m.name}: ${r.reason}` };
          }
          consent.drop(m.name);
          return { ok: true, text: `${m.name} rebooted inside its quiet window ${args.quiet_window.start}–${args.quiet_window.end}: the boot ID changed from ${st.boot_id.slice(0, 8)}… to ${r.boot_id_after.slice(0, 8)}…, which is the proof.` };
        }));
      }
      return { ok: false, text: `not a server-manager kind: ${rec.kind}` };
    },
  };
}

function patchText(o: PatchOutcome): string {
  const lines = [`${o.machine}: ${o.detail ?? "the patch run stopped"}`];
  lines.push(`Pinned host key ${o.fingerprint}. Mode ${o.mode}; package-set hash ${o.hash.slice(0, 12)}…`);
  if (o.stopped.length) lines.push(`STOPPED, not restarted: ${o.stopped.join(", ")}`);
  if (o.restarted.length) lines.push(`Restarted by a maintainer script: ${o.restarted.join(", ")}`);
  if (o.held.length) lines.push(`Held, not upgraded: ${o.held.join(", ")}`);
  if (o.ok) lines.push(`Reboot needed: ${o.reboot_needed ? "yes" : "no"}${o.reboot_needed ? " (a reboot record follows)" : ""}. Boot ID ${o.boot_id_before.slice(0, 8)}… → ${o.boot_id_after.slice(0, 8)}….`);
  return lines.join("\n");
}
