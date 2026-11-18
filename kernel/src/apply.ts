// kernel.apply (spec §4.4 "Land"): what an apply may land, and its executor. An apply lands one instance commit on the
// instance repo's main (instance.yaml, apps.yaml, handbook additions only) through the code host, then runs
// ops/apply-config.sh on this host as a transient user unit, which outlives the kernel restart the apply itself causes.
// Product code and module handbooks change through Engineer PRs; the instance pins the product (`product: <sha>`), so
// upgrading the product is itself an instance change that the owner sees with its commit log.
//
// No apply is ever started twice. Each record moves through one row in kernel.db, written in this order:
//   landed  the commit is on the instance's main (the code host's land is idempotent: an already landed commit is a no-op)
//   unit    the launch intent: the unit's name and the newest generation before it, written BEFORE systemd-run
// A record is launched only from "landed, no intent". From "intent" it is only followed: the unit while systemd still
// has it (RemainAfterExit keeps a finished one loaded, and a loaded name can't be started again), else the first
// generation after the mark that applied this commit (ops/lib/generations.sh); with neither, it failed and is not run again.
// A restart is the normal path (the apply restarts the kernel): writes.ts resumes a claimed kernel.apply here.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { marketplacesOf, OFFICIAL } from "../../scripts/compiler/sources.ts";
import { localApply } from "../../modules/codehost-local/src/apply.ts";
import { LOCAL_ORG } from "./kinds.ts";
import type { Resolver } from "./net.ts";
import type { Rec } from "./records.ts";

// Agents the instance defines itself live in agents/<key>/ (agent.yaml + AGENTS.md); owner/profile.md is how the owner works.
export const APPLY_PATHS = /^(instance\.yaml|apps\.yaml|agents\/[\w.-]+\.md|agents\/[a-z0-9][a-z0-9-]*\/(agent\.yaml|AGENTS\.md|memory\.md)|owner\/profile\.md)$/;

/** Files a change touches outside what apply may land. */
export const strayFiles = (files: string[]) => files.filter((f) => !APPLY_PATHS.test(f));

const HANDBOOK = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/;
const DEFINITION = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/;
/** An agent.yaml that puts its agent in trial (a top-level `trial: true`). */
export function isTrial(text: unknown): boolean {
  try {
    return text != null && YAML.parse(String(text))?.trial === true;
  } catch {
    return false;
  }
}
/** The agent.yaml paths whose content the trial checks need, at the merge base and at the change. */
export const definitionsOf = (files: string[]) => [...new Set(files.map((f) => HANDBOOK.exec(f)?.[1] ?? DEFINITION.exec(f)?.[1]).filter(Boolean))].map((k) => `agents/${k}/agent.yaml`);

/**
 * Agents a change adds that don't start in trial. A new agent always starts read-only ("draft, don't do"), so tap 1 is
 * safe to approve; its write grants come with tap 2, a change to an agent that already exists. `base`/`head`: path → text
 * (undefined when the file isn't there).
 */
export const untrialedNewAgents = (files: string[], base: Record<string, string | undefined>, head: Record<string, string | undefined>) =>
  files.filter((f) => DEFINITION.test(f) && base[f] === undefined && head[f] !== undefined && !isTrial(head[f])).map((f) => DEFINITION.exec(f)![1]!);

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

// The host's apply lock. ops/apply-config.sh opens data/apply.lock, holds it for the whole apply and refuses a second one at
// once with "another apply is running" (ops/lib/apply-lock.sh).
export const APPLY_LOCK = "data/apply.lock";
// flock's -E status for "somebody else holds it", so a probe's other failures stay failures.
const FLOCK_BUSY = 75;

/** Whether another process holds <repo>/data/apply.lock now: a probe that locks the file itself, so a free lock stays free. */
export function applyIsBusy(repoPath: string): Promise<boolean> {
  const lock = join(repoPath, APPLY_LOCK);
  // The entry point creates it before it locks; no file is no apply running (and flock won't open one that isn't there).
  if (!existsSync(lock)) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    execFile("flock", ["-n", "-E", String(FLOCK_BUSY), lock, "true"], (err: (Error & { code?: unknown }) | null) => {
      if (!err) return resolve(false);
      if (err.code === FLOCK_BUSY) return resolve(true);
      reject(new Error(`couldn't check whether ${lock} is held (${err.message})`));
    });
  });
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
 * The official pin's move a change makes, or why it can't be applied: the marketplace may not appear or disappear (the
 * reviewer code would move with no eval to judge it) and its texts must read. Fails closed.
 */
export function officialMove(base: string | undefined, head: string | undefined): { from: OfficialPin; to: OfficialPin } | { error: string } {
  if (base === undefined || head === undefined) return { error: `instance.yaml isn't on ${base === undefined ? "the instance's main" : "the commit"}, so the official modules' pin can't be read` };
  try {
    const [from, to] = [officialPinOf(base), officialPinOf(head)];
    if (Boolean(from) !== Boolean(to)) return { error: `it ${to ? "adds" : "removes"} the official modules' marketplace, which moves the reviewer's code past its eval` };
    return { from, to };
  } catch (e) {
    return { error: `the official modules' pin in instance.yaml can't be read (${(e as Error).message.split("\n")[0]!.slice(0, 200)})` };
  }
}
/**
 * What the code host read at the commit, against its merge base with the instance's main: the files it changes, the texts the
 * rules read on both sides (each changed file, the agent.yaml of each agent it touches, and instance.yaml; absent where the
 * file isn't), the diff, and the graduation card's trial edits (handbook commits since an agent's trial began; "" if none).
 */
export type Read = { files: string[]; texts: { base: Record<string, string>; head: Record<string, string> }; diff: string; trial?: string };
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
export type ApplyHost = {
  /** land: `official`, the official modules' pin on both sides, for the code host's reviewer-eval gate. */
  codehost: { read(s: Source): Promise<Read>; land(s: Source & { official: { from: OfficialPin; to: OfficialPin } }): Promise<{ landed: string }> };
  launch(unit: string, sha: string): Promise<void>;
  unit(unit: string): Promise<Unit>;
  generations(): Generation[];
  busy(): Promise<boolean>;
  /** The unit's last lines (its journal), for the outcome. */
  tail(unit: string): Promise<string>;
};

export function createApply({ db, codehost, launch, unit, generations, busy, tail, log = () => {}, pollMs = 5_000, lockWaitMs = 15 * 60_000 }: ApplyHost & {
  db: DatabaseSync; log?: (msg: string, f?: Record<string, unknown>) => void; pollMs?: number; lockWaitMs?: number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS applies (record TEXT PRIMARY KEY, sha TEXT NOT NULL, landed TEXT, unit TEXT, mark INTEGER)");
  type Row = { record: string; sha: string; landed: string | null; unit: string | null; mark: number | null };
  const get = (id: string) => db.prepare("SELECT * FROM applies WHERE record = ?").get(id) as Row | undefined;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A record this process is already carrying (an approval's run and the start's reconcile can meet): the same promise.
  const inflight = new Map<string, Promise<Outcome>>();

  /** The apply's outcome: the unit while systemd has it, else the generation that applied this commit after the mark. */
  async function follow(row: Row): Promise<Outcome> {
    for (;;) {
      const u = await unit(row.unit!);
      const g = generations().find((x) => x.n > (row.mark ?? 0) && x.instance === row.landed && !x.revert_of);
      const gen = g ? ` (generation ${g.n}: ${g.health}${g.reason ? `, ${g.reason}` : ""}${g.log ? `; log ${g.log}` : ""})` : "";
      const said = async (ok: boolean, head: string) => ({ ok, text: `${head}${gen}.${ok ? "" : `\n\n\`\`\`\n${(await tail(row.unit!).catch(() => "")).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-40).join("\n")}\n\`\`\``}` });
      if (u.loaded && (u.active === "failed" || (u.active === "active" && u.sub === "exited") || u.active === "inactive")) {
        return said(u.result === "success", u.result === "success" ? `Applied: the instance's main is \`${row.landed!.slice(0, 9)}\`` : `**Landed on the instance's main (\`${row.landed!.slice(0, 9)}\`), but the apply failed** (${u.result})`);
      }
      if (!u.loaded) {
        if (g?.health === "good") return said(true, `Applied: the instance's main is \`${row.landed!.slice(0, 9)}\``);
        if (g) return said(false, `**Landed on the instance's main (\`${row.landed!.slice(0, 9)}\`), but the apply ${g.health === "pending" ? "died" : "failed"}**`);
        return { ok: false, text: `**Landed on the instance's main (\`${row.landed!.slice(0, 9)}\`), but whether its apply ran is unknown** (the unit ${row.unit} is gone and no generation applied it): it is not started again. Run ops/apply-config.sh from the owner's shell if it is still needed.` };
      }
      await sleep(pollMs);
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
      const c = await codehost.read(src);
      // What lands is what the card showed: the same files, read again from git at the commit, never from the args alone.
      if ([...c.files].sort().join("\n") !== [...a.files].sort().join("\n")) return { ok: false, text: "Not applied: the commit no longer changes the files that were approved; it needs a new approval." };
      // And exactly what was reviewed: every text and the diff, not only the file names.
      if ((r.targets as { content?: unknown })?.content !== readDigest(c)) return { ok: false, text: "Not applied: what the commit changes is no longer exactly what was approved; it needs a new approval." };
      const stray = strayFiles(c.files);
      if (stray.length) return { ok: false, text: `Not applied: it changes files outside the instance config (${stray.join(", ")}).` };
      const untrialed = untrialedNewAgents(c.files, c.texts.base, c.texts.head);
      if (untrialed.length) return { ok: false, text: `Not applied: a new agent must start in trial (${untrialed.join(", ")}).` };
      const official = officialMove(c.texts.base["instance.yaml"], c.texts.head["instance.yaml"]);
      if ("error" in official) return { ok: false, text: `Not applied: ${official.error}.` };
      const { landed } = await codehost.land({ ...src, official });
      db.prepare("UPDATE applies SET landed = ? WHERE record = ?").run(landed, r.id);
      log("apply landed", { record: r.id, sha: landed });
      row = get(r.id)!;
    }
    if (!row.unit) {
      // One launch per record: another apply holding the lock (an operator's, say) is waited out first, bounded.
      const until = Date.now() + lockWaitMs;
      while (await busy()) {
        if (Date.now() >= until) return { ok: false, text: `**Landed on the instance's main (\`${row.landed!.slice(0, 9)}\`), but not applied:** another apply held ${APPLY_LOCK} for ${Math.round(lockWaitMs / 60_000)} minutes. Its next apply runs it.` };
        await sleep(Math.min(pollMs, 2_000));
      }
      const mark = generations().reduce((m, g) => Math.max(m, g.n), 0);
      const intent = db.prepare("UPDATE applies SET unit = ?, mark = ? WHERE record = ? AND unit IS NULL").run(`aidenhq-apply-${r.id}`, mark, r.id).changes === 1;
      row = get(r.id)!;
      if (intent) {
        await launch(row.unit!, row.landed!);
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
 * This host's side of an apply: systemd for the unit, the generations file, the lock, and the code host that owns the instance
 * repo's org for the commit: codehost-local's land for `local/…` (the bare repo on this host), else the codehost-github
 * service (its own key, the one the kernel calls its executor with). One interface; the provider is the only variation.
 */
export function hostApply({ repo, stateDir, resolver, codehost, local }: {
  repo: string; stateDir: string; resolver: Resolver; codehost: () => { url: string; key: string } | undefined;
  /** codehost-local, when enabled: the instance repo's bare git dir on this host and its slug. */
  local: () => { bare: string; repo: string } | undefined;
}): ApplyHost {
  const provider = (s: Source): ApplyHost["codehost"] => {
    if (String(s.repo).split("/")[0]!.toLowerCase() !== LOCAL_ORG) return { read: (x) => call<Read>("read", x), land: (x) => call<{ landed: string }>("land", x as Source) };
    const l = local();
    if (!l) throw new Error(`${s.repo} is on this server, but codehost-local isn't enabled here`);
    return localApply({ bare: l.bare, instanceRepo: l.repo });
  };
  async function call<T>(op: "read" | "land", body: Source): Promise<T> {
    const c = codehost();
    if (!c?.key) throw new Error("the code host (codehost-github) isn't installed here, so nothing can land on the instance repo");
    const url = `${new URL(c.url).origin}/aidenhq/v1/apply/${op}`;
    const to = await resolver.resolve(url);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 180_000, headers: { host: new URL(url).host, authorization: `Bearer ${c.key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 4_000_000) text += d; }).on("end", () => {
          let j: any;
          try { j = JSON.parse(text); } catch { return reject(new Error(`the code host's ${op} answered ${res.statusCode} with no JSON`)); }
          if ((res.statusCode ?? 500) >= 300) return reject(new Error(String(j?.error ?? `the code host's ${op} answered ${res.statusCode}`).slice(0, 1000)));
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
    codehost: { read: (s) => provider(s).read(s), land: (s) => provider(s).land(s) },
    // RemainAfterExit: the finished unit stays loaded, so its result can be read and its name can't start a second apply.
    launch: async (u, sha) => void (await run("systemd-run", ["--user", `--unit=${u}`, "-p", "RemainAfterExit=yes", `--working-directory=${repo}`, `--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, `--setenv=HOME=${process.env.HOME ?? ""}`, "--", "bash", join(repo, "ops/apply-config.sh"), sha])),
    async unit(u) {
      const p = Object.fromEntries((await run("systemctl", ["--user", "show", `${u}.service`, "-p", "LoadState,ActiveState,SubState,Result"])).trim().split("\n").map((l) => l.split("=", 2) as [string, string]));
      return { loaded: p.LoadState === "loaded", active: p.ActiveState ?? "", sub: p.SubState ?? "", result: p.Result ?? "" };
    },
    generations: () => (existsSync(genFile) ? readFileSync(genFile, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Generation]; } catch { return []; } }) : []),
    busy: () => applyIsBusy(repo),
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
