// One-off commands inside a running app (migrations, seeds, backfills): `npm run <script>`, where the script is one the app's
// package.json declares at its deployed commit. The owner approves the exact command on a board card (app_run); the board
// asks apps-mcp to run it. Argv only (no shell), so nothing in a name reaches a shell.
import type { App } from "./registry.js";

/** A package.json script name: lowercase, digits, `:`, `_`, `-`; never a leading `-` (npm would read it as a flag). */
export const SCRIPT = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
/** A compose service name. */
export const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const RUN_TIMEOUT_MS = 600_000;

/** The command `npm run <script>` runs, from the app's package.json (app-authored: shown on the card, never trusted). */
export function scriptCommand(packageJson: string | undefined, script: string): string {
  if (!SCRIPT.test(script)) throw new Error(`bad script name "${script}" (lowercase letters, digits, ':', '_', '-')`);
  if (!packageJson) throw new Error("the app has no package.json at its deployed commit");
  let scripts: unknown;
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
  } catch {
    throw new Error("the app's package.json can't be read");
  }
  const cmd = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>)[script] : undefined;
  if (typeof cmd !== "string") throw new Error(`package.json has no script "${script}" (has: ${Object.keys((scripts as object) ?? {}).join(", ") || "none"})`);
  return cmd;
}

/** The service to run in: the one asked for, else the app's only service, else the one called `app`. */
export function pickService(services: string[], want?: string): string {
  if (want) {
    if (!SERVICE.test(want) || !services.includes(want)) throw new Error(`no service "${want}" (has: ${services.join(", ")})`);
    return want;
  }
  if (services.length === 1) return services[0]!;
  if (services.includes("app")) return "app";
  throw new Error(`the app has several services (${services.join(", ")}): name one`);
}

/** `docker compose … exec` argv: no TTY, npm's cache in /tmp (app rootfs is read-only). `timeout` runs inside the container and
 * kills the script's whole process group at the deadline (killing the docker CLI alone leaves the script running). */
export function runArgv(service: string, script: string, timeoutMs: number): string[] {
  if (!SERVICE.test(service) || !SCRIPT.test(script)) throw new Error("bad service or script name");
  return ["exec", "-T", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_update_notifier=false", service, "timeout", "-k", "10", String(Math.ceil(timeoutMs / 1000)), "npm", "run", script];
}

/** Only the app's owner (its agent key in the registry) may ask; never a role, never the incident path. */
export function assertOwner(app: App, callerKey: string): void {
  if (!callerKey || callerKey !== app.owner) throw new Error(`only ${app.name}'s owner (${app.owner}) can run commands in it`);
}
