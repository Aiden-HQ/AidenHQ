// kernel.apply (spec §4.4 "Land"): what an apply may land, and its executor. An apply lands one instance commit on the
// instance repo's main (instance.yaml, apps.yaml, handbook additions only) through the code host, then queues an apply on
// this host through ops/aidenhq-apply (a transient user unit, which outlives the kernel restart the apply itself causes).
// Product code and module handbooks change through Engineer PRs; the instance pins the product (`product: <sha>`), so
// upgrading the product is itself an instance change that the owner sees with its commit log.
//
// An apply applies the instance's main as it is when it gets the host's apply lock, so a record is done by the first good
// generation after its mark whose instance commit contains the record's commit (`git merge-base --is-ancestor`): its own
// apply's, or one queued before it. What else that main carries reached it the same ways (another approved kernel.apply,
// apps-mcp's registry edits as their own write records, the owner's pushes), which a manual apply deploys too.
//
// No apply is ever started twice. Each record moves through one row in kernel.db, written in this order:
//   landed  the commit is on the instance's main (the code host's land is idempotent: an already landed commit is a no-op)
//   unit    the launch intent: the unit's name, written BEFORE the launch (the mark, the newest generation before the landing, is
//           written with `landed`)
// A record is launched only from "landed, no intent". From "intent" it is only followed: waited on while its unit is
// loaded (queued or running), and once it is gone (collected when it ends) decided by the generations; with no good one
// containing the commit it failed and is not run again.
// A restart is the normal path (the apply restarts the kernel): writes.ts resumes a claimed kernel.apply here.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { strayFiles } from "../sdk/src/instance-paths.ts";
import { marketplacesOf, OFFICIAL } from "../../scripts/compiler/sources.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";
import { LOCAL_ORG } from "./kinds.ts";
import type { Resolver } from "./net.ts";
import type { Rec } from "./records.ts";

/** instance.yaml's top-level `product:` pin (a full sha), or undefined. */
export function productPin(text: unknown): string | undefined {
  return /^product:[ \t]*["']?([0-9a-f]{40})["']?[ \t]*(?:#.*)?$/m.exec(String(text ?? ""))?.[1];
}

/**
 * How a `product:` move reads to the owner: an upgrade adds commits, a rollback removes them (and says so). undefined when
 * neither pin is an ancestor of the other (diverged): that move is refused.
 */
export function bumpTitle({ from, to, forward, back }: { from?: string; to: string; forward?: boolean; back?: boolean }): string | undefined {
  const s = (x: string) => `\`${x.slice(0, 9)}\``;
  if (!from) return `Product pinned at ${s(to)}`;
  if (forward) return `Product upgrade ${s(from)} → ${s(to)}, adding these commits`;
  if (back) return `Product DOWNGRADE (rollback) ${s(from)} → ${s(to)}, removing these commits`;
}

/** Where the code host reads the commit: its own copy when it made it, else the task's workspace (the record's identifier). */
export type Source = { repo: string; branch: string; sha: string; workspace?: string };
/** The official modules' pin on one side of an apply: the `aidenhq` marketplace's repository and commit, or null without one. */
export type OfficialPin = { repo: string; sha: string } | null;

/**
 * The official modules' pin an instance.yaml sets, read structurally (duplicate keys and a twice-listed marketplace throw):
 * the reviewer code the instance runs comes from there, so the code host's land runs the reviewer-eval gate on its move.
 * Throws for anything but a GitHub repository at a full sha.
 */
export function officialPinOf(text: string): OfficialPin {
  const doc = YAML.parse(text, { uniqueKeys: true }) ?? {};
  const at = marketplacesOf(doc).find((m) => m.name === OFFICIAL)?.at;
  if (!at) return null;
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\.git$/.exec(at.url)?.[1];
  if (!repo || at.path) throw new Error(`the official marketplace isn't a GitHub repository (${at.url})`);
  return { repo, sha: at.sha };
}
/**
 * The official pin's move a change makes, or why it can't be applied: the official modules are the product's modules/, so
 * an `aidenhq` marketplace may only stay as it is or be dropped (a pre-monorepo install's first update); one may never
 * appear (it would bring reviewer code with no eval to judge it), and its texts must read. Fails closed.
 */
export function officialMove(base: string | undefined, head: string | undefined): { from: OfficialPin; to: OfficialPin } | { error: string } {
  if (base === undefined || head === undefined) return { error: `instance.yaml isn't on ${base === undefined ? "the instance's main" : "the commit"}, so the official modules' pin can't be read` };
  try {
    const [from, to] = [officialPinOf(base), officialPinOf(head)];
    if (to && JSON.stringify(from) !== JSON.stringify(to)) return { error: `it ${from ? "moves" : "adds"} an \`aidenhq\` marketplace pin, which would bring the reviewer's code past its eval; the official modules come with the product pin` };
    return { from, to };
  } catch (e) {
    return { error: `the official modules' pin in instance.yaml can't be read (${(e as Error).message.split("\n")[0]!.slice(0, 200)})` };
  }
}
/**
 * What the code host read at the commit, against its merge base with the instance's main: the files it changes, the texts the
 * rules read on both sides (each changed file and instance.yaml; absent where the file isn't) and the diff.
 */
export type Read = { files: string[]; texts: { base: Record<string, string>; head: Record<string, string> }; diff: string; base?: string; main?: string };
/**
 * What an apply's commit changes, as one digest: its files, the texts read on both sides and the diff. The plan binds it into
 * the record's targets; the land re-reads the commit and lands only when it is exactly the same.
 */
export function readDigest(c: Read): string {
  const sorted = (t: Record<string, string>) => Object.entries(t).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify({ files: [...c.files].sort(), base: sorted(c.texts.base), head: sorted(c.texts.head), diff: c.diff })).digest("hex");
}
/** A unit as `systemctl --user show` reads it. */
export type Unit = { loaded: boolean; active: string; sub: string; result: string };
/** One line of generations.jsonl (ops/lib/generations.sh). */
export type Generation = { n: number; instance?: string; health?: string; reason?: string; log?: string; revert_of?: number };
type Outcome = { ok: boolean; text: string };
/** A settings change's commit (settings-change.ts): `files` (path → text, or null to delete) on main while main is still `base`. */
export type Write = { repo: string; base: string; branch: string; files: Record<string, string | null>; message: string };
export type ApplyHost = {
  /** land: `official`, the official modules' pin on both sides, for the code host's reviewer-eval gate. */
  codehost: { read(s: Source): Promise<Read>; land(s: Source & { official: { from: OfficialPin; to: OfficialPin } }): Promise<{ landed: string }>; write(w: Write): Promise<{ sha: string }> };
  /** Queues an apply as `unit` (ops/aidenhq-apply): it waits for any apply running, then applies the instance's main. */
  /** Starts `aidenhq-apply --unit <unit> [args…]` (args: ops/apply-config.sh's, e.g. `--generation <n>` for the Steward's rollback). */
  launch(unit: string, args?: string[]): Promise<void>;
  unit(unit: string): Promise<Unit>;
  generations(): Generation[];
  /** Whether instance commit `commit` contains `sha` (false when either is unknown here). */
  contains(sha: string, commit: string): Promise<boolean>;
  /** The unit's last lines (its journal), for the outcome. */
  tail(unit: string): Promise<string>;
};

/** A failure worth trying again: no answer, a timeout, a 5xx or a 429 (a 4xx is the code host's answer). */
const transient = (e: unknown) => { const st = (e as { status?: number }).status; return st === undefined || st >= 500 || st === 429; };

export function createApply({ db, codehost, launch, unit, generations, contains, tail, log = () => {}, pollMs = 5_000, retryMs = [5_000, 30_000, 120_000], unitWaitMs = 30 * 60_000 }: ApplyHost & {
  db: DatabaseSync; log?: (msg: string, f?: Record<string, unknown>) => void; pollMs?: number;
  /** The waits between tries of a code host call that failed transiently; `unitWaitMs`: how long systemd may stay unreadable. */
  retryMs?: number[]; unitWaitMs?: number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS applies (record TEXT PRIMARY KEY, sha TEXT NOT NULL, landed TEXT, unit TEXT, mark INTEGER)");
  type Row = { record: string; sha: string; landed: string | null; unit: string | null; mark: number | null };
  const get = (id: string) => db.prepare("SELECT * FROM applies WHERE record = ?").get(id) as Row | undefined;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A record this process is already carrying (an approval's run and the start's reconcile can meet): the same promise.
  const inflight = new Map<string, Promise<Outcome>>();
  /** A code host call, tried again after a transient failure (bounded, with backoff). Safe: read is a read, land is idempotent. */
  async function retried<T>(what: string, record: string, fn: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try { return await fn(); } catch (e) {
        if (!transient(e) || n >= retryMs.length) throw e;
        log(`apply: the code host's ${what} failed, trying again`, { record, attempt: n + 1, err: String((e as Error).message).slice(0, 200) });
        await sleep(retryMs[n]!);
      }
    }
  }

  /**
   * The apply's outcome: the first good generation after the mark whose instance contains the commit. While the unit is
   * loaded (queued behind another apply, or running) it is waited on; once it is gone with no such generation, it failed.
   */
  async function follow(row: Row): Promise<Outcome> {
    const sha = row.landed!, short = `\`${sha.slice(0, 9)}\``;
    const known = new Map<string, boolean>();
    const has = async (g: Generation) => {
      if (!known.has(g.instance!)) known.set(g.instance!, await contains(sha, g.instance!));
      return known.get(g.instance!)!;
    };
    const tailed = async () => `\n\n\`\`\`\n${(await tail(row.unit!).catch(() => "")).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-40).join("\n")}\n\`\`\``;
    // An auto-revert's generation is built on the failed instance and so contains the commit too: it never counts.
    const since = () => generations().filter((g) => g.n > (row.mark ?? 0) && g.instance && !g.revert_of);
    const applied = async (): Promise<Outcome | undefined> => {
      for (const g of since()) {
        if (g.health === "good" && (await has(g))) return { ok: true, text: `Applied: generation ${g.n} runs the instance's main at \`${g.instance!.slice(0, 9)}\`, which contains ${short}${g.log ? ` (log ${g.log})` : ""}.` };
      }
    };
    let unread = 0;
    for (;;) {
      const done = await applied();
      if (done) return done;
      let u: Unit;
      try {
        u = await unit(row.unit!);
        unread = 0;
      } catch (e) {
        // systemd unreadable for a moment (a busy user manager, a timeout): never an outcome. Only a systemd that stays
        // unreadable for unitWaitMs fails the record.
        unread ||= Date.now();
        if (Date.now() - unread >= unitWaitMs) throw e;
        log("apply: its unit couldn't be read, trying again", { unit: row.unit, err: String((e as Error).message).slice(0, 200) });
        await sleep(pollMs);
        continue;
      }
      // Loaded and not ended: queued behind another apply or running. (An apply launched before ops/aidenhq-apply ends
      // loaded, active and exited.)
      if (u.loaded && u.active !== "failed" && u.active !== "inactive" && !(u.active === "active" && u.sub === "exited")) {
        await sleep(pollMs);
        continue;
      }
      // Ended: its generation is in the file by now (read after the unit), the one that applied it or the one that failed.
      const ended = await applied();
      if (ended) return ended;
      let last: Generation | undefined;
      for (const g of since()) if (await has(g)) last = g;
      if (last) return { ok: false, text: `**Landed on the instance's main (${short}), but the apply ${last.health === "pending" ? "died" : "failed"}** (generation ${last.n}: ${last.health}${last.reason ? `, ${last.reason}` : ""}${last.log ? `; log ${last.log}` : ""}).${await tailed()}` };
      return { ok: false, text: `**Landed on the instance's main (${short}), but no apply applied it:** its unit ${row.unit} ended (or never started) and no generation since contains it; it is not started again. Run \`aidenhq-apply --wait\` on the host if it is still needed.${await tailed()}` };
    }
  }

  /**
   * An approved, claimed kernel.apply: checked again at the commit, landed, launched once, followed to its end. Run again on a
   * claimed record after a restart, it carries on from its row: never a second launch.
   */
  function execute(r: Rec): Promise<Outcome> {
    if (!inflight.has(r.id)) inflight.set(r.id, carry(r).finally(() => inflight.delete(r.id)));
    return inflight.get(r.id)!;
  }
  async function carry(r: Rec): Promise<Outcome> {
    const a = r.args as { repo: string; branch: string; sha: string; files: string[] };
    db.prepare("INSERT OR IGNORE INTO applies (record, sha) VALUES (?, ?)").run(r.id, a.sha);
    let row = get(r.id)!;
    if (!row.landed) {
      const src: Source = { repo: a.repo, branch: a.branch, sha: a.sha, ...(r.identifier ? { workspace: r.identifier } : {}) };
      // Read, checked and landed as one step, tried again after a transient failure: a land whose answer was lost is read again
      // and found on main.
      const step = await retried("land", r.id, async (): Promise<Outcome | { landed: string }> => {
        const c = await codehost.read(src);
        // Already on main (a land whose answer was lost, or a restart before it was recorded): its diff against its own merge
        // base is empty by then, so the checks below can't be re-read; the approved commit itself is what landed, and main
        // (however far past it) is what the apply applies.
        if (c.base === a.sha) return { landed: a.sha };
        // What lands is what the card showed: the same files, read again from git at the commit, never from the args alone.
        if ([...c.files].sort().join("\n") !== [...a.files].sort().join("\n")) return { ok: false, text: "Not applied: the commit no longer changes the files that were approved; it needs a new approval." };
        // And exactly what was reviewed: every text and the diff, not only the file names.
        if ((r.targets as { content?: unknown })?.content !== readDigest(c)) return { ok: false, text: "Not applied: what the commit changes is no longer exactly what was approved; it needs a new approval." };
        const stray = strayFiles(c.files);
        if (stray.length) return { ok: false, text: `Not applied: it changes files outside the instance config (${stray.join(", ")}).` };
        const official = officialMove(c.texts.base["instance.yaml"], c.texts.head["instance.yaml"]);
        if ("error" in official) return { ok: false, text: `Not applied: ${official.error}.` };
        await codehost.land({ ...src, official });
        return { landed: a.sha };
      });
      if (!("landed" in step)) return step;
      const { landed } = step;
      // The mark is taken with the landing: an apply that already ran by the time this one is launched applied the commit
      // too, and its generation is the outcome (an apply of a commit already applied adds none).
      db.prepare("UPDATE applies SET landed = ?, mark = ? WHERE record = ?").run(landed, generations().reduce((m, g) => Math.max(m, g.n), 0), r.id);
      log("apply landed", { record: r.id, sha: landed });
      row = get(r.id)!;
    }
    if (!row.unit) {
      // One launch per record. It queues behind any apply running (the lock waits).
      const intent = db.prepare("UPDATE applies SET unit = ? WHERE record = ? AND unit IS NULL").run(`aidenhq-apply-${r.id}`, r.id).changes === 1;
      row = get(r.id)!;
      if (intent) {
        await launch(row.unit!);
        log("apply launched", { record: r.id, unit: row.unit, sha: row.landed });
      }
    }
    return follow(row);
  }

  return { execute };
}
export type Applies = ReturnType<typeof createApply>;

const run = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  new Promise<string>((resolve, reject) => execFile(cmd, args, { ...opts, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }, (err, out, errOut) => (err ? reject(new Error(`${cmd} ${args[0]}: ${String(errOut || err.message).trim().slice(0, 500)}`)) : resolve(String(out)))));

/**
 * This host's side of an apply: ops/aidenhq-apply and systemd for the unit, the generations file and the instance checkout, and the code host that owns the instance
 * repo's org for the commit: codehost-local's land for `local/…` (the bare repo on this host), else the codehost-github
 * service (its own key, the one the kernel calls its executor with). One interface; the provider is the only variation.
 */
export function hostApply({ repo, stateDir, instanceDir, resolver, codehost, local }: {
  /** `instanceDir`: the instance checkout the applies move (AIDENHQ_INSTANCE_DIR), where a generation's instance commit is. */
  repo: string; stateDir: string; instanceDir: string; resolver: Resolver; codehost: () => { url: string; key: string } | undefined;
  /** codehost-local, when enabled: the instance repo's bare git dir on this host, its slug, and a job's branch fetched in from its workspace. */
  local: () => { bare: string; repo: string; ingest: (s: Source & { workspace: string }) => Promise<unknown> } | undefined;
}): ApplyHost {
  const provider = (s: { repo: string }): ApplyHost["codehost"] => {
    if (String(s.repo).split("/")[0]!.toLowerCase() !== LOCAL_ORG) return { read: (x) => call<Read>("read", x), land: (x) => call<{ landed: string }>("land", x), write: (x) => call<{ sha: string }>("write", x) };
    const l = local();
    if (!l) throw Object.assign(new Error(`${s.repo} is on this server, but codehost-local isn't enabled here`), { status: 424 });
    return localApply({ bare: l.bare, instanceRepo: l.repo, ingest: l.ingest });
  };
  async function call<T>(op: "read" | "land" | "write", body: Source | Write): Promise<T> {
    const c = codehost();
    if (!c?.key) throw Object.assign(new Error("the GitHub code host (the github module) isn't installed here, so nothing can land on the instance repo"), { status: 424 });
    const url = `${new URL(c.url).origin}/aidenhq/v1/apply/${op}`;
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 180_000, headers: { host: new URL(url).host, authorization: `Bearer ${c.key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 4_000_000) text += d; }).on("end", () => {
          let j: any;
          try { j = JSON.parse(text); } catch { return reject(Object.assign(new Error(`the code host's ${op} answered ${res.statusCode} with no JSON`), { status: res.statusCode })); }
          if ((res.statusCode ?? 500) >= 300) return reject(Object.assign(new Error(String(j?.error ?? `the code host's ${op} answered ${res.statusCode}`).slice(0, 1000)), { status: res.statusCode }));
          resolve(j as T);
        });
      });
      req.on("timeout", () => req.destroy(new Error(`the code host's ${op} didn't answer in 3 minutes`)));
      req.on("error", (e) => { resolver.forget(url); reject(e); });
      req.end(data);
    });
  }
  const genFile = join(stateDir, "generations.jsonl");
  return {
    codehost: { read: (s) => provider(s).read(s), land: (s) => provider(s).land(s), write: (w) => provider(w).write(w) },
    // The same entry point as the owner's shell; the unit is collected when it ends, so none is left loaded.
    launch: async (u, args = []) => void (await run("bash", [join(repo, "ops/aidenhq-apply"), "--unit", u, ...args])),
    async unit(u) {
      const p = Object.fromEntries((await run("systemctl", ["--user", "show", `${u}.service`, "-p", "LoadState,ActiveState,SubState,Result"])).trim().split("\n").map((l) => l.split("=", 2) as [string, string]));
      return { loaded: p.LoadState === "loaded", active: p.ActiveState ?? "", sub: p.SubState ?? "", result: p.Result ?? "" };
    },
    generations: () => (existsSync(genFile) ? readFileSync(genFile, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Generation]; } catch { return []; } }) : []),
    // Exit 0 is yes; 1 (not an ancestor) and every error (a commit this checkout doesn't have) are no: never a false yes.
    contains: (sha, commit) => new Promise((resolve) => execFile("git", ["-C", instanceDir, "merge-base", "--is-ancestor", sha, commit], { timeout: 60_000 }, (err) => resolve(!err))),
    tail: (u) => run("journalctl", ["--user", "-u", `${u}.service`, "-n", "40", "-o", "cat", "--no-pager"]),
  };
}

// `node apply.ts product-pin <instance.yaml>`: the pin, for ops/apply-config.sh (one parser for both). `product-fork`: the
// kernel's fork (product_fork:, spec §6.9b) as "<url> <sha>", or nothing; a malformed one exits 1.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && ["product-pin", "product-fork"].includes(process.argv[2]!)) {
  const text = readFileSync(process.argv[3]!, "utf8");
  if (process.argv[2] === "product-pin") process.stdout.write(productPin(text) ?? "");
  else {
    const { forksOf } = await import("../../scripts/compiler/sources.ts");
    const k = forksOf(YAML.parse(text) ?? {}).find((x) => x.target === "kernel");
    process.stdout.write(k ? `${k.at.url} ${k.at.sha}` : "");
  }
}
