import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.js";
import { type Db, openDb } from "./db/db.js";
import { MeetingService } from "./meetings/service.js";
import type { PaperclipApi } from "./paperclip/api.js";
import { HttpPaperclipApi } from "./paperclip/http.js";
import { TaskService } from "./paperclip/tasks.js";
import { Router } from "./routing/routing.js";
import { SourceStore } from "./sources/store.js";
import { TranscriptScanner } from "./sources/transcripts.js";
import type { Logger } from "./util/log.js";
import { KnowledgeBases } from "./knowledge/knowledge.js";
import { canonicalNotePath } from "./render/notes.js";
import { resolveVaultPath } from "./util/paths.js";
import { Vault } from "./vault/vault.js";
import { VoiceGuide } from "./voice/voice.js";

export interface App {
  cfg: Config;
  db: Db;
  vault: Vault;
  knowledge: KnowledgeBases;
  meetings: MeetingService;
  voice: VoiceGuide;
  paperclip?: PaperclipApi;
  log: Logger;
}

export function paperclipFromConfig(cfg: Config, log: Logger): PaperclipApi | undefined {
  const { company_id, api_key_file, base_url } = cfg.paperclip;
  if (!company_id || !api_key_file) {
    log.warn("paperclip.company_id / api_key_file not set: tasks are queued locally until configured");
    return undefined;
  }
  if (!existsSync(api_key_file)) {
    log.warn({ api_key_file }, "Paperclip API key file missing: tasks are queued locally");
    return undefined;
  }
  const key = readFileSync(api_key_file, "utf8").trim();
  if (!key) {
    log.warn("Paperclip API key file is empty: tasks are queued locally until scripts/paperclip-setup.ts runs");
    return undefined;
  }
  return new HttpPaperclipApi(base_url, company_id, key);
}

export function createApp(cfg: Config, log: Logger, overrides: { db?: Db; paperclip?: PaperclipApi | null; now?: () => number } = {}): App {
  const db = overrides.db ?? openDb(cfg.data.db_path);
  const paperclip = overrides.paperclip === null ? undefined : (overrides.paperclip ?? paperclipFromConfig(cfg, log));
  const store = new SourceStore(db);
  const scanner = new TranscriptScanner(cfg, store, overrides.now);
  const vault = new Vault(cfg.vault);
  const router = new Router(cfg, db, vault);
  const tasks = new TaskService(db, paperclip, log);
  const meetings = new MeetingService(cfg, db, store, scanner, vault, router, tasks, log);
  return { cfg, db, vault, knowledge: new KnowledgeBases(cfg.knowledge), meetings, voice: new VoiceGuide(cfg, vault, log, overrides.now), paperclip, log };
}

export async function healthChecks(app: App): Promise<{ ok: boolean; state?: "missing"; detail?: string; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    app.db.exec("CREATE TABLE IF NOT EXISTS _health (ts TEXT); DELETE FROM _health; INSERT INTO _health VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));");
    checks.sqlite_writable = { ok: true };
  } catch (err) {
    checks.sqlite_writable = { ok: false, detail: String(err) };
  }
  const roots = app.cfg.transcripts.roots.map((r) => {
    try {
      accessSync(r, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  checks.transcripts_readable = { ok: roots.every(Boolean), detail: roots.every(Boolean) ? undefined : "one or more transcript roots unreadable" };
  // A configured write root is what makes the vault real: the image creates an empty /vault itself (Dockerfile), so
  // the root existing says nothing. vault_available is the first write root usable; vault_writable is every write root
  // usable. Usable means a directory this process can write to and search (a rw-only directory cannot be traversed).
  // `mounted` says a vault folder was mounted at all: the compile mounts each VAULT_FOLDERS entry as /vault/<folder>, so
  // only an empty root is the image's own. A root that cannot be listed is a broken vault, never an unset one.
  const writePath = (dir: string) => join(app.cfg.vault.root, dir);
  const usable = (dir: string) => {
    try {
      if (!statSync(writePath(dir)).isDirectory()) return false;
      accessSync(writePath(dir), constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const unwritable = app.cfg.vault.write_roots.filter((dir) => !usable(dir));
  let rootEntries: string[] | undefined;
  let rootError: string | undefined;
  try {
    rootEntries = readdirSync(app.cfg.vault.root);
  } catch (err) {
    rootError = (err as NodeJS.ErrnoException).code ?? String(err);
  }
  const mounted = rootEntries !== undefined && rootEntries.length > 0;
  const first = app.cfg.vault.write_roots[0]!;
  const firstUsable = usable(first);
  // A root that can be traversed but not listed is still broken: the error is reported even when the known children pass.
  const rootProblem = rootError ? `vault root ${app.cfg.vault.root} cannot be listed: ${rootError}` : undefined;
  checks.vault_available = {
    ok: firstUsable && !rootProblem,
    detail: firstUsable && !rootProblem ? undefined : [rootProblem, firstUsable ? undefined : `not usable: ${first}`].filter(Boolean).join("; "),
  };
  // New canonical meeting notes are written under meetings_root, and publishing reads the note before it writes it
  // (Vault.exists, then createNote). Resolve the path exactly as publishing does, through both root sets, so this agrees
  // with it on a trailing slash and on a symlink out of the roots.
  const meetingsRoot = app.cfg.vault.meetings_root;
  const canonicalVault = new Vault(app.cfg.vault);
  // The note publishing would write now, built by the same function: its year/month folder is the one that has to take
  // writes, and an old read-only archive must not fail health.
  const canonicalProblem = (() => {
    let canonicalPath: string;
    try {
      // Building the path formats the configured timezone: a mistyped one throws here, and health must name it rather than 500.
      const now = new Date().toISOString();
      canonicalPath = canonicalNotePath(meetingsRoot, {
        calendar_event_id: "health-check",
        title: "Health check",
        start_at: now,
        end_at: now,
        timezone: app.cfg.timezone,
        attendees: [],
      });
    } catch (err) {
      return `canonical notes under ${meetingsRoot} have no path: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      canonicalVault.exists(canonicalPath);
    } catch (err) {
      return `canonical notes under ${meetingsRoot} cannot be read: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      // createNote makes the missing year/month folders, so the nearest existing ancestor is what has to take writes.
      let dir = dirname(resolveVaultPath(app.cfg.vault.root, canonicalPath, app.cfg.vault.write_roots).abs);
      for (;;) {
        let st: ReturnType<typeof lstatSync> | undefined;
        try {
          st = lstatSync(dir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (st) {
          // A symlink here resolves to a directory, or is dangling and cannot be written through.
          const target = st.isSymbolicLink() ? statSync(dir) : st;
          if (!target.isDirectory()) return `canonical notes under ${meetingsRoot} cannot be written: ${dir} is not a directory`;
          break;
        }
        if (dirname(dir) === dir) throw new Error(`no existing folder above ${dir}`);
        dir = dirname(dir);
      }
      accessSync(dir, constants.W_OK | constants.X_OK);
      return undefined;
    } catch (err) {
      return `canonical notes under ${meetingsRoot} cannot be written: ${err instanceof Error ? err.message : String(err)}`;
    }
  })();
  const writableProblems = [
    ...(unwritable.length ? [`not writable: ${unwritable.join(", ")}`] : []),
    ...(canonicalProblem ? [canonicalProblem] : []),
  ];
  checks.vault_writable = { ok: writableProblems.length === 0, detail: writableProblems.length ? writableProblems.join("; ") : undefined };
  // Optional: reported, never required.
  const bases = app.knowledge.names();
  checks.knowledge_bases = { ok: bases.length > 0, detail: bases.length ? bases.join(", ") : "none mounted (KNOWLEDGE_BASES)" };
  if (app.paperclip) {
    checks.paperclip_api = { ok: await app.paperclip.ping() };
  } else {
    checks.paperclip_api = { ok: false, detail: "not configured" };
  }
  const required = ["sqlite_writable", "transcripts_readable", "vault_available", "vault_writable"];
  const ok = required.every((k) => checks[k]?.ok);
  // A 503 names which required check failed and why; the board and the kernel read only this top-level detail.
  const failed = required.filter((k) => !checks[k]?.ok);
  const failures = failed.map((k) => `${k}: ${checks[k]?.detail ?? "failed"}`).join("; ");
  // No vault mounted at all (VAULT_FOLDERS empty in the host's .env) while the rest works: not set up yet (state "missing"),
  // which the apply's live agent check notes rather than fails. A vault that is mounted but has no usable write root (an
  // unwritable folder, or VAULT_FOLDERS naming folders write_roots does not) stays a named failure.
  const unset = !ok && rootProblem === undefined && !mounted && checks.sqlite_writable.ok && checks.transcripts_readable.ok;
  const detail = ok ? undefined : unset ? `vault not configured (set VAULT_DIR and VAULT_FOLDERS in .env); ${failures}` : failures;
  return { ok, ...(unset ? { state: "missing" as const } : {}), ...(detail ? { detail } : {}), checks };
}
