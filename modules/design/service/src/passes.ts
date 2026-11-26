// The apps the UI Reviewer tests (settings.ui_testing) and their passes: startPass is the one function that files a pass (an
// owner's or an agent's request now, phase 3's scheduler later). A pass is a run of kind `pass` in the store and one module task
// for the holder of role `ui-login`, keyed by source `design:pass:<app>:<run>`; the job tools (jobtools.ts) release a supplied
// login only to that task while the run is the app's running pass.
import type { PassRow, Store } from "./store.ts";

export const MODES = ["read", "test-write", "any"] as const;
export type Mode = (typeof MODES)[number];
export const DEPTHS = ["scan", "signed-in", "tester"] as const;
export type Depth = (typeof DEPTHS)[number];
export interface App { name: string; url: string; repo?: string; aidenhq_app: boolean; live_mode: Mode }
export type Login = { login_url: string; username: string; password: string; totp_secret?: string };

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const rank = (m: Mode) => MODES.indexOf(m);
/** A pass is active this long after it starts, at most (the UI Reviewer's run is 40 minutes; a re-run on unvisited flows fits). */
export const PASS_MS = 2 * 3_600_000;
export const WAITS_FOR_PR2 = "signed-in review of AidenHQ apps waits for the owner's decision on test-user sessions";

/**
 * The most a pass on this app may do. An AidenHQ app is read-only whatever its `live_mode` says (owner, 2026-11-26): its
 * sessions never carry test-write or any. Every other app's ceiling is its own `live_mode`.
 */
export const ceiling = (a: App): Mode => (a.aidenhq_app ? "read" : a.live_mode);

/** settings.ui_testing ({ apps: [...] }) as the service got it: the valid apps, and one error per entry it skipped. */
export function readApps(raw: string | undefined): { apps: App[]; errors: string[] } {
  let v: unknown;
  try { v = JSON.parse(raw || "{}"); } catch { return { apps: [], errors: ["ui_testing isn't JSON"] }; }
  const list = v && typeof v === "object" && Array.isArray((v as { apps?: unknown }).apps) ? (v as { apps: unknown[] }).apps : [];
  const apps: App[] = [], errors: string[] = [];
  for (const [i, e] of list.entries()) {
    const a = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const name = String(a.name ?? ""), url = String(a.url ?? "");
    const mode = (a.live_mode ?? "read") as Mode;
    const why = !NAME.test(name) ? "name is lowercase letters, digits and -, 2-31 long, starting with a letter"
      : apps.some((x) => x.name === name) ? `${name} is listed twice`
      : !/^https?:\/\//.test(url) || !URL.canParse(url) ? "url is an http(s) address"
      : a.repo !== undefined && !REPO.test(String(a.repo)) ? "repo is owner/name"
      : a.aidenhq_app !== undefined && typeof a.aidenhq_app !== "boolean" ? "aidenhq_app is true or false"
      : !MODES.includes(mode) ? `live_mode is one of ${MODES.join(", ")}` : "";
    if (why) { errors.push(`apps[${i}]: ${why}`); continue; }
    apps.push({ name, url, ...(a.repo !== undefined ? { repo: String(a.repo) } : {}), aidenhq_app: a.aidenhq_app === true, live_mode: mode });
  }
  return { apps, errors };
}

/** The secret ui_logins (a JSON map app → login), read whole on each call; a malformed map or entry counts as no login. Its words never reach an error. */
export function readLogins(raw: string): Record<string, Login> {
  let v: unknown;
  try { v = JSON.parse(raw || "{}"); } catch { return Object.create(null); }
  if (!v || typeof v !== "object" || Array.isArray(v)) return Object.create(null);
  const out: Record<string, Login> = Object.create(null);
  for (const [app, e] of Object.entries(v as Record<string, unknown>)) {
    const l = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    if (![l.login_url, l.username, l.password].every((x) => typeof x === "string" && x) || (l.totp_secret !== undefined && typeof l.totp_secret !== "string")) continue;
    if (!URL.canParse(String(l.login_url))) continue;
    out[app] = { login_url: String(l.login_url), username: String(l.username), password: String(l.password), ...(l.totp_secret ? { totp_secret: String(l.totp_secret) } : {}) };
  }
  return out;
}

/**
 * The module's validate hook (module.yaml `validate:`): settings.ui_testing as readApps reads it, and a pasted ui_logins as
 * readLogins reads it. An error names the app, never a login's value.
 */
export function validate(input: { settings?: Record<string, unknown>; secret?: { name?: string }; value?: string }): { ok: true } | { ok: false; errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];
  if (input.settings && "ui_testing" in input.settings) for (const e of readApps(JSON.stringify(input.settings.ui_testing ?? {})).errors) errors.push({ field: "ui_testing", message: e });
  if (input.secret?.name === "ui_logins") {
    let v: unknown;
    try { v = JSON.parse(input.value || "{}"); } catch { v = undefined; }
    if (!v || typeof v !== "object" || Array.isArray(v)) errors.push({ field: "ui_logins", message: "a JSON map of app name to { login_url, username, password, totp_secret? }" });
    else {
      const ok = readLogins(input.value ?? "");
      for (const app of Object.keys(v)) if (!Object.hasOwn(ok, app)) errors.push({ field: "ui_logins", message: `${app.slice(0, 40)}: needs login_url (an address), username and password, and totp_secret as text if any` });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export interface PassDeps {
  store: Store;
  apps: () => App[];
  logins: () => Record<string, Login>;
  /** Files the pass's task (the kernel's POST /v1/tasks with this module's token): its id and assignee. */
  fileTask: (t: { title: string; description: string; role: string; source: string }) => Promise<{ id: string; agent: string }>;
  now?: () => number;
}

export function createPasses(d: PassDeps) {
  const now = d.now ?? Date.now;
  const app = (name: string) => d.apps().find((a) => a.name === name);

  /** The one function that files a pass. `mode` may only narrow the app's ceiling; it defaults to the ceiling. */
  async function startPass(name: string, why: "request", o: { depth: Depth; mode?: Mode; model?: string }): Promise<{ run: string; task: string } | { refused: string }> {
    const a = app(name);
    if (!a) return { refused: `no app ${String(name).slice(0, 40)} in settings.ui_testing` };
    if (!DEPTHS.includes(o.depth)) return { refused: `depth is one of ${DEPTHS.join(", ")}` };
    if (o.mode !== undefined && !MODES.includes(o.mode)) return { refused: `mode is one of ${MODES.join(", ")}` };
    const top = ceiling(a);
    if (o.mode && rank(o.mode) > rank(top)) return { refused: `mode ${o.mode} is above ${a.name}'s live_mode (${top}${a.aidenhq_app ? ": AidenHQ apps are read-only" : ""})` };
    if (a.aidenhq_app && o.depth !== "scan") return { refused: WAITS_FOR_PR2 };
    const mode = o.mode ?? top, model = o.model ?? "the UI Reviewer's own model";
    const { run } = d.store.startPass({ app: a.name, target: a.url, model, depth: o.depth, mode });
    const source = `design:pass:${a.name}:${run}`;
    const signIn = o.depth === "scan" ? "Review the pages a visitor sees; don't sign in."
      : `Sign in with \`ui-review login\` (the login ladder in the skill${d.logins()[a.name] ? ": a supplied login is set, `ui-review login supplied --app " + a.name + "`" : ""}).`;
    const description = [
      `A ${o.depth} UI review pass of the app ${a.name} (${why}), design run ${run}.`,
      `Target: ${a.url}${a.repo ? ` (repo ${a.repo}: its default branch only, never a PR head)` : ""}.`,
      `Live-app mode: ${mode}. Model: ${model}.`,
      signIn,
      `Follow the design.ui-review skill; put the evidence on run ${run} and finish it with design_run_finish.`,
    ].join("\n");
    try {
      const t = await d.fileTask({ title: `UI review pass: ${a.name} (${o.depth})`, description, role: "ui-login", source });
      d.store.bindPass(run, t.id, t.agent, source);
      return { run, task: t.id };
    } catch (e) {
      d.store.endPass(run, "failed");
      return { refused: `the pass's task wasn't filed: ${String((e as Error).message).slice(0, 200)}` };
    }
  }

  /** Why `source` may not have a login for `name` now ("" when it may): the app's running pass, filed for that task. */
  function passFor(name: string, source: string | null): { run?: PassRow; app?: App; refused: string } {
    const a = app(name);
    if (!a) return { refused: `no app ${String(name).slice(0, 40)}` };
    const m = /^design:pass:([a-z][a-z0-9-]{1,30}):([\w-]{1,40})$/.exec(source ?? "");
    if (!m || m[1] !== a.name) return { refused: `this task isn't the design module's pass for ${a.name}` };
    const run = d.store.pass(m[2]!);
    if (!run || run.app !== a.name || run.source !== source) return { refused: `this task isn't the design module's pass for ${a.name}` };
    if (run.status !== "running" || now() - Date.parse(run.started) > PASS_MS) return { refused: `pass ${run.id} isn't running` };
    return { run, app: a, refused: "" };
  }

  return { startPass, passFor, app };
}
export type Passes = ReturnType<typeof createPasses>;
