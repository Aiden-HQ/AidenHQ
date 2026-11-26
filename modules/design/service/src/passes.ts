// The apps the UI Reviewer tests (settings.ui_testing) and their passes: startPass is the one function that files a pass (an
// owner's or an agent's request, a deploy, a 24/7 app's next pass: schedule.ts). A pass is a run of kind `pass` in the store and
// one module task for the holder of role `ui-login`, keyed by source `design:pass:<app>:<run>`; one runs per app at a time (the
// store's unique index), and none starts once the app's passes billed its day cap (the kernel's ledger, per UTC day). The job
// tools (jobtools.ts) release a supplied login only to that task while the run is the app's running pass.
import type { PassRow, Store } from "./store.ts";

export const MODES = ["read", "test-write", "any"] as const;
export type Mode = (typeof MODES)[number];
export const DEPTHS = ["scan", "signed-in", "tester"] as const;
export type Depth = (typeof DEPTHS)[number];
export const SCHEDULES = ["on-request", "after-deploy", "always"] as const;
export type Schedule = (typeof SCHEDULES)[number];
/**
 * What a pass does at each spend mode: its depth (a clicking pass is `tester`), how many ranked improvements get a rendered fix,
 * how many clicking passes, and the design review's model when the app names none.
 */
export const SPEND = {
  scan: { depth: "scan", fixes: 0, clicking: 0, design: undefined },
  standard: { depth: "tester", fixes: 3, clicking: 1, design: undefined },
  thorough: { depth: "tester", fixes: 5, clicking: 2, design: "anthropic/claude-opus-5.5" },
} as const satisfies Record<string, { depth: Depth; fixes: number; clicking: number; design: string | undefined }>;
export type Spend = keyof typeof SPEND;
export const MODEL_ROLES = ["design", "fixes", "clicking"] as const;
export const DAY_CAP_MAX = 100;
/** One app in settings.ui_testing.apps, defaults filled in. */
export interface App {
  name: string; url: string; repo?: string; aidenhq_app: boolean; live_mode: Mode;
  schedule: Schedule; day_cap_usd: number; spend: Spend; models: Partial<Record<(typeof MODEL_ROLES)[number], string>>; recording: boolean;
}
export type UiApp = App;
export type Login = { login_url: string; username: string; password: string; totp_secret?: string };
export type Trigger = "request" | "deploy" | "always";

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
/** A TOTP seed: base32 (spaces, dashes and padding allowed), as jobtools.ts totp() reads it. */
const BASE32 = /^[A-Za-z2-7\s=-]+$/;
/** An OpenRouter model id (`~` for its latest alias). */
const MODEL = /^~?[\w.-]+\/[\w.:~-]{1,100}$/;
const rank = (m: Mode) => MODES.indexOf(m);
/** A pass is active this long after it starts, at most (the UI Reviewer's run is 40 minutes; a re-run on unvisited flows fits). */
export const PASS_MS = 2 * 3_600_000;

/**
 * The most a pass on this app may do. An AidenHQ app is read-only whatever its `live_mode` says (owner, 2026-11-26): its
 * sessions never carry test-write or any. Every other app's ceiling is its own `live_mode`.
 */
export const ceiling = (a: App): Mode => (a.aidenhq_app ? "read" : a.live_mode);

/** settings.ui_testing ({ apps: [...] }) as the service got it: the valid apps, defaults filled in, and one error per entry it skipped (naming the field). */
export function readApps(raw: string | undefined): { apps: App[]; errors: string[] } {
  let v: unknown;
  try { v = JSON.parse(raw || "{}"); } catch { return { apps: [], errors: ["ui_testing isn't JSON"] }; }
  const given = v && typeof v === "object" ? (v as { apps?: unknown }).apps : undefined;
  if (given !== undefined && !Array.isArray(given)) return { apps: [], errors: ["apps is a list of { name, url, repo?, aidenhq_app?, live_mode, schedule, day_cap_usd, spend, models, recording }"] };
  const list = (given ?? []) as unknown[];
  const apps: App[] = [], errors: string[] = [];
  for (const [i, e] of list.entries()) {
    const a = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const name = String(a.name ?? ""), url = String(a.url ?? "");
    const mode = (a.live_mode ?? "read") as Mode, schedule = (a.schedule ?? "on-request") as Schedule, spend = (a.spend ?? "standard") as Spend;
    const cap = a.day_cap_usd ?? 5, models = (a.models ?? {}) as Record<string, unknown>;
    const why = !NAME.test(name) ? "name is lowercase letters, digits and -, 2-31 long, starting with a letter"
      : apps.some((x) => x.name === name) ? `${name} is listed twice`
      : !/^https?:\/\//.test(url) || !URL.canParse(url) ? "url is an http(s) address"
      : a.repo !== undefined && !REPO.test(String(a.repo)) ? "repo is owner/name"
      : a.aidenhq_app !== undefined && typeof a.aidenhq_app !== "boolean" ? "aidenhq_app is true or false"
      : !MODES.includes(mode) ? `live_mode is one of ${MODES.join(", ")}`
      : !SCHEDULES.includes(schedule) ? `schedule is one of ${SCHEDULES.join(", ")}`
      : typeof cap !== "number" || !Number.isFinite(cap) || cap < 0 || cap > DAY_CAP_MAX ? `day_cap_usd is a number from 0 to ${DAY_CAP_MAX}`
      : !Object.hasOwn(SPEND, spend) ? `spend is one of ${Object.keys(SPEND).join(", ")}`
      : !models || typeof models !== "object" || Array.isArray(models) || Object.entries(models).some(([k, m]) => !(MODEL_ROLES as readonly string[]).includes(k) || typeof m !== "string" || !MODEL.test(m)) ? `models is { ${MODEL_ROLES.map((r) => `${r}?`).join(", ")} }, each an OpenRouter model id`
      : a.recording !== undefined && typeof a.recording !== "boolean" ? "recording is true or false" : "";
    if (why) { errors.push(`apps[${i}]: ${why}`); continue; }
    apps.push({
      name, url, ...(a.repo !== undefined ? { repo: String(a.repo) } : {}), aidenhq_app: a.aidenhq_app === true, live_mode: mode,
      schedule, day_cap_usd: cap as number, spend, models: models as App["models"], recording: a.recording === true,
    });
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
    if (![l.login_url, l.username, l.password].every((x) => typeof x === "string" && x) || (l.totp_secret !== undefined && (typeof l.totp_secret !== "string" || !BASE32.test(l.totp_secret)))) continue;
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
      // By position only: a malformed paste may hold a credential where an app name belongs.
      for (const [i, app] of Object.keys(v).entries()) if (!Object.hasOwn(ok, app)) errors.push({ field: "ui_logins", message: `entry ${i + 1}: needs login_url (an address), username and password, and totp_secret as a base32 seed if any` });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** What the passes ask the kernel, with this module's own token (main.ts). */
export interface PassKernel {
  /** Files the pass's task (POST /v1/tasks): its id and assignee. */
  fileTask: (t: { title: string; description: string; role: string; source: string }) => Promise<{ id: string; agent: string }>;
  /** Closes a task this module filed (POST /v1/tasks/:task/close, cancelled): the dispatcher stops its job. */
  closeTask: (task: string, body: string) => Promise<void>;
  /** The confirmed ledger charges of one UTC day on this module's tasks of a source prefix (GET /v1/work?spend_tasks=&day=). */
  spend: (prefix: string, day: string) => Promise<{ task: string; source: string; cost_usd: number }[]>;
}

export interface PassDeps {
  store: Store;
  apps: () => App[];
  logins: () => Record<string, Login>;
  kernel: PassKernel;
  now?: () => number;
}

export type PassStart = { run: string; task: string } | { refused: "already running"; run: string } | { refused: "cap reached today" | "unknown app" | string };

/** The UTC day of an instant, as the ledger's charges are counted. */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The source prefix of an app's pass tasks (the ledger's spend on them, the reconcile's listing of all with `design:pass:`). */
export const passSource = (app: string) => `design:pass:${app}:`;

export function createPasses(d: PassDeps) {
  const now = d.now ?? Date.now;
  const app = (name: string) => d.apps().find((a) => a.name === name);

  /** What the app's passes billed today (UTC), from the kernel's ledger: the cap's sum, and the page's. */
  async function spentToday(name: string): Promise<number> {
    const rows = await d.kernel.spend(passSource(name), utcDay(now()));
    return Math.round(rows.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;
  }

  /**
   * The one function that files a pass (design_pass_start, a deploy, a 24/7 app's next pass). `depth` defaults from the app's
   * spend mode; `mode` may only narrow the app's ceiling and defaults to it; `model` defaults to the app's design model.
   */
  async function startPass(name: string, why: Trigger, o: { depth?: Depth; mode?: Mode; model?: string } = {}): Promise<PassStart> {
    const a = app(name);
    if (!a) return { refused: "unknown app" };
    const preset = SPEND[a.spend], depth = o.depth ?? preset.depth;
    if (!DEPTHS.includes(depth)) return { refused: `depth is one of ${DEPTHS.join(", ")}` };
    if (o.mode !== undefined && !MODES.includes(o.mode)) return { refused: `mode is one of ${MODES.join(", ")}` };
    const top = ceiling(a);
    if (o.mode && rank(o.mode) > rank(top)) return { refused: `mode ${o.mode} is above ${a.name}'s live_mode (${top}${a.aidenhq_app ? ": AidenHQ apps are read-only" : ""})` };
    const running = d.store.active(a.name);
    if (running) return { refused: "already running", run: running.id };
    let spent: number;
    try { spent = await spentToday(a.name); } catch (e) { return { refused: `today's spend couldn't be read: ${String((e as Error).message).slice(0, 200)}` }; }
    if (spent >= a.day_cap_usd) return { refused: "cap reached today" };
    const mode = o.mode ?? top, model = o.model ?? a.models.design ?? preset.design ?? "the UI Reviewer's own model";
    const started = d.store.startPass({ app: a.name, target: a.url, model, depth, mode, trigger: why });
    if ("running" in started) return { refused: "already running", run: started.running };
    const filed = await file(d.store.pass(started.run)!);
    if ("task" in filed) return { run: started.run, task: filed.task };
    return { refused: filed.refused };
  }

  /**
   * Files (or files again) a pass's task and binds it to the run. The kernel files one task per source, so filing again after a
   * lost answer gets the same task back. A refusal (4xx) ends the run and frees the app; any other failure leaves it to the
   * scheduler, which files it again (schedule.ts reconcile).
   */
  async function file(r: PassRow): Promise<{ task: string } | { refused: string }> {
    const a = app(r.app ?? "");
    if (!a) { d.store.endPass(r.id, "failed", "its app left settings.ui_testing before its task was filed"); return { refused: "unknown app" }; }
    const run = r.id, depth = r.depth as Depth, preset = SPEND[a.spend], source = `${passSource(a.name)}${run}`;
    // The work follows the depth the pass runs at: a scan neither signs in nor clicks; a tester pass clicks at least once.
    const clicking = depth === "tester" ? Math.max(preset.clicking, 1) : 0;
    const prior = d.store.lastQueue(a.name);
    const signIn = depth === "scan" ? "Review the pages a visitor sees; don't sign in."
      : a.aidenhq_app ? `Sign in with \`ui-review login aidenhq --app ${a.name} --out state.json\` (a read-only test-user session) and review the address it prints, not the public url.`
      : `Sign in with \`ui-review login\` (the login ladder in the skill${d.logins()[a.name] ? ": a supplied login is set, `ui-review login supplied --app " + a.name + "`" : ""}).`;
    const models = MODEL_ROLES.filter((m) => a.models[m]).map((m) => `${m} ${a.models[m]}`);
    const description = [
      `A ${depth} UI review pass of the app ${a.name} (${r.trigger}), design run ${run}.`,
      `Target: ${a.url}${a.repo ? ` (repo ${a.repo}: its default branch only, never a PR head)` : ""}.`,
      `Live-app mode: ${r.mode}. Model: ${r.model}.`,
      `Spend: ${a.spend} (${preset.fixes ? `rendered fixes for the top ${preset.fixes} improvements` : "no fixes"}, ${clicking ? `${clicking} clicking pass${clicking > 1 ? "es" : ""}` : "no clicking"}). Models: ${models.length ? models.join(", ") : "the defaults"}.`,
      `Recording: ${a.recording && clicking ? "on (the clicking passes' flows)" : "off"}.`,
      prior && prior.left > 0 ? `Coverage: resume from ${prior.run} (its queue.json has ${prior.left} captures left).` : "Coverage: a new cycle from the first page.",
      signIn,
      `Follow the design.ui-review skill; put the evidence on run ${run} and finish it with design_run_finish.`,
    ].join("\n");
    try {
      const t = await d.kernel.fileTask({ title: `UI review pass: ${a.name} (${depth})`, description, role: "ui-login", source });
      d.store.bindPass(run, t.id, t.agent, source);
      return { task: t.id };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0, words = String((e as Error).message).slice(0, 200);
      if (status >= 400 && status < 500) {
        d.store.endPass(run, "failed", `the pass's task was refused: ${words}`);
        return { refused: `the pass's task was refused: ${words}` };
      }
      return { refused: `the pass's task isn't filed yet (${words}); the scheduler files it again` };
    }
  }

  /**
   * Stops the app's running pass: closes its task (the dispatcher stops a closed task's job) and marks it stopping. The app
   * stays busy until the scheduler sees the job ended (schedule.ts reconcile): the run then ends `stopped`.
   */
  async function stopPass(name: string): Promise<{ stopping: string } | { refused: string }> {
    const r = d.store.active(name);
    if (!r) return { refused: `no pass of ${String(name).slice(0, 40)} is running` };
    if (r.task) await d.kernel.closeTask(r.task, `Stopped from the UI testing page (design run ${r.id}).`);
    d.store.markStopping(r.id);
    return { stopping: r.id };
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

  return { startPass, file, stopPass, spentToday, passFor, app };
}
export type Passes = ReturnType<typeof createPasses>;
