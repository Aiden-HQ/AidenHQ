// Marketplace advisories (spec §6.7, plan unit 4e): notify, never update. The kernel reads the marketplace's advisories.json
// from its head (an advisory published after the pinned marketplace sha is invisible at that sha): once a day and on every
// apply (the compiled catalog changed), read-only. Only that one file is read; module code and pins are never touched.
// An installed module is affected when its pinned sha descends from an `affected` commit and not from `fixed`. Before 5b the
// marketplace is ./modules in the product checkout, so its head is the product's origin default branch; the head ref is
// fetched into refs/aidenhq/advisories (never origin/main, which apply reads). Open advisories show on Settings > Modules;
// high and critical send one owner notice per id, ever (kernel.db). A third-party marketplace's advisories.json is read the same
// way from its own head (fetched into its sources cache repository) and counts only for the modules installed from it.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { neutral } from "./channels.ts";
import { validate } from "./writes.ts";
import { cacheRepo, OFFICIAL, type Fetch } from "../../scripts/compiler/sources.ts";

const SCHEMA = JSON.parse(readFileSync(new URL("../schemas/advisories.json", import.meta.url), "utf8"));
const LOCAL_REF = "refs/aidenhq/advisories";
const DAY = 86_400_000;
export type Open = { id: string; module: string; severity: string; fixed: string; summary: string; url: string };
type File = { advisories: { id: string; module: string; affected: string[]; fixed?: string; severity: string; summary: string; url?: string }[] };

/** An advisory's link: re-parsed, https only, and only characters that can't carry markup (the schema allows no others). */
const link = (u: string | undefined) => {
  if (!u) return "";
  const href = new URL(u).href;
  return /^https:\/\/[A-Za-z0-9.~:/?#@!$&+,;=%_-]+$/.test(href) ? href : "";
};

/** Untrusted text on one line, inside a code span it can't close, and never an HTML comment. */
export const fenced = (s: string) => `\`${neutral(s).replace(/[`\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 300)}\``;

/**
 * The advisories open against the installed shas. `listed`: the modules this marketplace lists (an advisory for any other is
 * ignored, A16); `installed`: module → pinned sha. Throws when the file breaks the schema (the caller ignores it and logs).
 */
export function openAdvisories(listed: string[], file: unknown, installed: Record<string, string>, isAncestor: (a: string, b: string) => boolean): Open[] {
  validate(SCHEMA, file, "advisories.json");
  return (file as File).advisories
    .filter((a) => listed.includes(a.module) && installed[a.module] && a.affected.some((c) => isAncestor(c, installed[a.module]!)) && !(a.fixed && isAncestor(a.fixed, installed[a.module]!)))
    .map((a) => ({ id: a.id, module: a.module, severity: a.severity, fixed: a.fixed ?? "", summary: fenced(a.summary), url: link(a.url) }));
}

const git = (repo: string, args: string[], timeout = 60_000) =>
  new Promise<string>((resolve, reject) => execFile("git", ["-C", repo, ...args], { timeout, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, out) => (e ? reject(e) : resolve(out))));
type Row = { name: string; enabled: boolean; revision?: string; marketplace?: string; source?: { url: string; path: string } };

export function createAdvisories({ db, repo, catalog, ownerLine, log = () => {}, ref = "main", file = "modules/advisories.json", marketplace = "modules/marketplace.json", now = Date.now, fetch }: {
  db: DatabaseSync; repo: string;
  /** The compiled catalog (config/modules.json): enabled modules and the revision they run at. */
  catalog: string;
  /** One line for the owner's channels, handed over once (channels.ts ownerLine). */
  ownerLine: (text: string) => void;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The marketplace's head branch (AIDENHQ_ADVISORY_REF overrides it for a live check). */
  ref?: string; file?: string; marketplace?: string; now?: () => number;
  /** Where third-party marketplaces are fetched (sources.ts hostFetch). */
  fetch?: Fetch;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS advisories (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS advisory_notices (id TEXT PRIMARY KEY, at TEXT NOT NULL);");
  if (!/^[\w][\w./-]{0,200}$/.test(ref)) throw new Error(`advisories: ${ref} isn't a branch name`);
  const isAncestor = async (a: string, b: string) => git(repo, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
  let last = { at: 0, key: "" };

  /** The open advisories of one marketplace's file (read with `g`, its repository), or a thrown error when it is malformed. */
  async function openIn(g: (args: string[]) => Promise<string>, text: string, listed: string[], installed: Record<string, string>) {
    const parsed: unknown = JSON.parse(text);
    validate(SCHEMA, parsed, "advisories.json");
    // Ancestry is asked of git, which is async: the shas are known up front, so ask once each.
    const pairs = new Map<string, boolean>();
    const shas = new Set(Object.values(installed));
    for (const a of (parsed as File).advisories) for (const c of [...a.affected, ...(a.fixed ? [a.fixed] : [])]) for (const s of shas) pairs.set(`${c}:${s}`, await g(["merge-base", "--is-ancestor", c, s]).then(() => true, () => false));
    return openAdvisories(listed, parsed, installed, (a, b) => pairs.get(`${a}:${b}`) === true);
  }

  async function check(): Promise<Open[] | undefined> {
    await git(repo, ["fetch", "-q", "--no-tags", "origin", `+refs/heads/${ref}:${LOCAL_REF}`]).catch((e: Error) => log("advisories: fetch failed; reading the last head", { err: e.message.slice(0, 300) }));
    let text: string, listed: string[], rows: Row[];
    try {
      text = await git(repo, ["show", `${LOCAL_REF}:${file}`]);
      listed = (JSON.parse(readFileSync(join(repo, marketplace), "utf8")).plugins as { name: string }[]).map((p) => p.name);
      rows = (JSON.parse(readFileSync(catalog, "utf8")) as Row[]).filter((m) => m.enabled && /^[0-9a-f]{40}$/.test(m.revision ?? ""));
    } catch (e) {
      log("advisories: nothing read", { err: (e as Error).message.slice(0, 300) });
      return undefined;
    }
    const official = rows.filter((m) => (m.marketplace ?? OFFICIAL) === OFFICIAL);
    const open: Open[] = [];
    try { open.push(...await openIn((a) => git(repo, a), text, listed, Object.fromEntries(official.map((m) => [m.name, m.revision!])))); } catch (e) { log("advisories: the file is malformed; ignored", { err: (e as Error).message }); return undefined; }
    // Third-party marketplaces: each one's head, for the modules installed from it only (A16). No file there is no advisory.
    for (const name of new Set(rows.filter((m) => (m.marketplace ?? OFFICIAL) !== OFFICIAL && m.source && fetch).map((m) => m.marketplace!))) {
      const mine = rows.filter((m) => m.marketplace === name);
      const src = mine[0]!.source!;
      const dir = cacheRepo(src.url, fetch!);
      if (!existsSync(dir)) continue;
      const cred = fetch!.credentialHelper ? ["-c", "credential.helper=", "-c", `credential.helper=${fetch!.credentialHelper}`, "-c", "credential.useHttpPath=true"] : ["-c", "credential.helper="];
      const g = (a: string[]) => git(dir, ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", ...cred, ...a]);
      await g(["fetch", "-q", "--no-tags", "--", src.url, `+HEAD:${LOCAL_REF}`]).catch((e: Error) => log(`advisories: ${name}: fetch failed; reading the last head`, { err: e.message.slice(0, 300) }));
      const t = await g(["show", `${LOCAL_REF}:${posix.join(src.path, "advisories.json")}`]).catch(() => undefined);
      if (t === undefined) continue;
      // Ids are namespaced by marketplace, so one can't shadow another's (or an official) advisory or its notice.
      try { open.push(...(await openIn(g, t, mine.map((m) => m.name), Object.fromEntries(mine.map((m) => [m.name, m.revision!])))).map((o) => ({ ...o, id: `${name}:${o.id}` }))); } catch (e) { log(`advisories: ${name}: the file is malformed; ignored`, { err: (e as Error).message }); }
    }
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM advisories").run();
      for (const o of open) db.prepare("INSERT INTO advisories (id, data) VALUES (?, ?)").run(o.id, JSON.stringify(o));
      for (const o of open.filter((x) => ["high", "critical"].includes(x.severity))) {
        // Recorded before it is queued: a restart or the next read never sends it again.
        if (db.prepare("INSERT OR IGNORE INTO advisory_notices (id, at) VALUES (?, ?)").run(o.id, new Date(now()).toISOString()).changes !== 1) continue;
        ownerLine(`⚠️ **Advisory ${neutral(o.id)}** (${o.severity}) affects the installed ${neutral(o.module)}: ${o.summary}${o.url ? ` <${o.url}>` : ""}. The fix is an ordinary update (a newer pin); nothing changed on its own.`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    log("advisories read", { open: open.map((o) => o.id) });
    return open;
  }

  return {
    check,
    /** The open advisories, as the last read left them. */
    list: (): Open[] => (db.prepare("SELECT data FROM advisories ORDER BY id").all() as { data: string }[]).map((r) => JSON.parse(r.data)),
    /** Reads again when a day has passed or an apply rewrote the catalog. */
    async tick() {
      let key = "";
      try { const s = statSync(catalog); key = `${s.mtimeMs}:${s.size}`; } catch {}
      if (key === last.key && now() - last.at < DAY) return;
      last = { at: now(), key };
      await check().catch((e: Error) => log("advisories: check failed", { err: e.message.slice(0, 300) }));
    },
  };
}
export type Advisories = ReturnType<typeof createAdvisories>;
