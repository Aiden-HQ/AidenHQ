// A module's setup secrets from the board (guided setup): a ready admin pastes a value for a secret the module declared with
// `setup:` (compile: config/kernel/modules.json `setup`), the kernel writes it to the vault under the declared name and
// recreates that module's own compose services (`services`) so they read it. The caller names only the module and the
// secret; never a path or a service. Values are never logged, echoed or put on a command line.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SetupField } from "./admin.ts";
import { fail } from "./proxy.ts";

/** A value the owner gave for a declared field: trimmed, 300 characters at most, matching its anchored pattern. */
export const secretFits = (f: SetupField, value: string) => value.length > 0 && value.length <= 300 && new RegExp(f.pattern).test(value);

/** Writes a secret into the vault view `dir` as a new 0600 file renamed into place (/setup and save_secret). */
export const vaultWriter = (dir: string) => (name: string, value: string) => {
  const f = path.join(dir, name), tmp = `${f}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
  renameSync(tmp, f);
};

export type ModuleSecrets = ReturnType<typeof createModuleSecrets>;

export function createModuleSecrets(deps: {
  fields: () => SetupField[];
  /** An enabled module's compose services; undefined for a module that is off. */
  services: (module: string) => string[] | undefined;
  save: (name: string, value: string) => void;
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
  // One recreate per module at a time that hasn't taken the lock yet: saves arriving while it waits (an apply running, a
  // second paste) join it, since it reads the files only after the lock; a save after that starts the next one.
  const waiting = new Map<string, Promise<void>>();
  const recreate = (module: string, services: string[]) => {
    const joined = waiting.get(module);
    if (joined) return joined;
    const p = deps.recreate(services, () => { if (waiting.get(module) === p) waiting.delete(module); });
    waiting.set(module, p);
    void p.catch(() => {}).finally(() => { if (waiting.get(module) === p) waiting.delete(module); });
    return p;
  };
  return {
    async save(module: string, secret: string, raw: string): Promise<{ restarted: string[] }> {
      const services = on(module);
      const field = deps.fields().find((f) => f.module === module && f.secret === secret);
      if (!field) throw fail(400, "bad_request", "this module asks for no such secret");
      const value = raw.trim();
      if (!secretFits(field, value)) throw fail(400, "bad_request", `that doesn't look like a ${field.label}`);
      // Written first, so the last value saved is the one every later recreate reads.
      deps.save(field.secret, value);
      try {
        if (services.length) await recreate(module, services);
      } catch (e) {
        deps.log("module secret saved; recreate failed", { module, secret: field.secret, err: String((e as Error).message).slice(0, 300) });
        throw fail(502, "bad_gateway", `saved, but its services didn't restart: ${String((e as Error).message).slice(0, 300)}`);
      }
      deps.log("module secret saved", { module, secret: field.secret, restarted: services });
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
 * ops/apply-config.sh takes, at its fixed path in the checkout): `flock -w 600` waits for an apply in progress. The compose
 * files are the apply's: COMPOSE_FILE (the checkout's .env sets it), else compose.yaml, compose.modules.yaml and
 * compose.override.yaml when present. Service names are arguments, never shell text. A failure's message is compose's
 * last line. The next apply recreates these services once more (ops/compose-recreate.sh keeps its own record of what
 * each container read).
 */
const LOCKED = "aidenhq: apply lock held";
export function composeRecreate({ dir, composeFile, docker = "docker", flock = "flock", wait = 600 }: { dir: string; composeFile?: string; docker?: string; flock?: string; wait?: number }) {
  return (services: string[], locked: () => void = () => {}) => new Promise<void>((resolve, reject) => {
    const files = composeFile || ["compose.yaml", "compose.modules.yaml", ...(existsSync(path.join(dir, "compose.override.yaml")) ? ["compose.override.yaml"] : [])].join(":");
    const script = `echo '${LOCKED}' >&2; exec "$0" compose up -d --force-recreate --no-deps "$@"`;
    const child = spawn(flock, ["-w", String(wait), path.join(dir, "data", "apply.lock"), "sh", "-c", script, docker, ...services], { cwd: dir, env: { ...process.env, COMPOSE_FILE: files }, stdio: ["ignore", "ignore", "pipe"], timeout: (wait + 300) * 1000 });
    let err = "", held = false;
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-8000);
      if (!held && err.includes(LOCKED)) { held = true; locked(); }
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const last = err.replace(LOCKED, "").trim().split("\n").filter(Boolean).at(-1);
      reject(new Error(last || (held ? `compose exited ${code}` : "the apply lock stayed held")));
    });
  });
}

/**
 * Runs the Paperclip setup (scripts/paperclip-setup.mjs) in the checkout `dir`, detached and under the host's apply lock (it
 * waits for an apply in progress), its output in `log`. The model step calls it once a key works: an install with no key
 * left its agents unverified, and this run checks them (each scoped as soon as Paperclip verifies it). Fire and forget: a
 * failure is in the log, and the next apply runs setup again anyway.
 */
export function agentSetup({ dir, log, node = process.execPath, flock = "flock", wait = 600 }: { dir: string; log: string; node?: string; flock?: string; wait?: number }) {
  return () => {
    mkdirSync(path.dirname(log), { recursive: true });
    const out = openSync(log, "a", 0o600);
    spawn(flock, ["-w", String(wait), path.join(dir, "data", "apply.lock"), node, path.join(dir, "scripts", "paperclip-setup.mjs")], { cwd: dir, detached: true, stdio: ["ignore", out, out] }).unref();
  };
}
