// A module's setup secrets from the board (guided setup): a ready admin pastes a value for a secret the module declared with
// `setup:` (compile: config/kernel/modules.json `setup`), the kernel writes it to the vault under the declared name and
// recreates (after answering) that module's own compose services (`services`) and every other service that mounts the secret (`mounts`), so
// they read it (a file secret is a bind mount of the old file until its container is recreated). The caller names only the module and the
// secret; never a path or a service. Values are never logged, echoed or put on a command line.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SetupField } from "./admin.ts";
import { fail } from "./proxy.ts";

/** A value the owner gave for a declared field: trimmed, 300 characters at most, matching its anchored pattern. */
export const secretFits = (f: SetupField, value: string) => value.length > 0 && value.length <= 300 && new RegExp(f.pattern).test(value);

/**
 * Writes a secret into the vault view `dir` in place (/setup and save_secret): the same file truncated and written, 0600 when
 * new. Never a rename: a container that bind-mounts the file keeps the old one until it restarts, but sees an in-place write.
 */
export const vaultWriter = (dir: string) => (name: string, value: string) => writeFileSync(path.join(dir, name), value, { mode: 0o600 });

export type ModuleSecrets = ReturnType<typeof createModuleSecrets>;

export function createModuleSecrets(deps: {
  fields: () => SetupField[];
  /** An enabled module's compose services; undefined for a module that is off. */
  services: (module: string) => string[] | undefined;
  /** Every compose service that mounts the secret, any module's. */
  mounts: (secret: string) => string[];
  save: (name: string, value: string) => void;
  /** The vault's value ("" when unset). */
  get: (name: string) => string;
  has: (name: string) => boolean;
  /** Recreates the services; calls `locked` once it holds the apply lock (from then on it may have read the files). */
  recreate: (services: string[], locked: () => void) => Promise<void>;
  log: (msg: string, o: Record<string, unknown>) => void;
}) {
  const on = (module: string) => {
    const services = deps.services(module);
    if (!Array.isArray(services)) throw fail(404, "not_found", "no such module, or it is off");
    return services;
  };
  // One recreate per set of services at a time that hasn't taken the lock yet: saves arriving while it waits (an apply
  // running, a second paste) join it, since it reads the files only after the lock; a save after that starts the next one.
  const waiting = new Map<string, Promise<void>>();
  const recreate = (services: string[]) => {
    const k = services.join(" ");
    const joined = waiting.get(k);
    if (joined) return joined;
    const p = deps.recreate(services, () => { if (waiting.get(k) === p) waiting.delete(k); });
    waiting.set(k, p);
    void p.catch(() => {}).finally(() => { if (waiting.get(k) === p) waiting.delete(k); });
    return p;
  };
  // One key of a JSON-map secret (a module page's secret_maps): read, merged and written in place whole, one at a time so two
  // saves can't lose each other's key. The module reads the map on each use, so nothing restarts.
  const MAP_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
  let mapLock: Promise<unknown> = Promise.resolve();
  const map = (name: string): Record<string, Record<string, string>> => {
    const raw = deps.get(name).trim();
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
    throw fail(409, "conflict", "the stored value isn't a JSON map, so no key is merged into it");
  };
  const mapField = (module: string, secret: string) => {
    on(module);
    const field = deps.fields().find((f) => f.module === module && f.secret === secret);
    if (!field) throw fail(400, "bad_request", "this module asks for no such secret");
    return field;
  };
  return {
    /** The keys a JSON-map secret holds: names only, never a value, and only valid keys (any other text in the file is never echoed). */
    keys(module: string, secret: string): string[] {
      mapField(module, secret);
      return Object.keys(map(secret)).filter((k) => MAP_KEY.test(k));
    },
    /**
     * Sets, replaces (`entry`: one flat object of text values) or clears (`entry` null) one key of the map. `check` sees the entry
     * (as { key: entry }) before anything is written and throws to refuse.
     */
    saveKey(module: string, secret: string, key: string, entry: Record<string, string> | null, check: (only: string) => Promise<void> = async () => {}): Promise<void> {
      const run = async () => {
        const field = mapField(module, secret);
        if (!MAP_KEY.test(key)) throw fail(400, "bad_request", "that isn't a valid key");
        if (entry && (Object.keys(entry).length === 0 || Object.keys(entry).length > 8 || Object.entries(entry).some(([k, v]) => !/^[a-z][a-z0-9_]{0,31}$/.test(k) || typeof v !== "string" || !v || v.length > 300))) throw fail(400, "bad_request", "an entry is up to 8 named, non-empty texts of 300 characters at most");
        // The module's check may take a while: the map is read only after it, right before the synchronous merge and write, so a
        // whole-secret save that landed meanwhile is merged into, never overwritten.
        if (entry) await check(JSON.stringify({ [key]: entry }));
        const current = map(secret);
        if (!entry && !Object.hasOwn(current, key)) return;
        const next = { ...current };
        if (entry) next[key] = entry; else delete next[key];
        const text = JSON.stringify(next);
        if (!new RegExp(field.pattern).test(text)) throw fail(400, "bad_request", `that doesn't look like a ${field.label}`);
        deps.save(secret, text);
        deps.log("module secret key saved", { module, secret, key, cleared: !entry });
      };
      const p = mapLock.then(run, run);
      mapLock = p.catch(() => {});
      return p;
    },
    async save(module: string, secret: string, raw: string): Promise<{ restarted: string[] }> {
      const own = on(module);
      const field = deps.fields().find((f) => f.module === module && f.secret === secret);
      if (!field) throw fail(400, "bad_request", "this module asks for no such secret");
      const value = raw.trim();
      if (!secretFits(field, value)) throw fail(400, "bad_request", `that doesn't look like a ${field.label}`);
      const services = [...new Set([...own, ...deps.mounts(field.secret)])].sort();
      // Written first, so the last value saved is the one every later recreate reads.
      deps.save(field.secret, value);
      // The restart follows the answer: it may wait minutes on the apply lock, and the page must not hang on it.
      if (services.length) {
        recreate(services).catch((e) => deps.log("module secret saved; recreate failed", { module, secret: field.secret, err: String((e as Error).message).slice(0, 300) }));
      }
      deps.log("module secret saved", { module, secret: field.secret, restarting: services });
      return { restarted: services };
    },
    status(module: string): Record<string, boolean> {
      on(module);
      return Object.fromEntries(deps.fields().filter((f) => f.module === module).map((f) => [f.secret, deps.has(f.secret)]));
    },
  };
}

/**
 * Recreates compose services in the checkout `dir` while holding the host's apply lock (data/apply.lock, the one
 * ops/apply-config.sh takes, at its fixed path in the checkout): it waits for the lock however long an apply holds it. The compose
 * files are the apply's: COMPOSE_FILE (the checkout's .env sets it), else compose.yaml, compose.modules.yaml and
 * compose.override.yaml when present. Service names are arguments, never shell text. A failure's message is compose's
 * last line. The next apply recreates these services once more (ops/compose-recreate.sh keeps its own record of what
 * each container read).
 */
const LOCKED = "aidenhq: apply lock held";
export function composeRecreate({ dir, composeFile, docker = "docker", flock = "flock" }: { dir: string; composeFile?: string; docker?: string; flock?: string }) {
  return (services: string[], locked: () => void = () => {}) => new Promise<void>((resolve, reject) => {
    const files = composeFile || ["compose.yaml", "compose.modules.yaml", ...(existsSync(path.join(dir, "compose.override.yaml")) ? ["compose.override.yaml"] : [])].join(":");
    const script = `echo '${LOCKED}' >&2; exec "$0" compose up -d --force-recreate --no-deps "$@"`;
    const child = spawn(flock, [path.join(dir, "data", "apply.lock"), "sh", "-c", script, docker, ...services], { cwd: dir, env: { ...process.env, COMPOSE_FILE: files }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "", held = false;
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
      if (!held && err.includes(LOCKED)) { held = true; locked(); }
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const last = err.replace(LOCKED, "").trim().split("\n").filter(Boolean).at(-1);
      reject(new Error(last || `compose exited ${code}`));
    });
  });
}
