// The Settings page's data (web/src/Settings.tsx): read-only views of the compiled config (config/paperclip.yaml, the module
// catalog config/modules.json), the grants table and the live state the board can ask (connection health, sign-ins, the
// model gateway, warehouse sources). Instance settings live in git (instance.yaml): nothing here writes them; a change is
// filed as a task (settings-change.ts). Never a secret: compile leaves secret-looking settings out, and connections are
// shown by name, URL host and tool names only.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EFFORTS, compiledEngine } from "./board.js";

/** The hours a heartbeat may run every (scripts/modules.ts HEARTBEAT_HOURS), and the tools it needs (HEARTBEAT_TOOLS). */
export const HEARTBEAT_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
export const HEARTBEAT_TOOLS = ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"];


export interface SettingDef {
  default?: unknown;
  values?: unknown[];
  required?: boolean;
  /** `url`: the board offers a URL input, checked by services/shared/url-setting.ts (with `host`, when set). */
  type?: string;
  host?: string;
  doc?: string;
  /** An anchored regex a text value must match; `when`: it applies only while these settings hold. */
  pattern?: string;
  when?: Record<string, unknown>;
}
interface CatalogEntry {
  name: string;
  enabled: boolean;
  chosen?: boolean;
  connections?: string[];
  revision?: string;
  settings?: Record<string, SettingDef>;
  setup?: string;
  /** Its own agents' and routines' module.yaml values, before the instance's overrides (scripts/modules.ts). */
  defaults?: { agents?: Record<string, Record<string, unknown>>; routines?: Record<string, Record<string, unknown>> };
}
interface Schedule {
  cron?: string;
  timezone?: string;
  label?: string;
}
interface CompiledRoutine {
  title?: string;
  agent?: string;
  schedules?: Schedule[];
  model?: string;
  status?: string;
  webhook?: boolean;
}
interface CompiledAgent {
  name?: string;
  module?: string;
  /** Set when the instance forked this module agent's handbook (the module blob it was copied from). */
  handbook_fork?: string;
  /** The engine its jobs run on (compile sets it for every agent). */
  engine?: string;
  model?: string;
  models?: string[];
  reasoning_effort?: string;
  heartbeat?: boolean | number | null;
  max_parallel?: number;
  /** A team record (compile's teams): its team's name and member keys. */
  team?: { name: string; members: string[] };
  /** A team member: its team record's key. */
  member_of?: string;
  tier?: string;
  image?: string;
  /** crew, engineer or check (compile sets it for every agent). */
  profile?: string;
  department?: { id: string; name: string; description?: string; order: number };
  roles?: string[];
  enabled_tools?: Record<string, string[]>;
}
export interface Compiled {
  owner_name?: string;
  settings?: Record<string, { value: unknown; set: boolean }>;
  mcp_servers?: Record<string, { url?: string; command?: string; setup?: string; tools?: { read?: string[]; write?: string[]; destructive?: string[] } }>;
  agents?: Record<string, CompiledAgent>;
  routines?: Record<string, CompiledRoutine>;
}
interface GrantsAgent {
  key: string;
  graded?: boolean;
}
export interface Grants {
  agents?: Record<string, GrantsAgent>;
  [setting: string]: unknown;
}

export interface Sources {
  /** config/paperclip.yaml, parsed; null when the board can't read it (not mounted yet). */
  compiled: Compiled | null;
  catalog: CatalogEntry[];
  grants: Grants | null;
  /** The last line of the grants table's revs.jsonl: the last applied change to any agent. */
  lastRev: { at?: string; product_sha?: string; instance_sha?: string } | null;
  boardTimezone: string;
  pendingApprovals: number;
  /** Release updates (kernel/src/updates.ts's display copy, updates.json beside the generations): null when this instance has none. */
  updates?: UpdatesView | null;
}

/** What the release updater recorded (kernel/src/updates.ts writeState), as the board shows it. Display only. */
export interface UpdatesView {
  current: { name: string; product: string } | null;
  auto: boolean | null;
  timezone: string | null;
  checkedAt: string | null;
  available: { name: string; notes: string[]; compare: string } | null;
  error: string | null;
  last: { release: string; outcome: "installed" | "failed"; why?: string; at: string; by: string } | null;
}

/** The updater's display copy; null when there is none (a hand-pinned instance, or an older deploy). */
export function readUpdates(file: string): UpdatesView | null {
  try {
    const u = JSON.parse(readFileSync(file, "utf8")) as UpdatesView;
    return u && typeof u === "object" && u.current ? u : null;
  } catch {
    return null;
  }
}

/** Reads the files Settings needs; each missing file is simply absent (an older deploy). */
export function readSources(files: { compiled?: string; catalog?: string; grants?: string }): Pick<Sources, "compiled" | "catalog" | "grants" | "lastRev"> {
  const text = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
  const compiled = text(files.compiled) ? (parseYaml(text(files.compiled)) as Compiled) : null;
  const catalog = text(files.catalog) ? (JSON.parse(text(files.catalog)) as CatalogEntry[]) : [];
  const grants = text(files.grants) ? (JSON.parse(text(files.grants)) as Grants) : null;
  const last = files.grants ? text(join(dirname(files.grants), "revs.jsonl")).trim().split("\n").at(-1) : "";
  let lastRev = null;
  try {
    lastRev = last ? JSON.parse(last) : null;
  } catch {}
  return { compiled, catalog, grants, lastRev };
}

/** A source with no good pass within its allowance (the security scanner runs daily), or failing with its last good pass over 15 minutes old: the connections view's badge. */
const staleSource = (x: { source: string; last_ok: string | null; failing: boolean }, now: number) => {
  const age = x.last_ok ? now - Date.parse(x.last_ok) : Infinity;
  return age > (x.source === "security" ? 26 * 60 : 60) * 60_000 || (x.failing && age > 15 * 60_000);
};

/** Settings the board, the runner or the gateway re-read per use from the grants table (the rest take an apply to change). */
const LIVE_IN_GRANTS = ["autonomy"];

export function settingsView(s: Sources) {
  const c = s.compiled ?? {};
  const effective = c.settings ?? {};
  const defs = new Map<string, { module: string; def: SettingDef }>();
  for (const m of s.catalog) for (const [k, d] of Object.entries(m.settings ?? {})) if (!defs.has(k)) defs.set(k, { module: m.name, def: d });
  const keys = [...new Set([...defs.keys(), ...Object.keys(effective)])];
  const settings = keys
    .filter((k) => effective[k] !== undefined || s.catalog.find((m) => m.name === defs.get(k)?.module)?.enabled)
    .map((k) => {
      const d = defs.get(k);
      const e = effective[k];
      // What the running system reads now, where the board can see it: the grants table.
      const live = LIVE_IN_GRANTS.includes(k) && s.grants && typeof s.grants[k] === "string" ? (s.grants[k] as string) : undefined;
      return {
        key: k,
        module: d?.module ?? "instance",
        value: e ? e.value : null,
        set: e?.set ?? false,
        // The compiled config carries settings at all (an older compile doesn't); a key it lacks is simply not set.
        known: Boolean(c.settings),
        ...(d?.def.default !== undefined ? { default: d.def.default } : {}),
        ...(d?.def.values ? { values: d.def.values } : {}),
        ...(d?.def.required ? { required: true } : {}),
        ...(d?.def.doc ? { doc: d.def.doc } : {}),
        ...(d?.def.type ? { type: d.def.type } : {}),
        ...(d?.def.host ? { host: d.def.host } : {}),
        ...(d?.def.pattern ? { pattern: d.def.pattern } : {}),
        ...(d?.def.when ? { when: d.def.when } : {}),
        ...(live !== undefined ? { live } : {}),
        switch: JSON.stringify(d?.def.values) === JSON.stringify(["on", "off"]),
      };
    });

  const hours = Number(effective.heartbeat_hours?.value ?? 4);
  const grantsByKey = new Map(Object.values(s.grants?.agents ?? {}).map((g) => [g.key, g]));
  /** The module's own value (module.yaml as written) for each field it sets on one agent or routine: what Reset goes back to. */
  const defaultsOf = (kind: "agents" | "routines", key: string, fields: string[]) => {
    const own = s.catalog.find((m) => m.defaults?.[kind]?.[key])?.defaults?.[kind]?.[key] ?? {};
    return Object.fromEntries(fields.filter((f) => own[f] !== undefined).map((f) => [f, f === "schedules" ? ((own[f] as Schedule[]) ?? []).map((x) => ({ cron: x.cron ?? "", ...(x.timezone ? { timezone: x.timezone } : {}), ...(x.label ? { label: x.label } : {}) })) : own[f]]));
  };
  const agents = Object.entries(c.agents ?? {}).map(([key, a]) => {
    const g = grantsByKey.get(key);
    const routines = Object.entries(c.routines ?? {})
      .filter(([, r]) => r.agent === key)
      .map(([rk, r]) => ({ key: rk, title: r.title ?? rk, schedules: (r.schedules ?? []).map((x) => ({ cron: x.cron ?? "", timezone: x.timezone ?? "", label: x.label ?? "" })), ...(r.model ? { model: r.model } : {}), ...(r.webhook ? { webhook: true } : {}), defaults: defaultsOf("routines", rk, ["schedules", "model"]) }));
    return {
      key,
      name: a.name ?? key,
      module: a.module ?? "",
      model: a.model ?? "",
      models: a.models ?? [],
      effort: a.reasoning_effort ?? "",
      heartbeatHours: a.heartbeat === true ? hours : typeof a.heartbeat === "number" ? a.heartbeat : null,
      /** Whether a heartbeat may be turned on (compile refuses one for an Engineer, or one without the tools). */
      canHeartbeat: a.profile !== "engineer" && !a.team && !a.member_of && HEARTBEAT_TOOLS.every((t) => a.enabled_tools?.paperclip_tasks?.includes(t)),
      // Only an engine that takes an effort shows the setting; an engine without efforts, none.
      efforts: EFFORTS[compiledEngine(a) ?? "codex"] ?? [],
      department: a.department ?? { id: "general", name: "General", order: 1_000 },
      ...(a.profile === "engineer" ? { maxParallel: a.max_parallel ?? 1 } : {}),
      // A team record's agent-level settings are its team's defaults, a member's its own entry; a member has no cap of its own.
      ...(a.team ? { team: a.team.name } : {}),
      ...(a.member_of ? { memberOf: a.member_of } : {}),
      routines,
      graded: Boolean(g?.graded),
      roles: a.roles ?? [],
      defaults: defaultsOf("agents", key, ["model", "reasoning_effort", "heartbeat"]),
      connections: Object.keys(a.enabled_tools ?? {}),
    };
  });

  const revision = s.catalog.find((m) => m.revision)?.revision ?? s.lastRev?.product_sha ?? null;
  return {
    compiled: Boolean(s.compiled),
    owner: { name: c.owner_name ?? (effective.owner_name?.value as string | undefined) ?? null },
    instance: { product: revision, instance: s.lastRev?.instance_sha ?? null, lastChangeAt: s.lastRev?.at ?? null, boardTimezone: s.boardTimezone, node: process.version },
    settings,
    agents,
    // What the Agents page offers: the heartbeat hours compile accepts, and every model already in use (a datalist).
    choices: { heartbeatHours: HEARTBEAT_HOURS, models: [...new Set([...Object.values(c.agents ?? {}).flatMap((a) => [a.model, ...(a.models ?? [])]), ...Object.values(c.routines ?? {}).map((r) => r.model)].filter((m): m is string => Boolean(m)))].sort() },
    approvals: { pending: s.pendingApprovals },
    updates: s.updates ?? null,
  };
}

/** One connection's live answer from the kernel: its /healthz (status and body fields), or the error reaching it. */
export interface Probe {
  ok: boolean;
  status?: number;
  state?: string;
  detail?: string;
  channels?: Record<string, boolean>;
  checkedAt: string;
  lastOkAt?: string;
}

export interface ConnectionRow {
  name: string;
  module: string;
  kind: "connection" | "service";
  transport: string;
  tools: { read: number; write: number };
  grants: { agent: string; name: string; access: "read" | "write"; tools: number }[];
  setup: string | null;
  probe: Probe | null;
  signIn: SignIn | null;
  google?: { accounts: { email: string; primary: boolean; state: string; since: string; detail?: string }[]; error?: string; client_type?: "desktop" | "web" } | null;
}

export interface SignIn {
  state: string;
  configured: boolean;
  since: string;
  detail?: string;
  /** Connect offers a choice of scopes (the picker comes first; a Reconnect reads "Change access"). */
  offer?: boolean;
  /** Not configured yet: the per-install values Connect asks for first (board.signins `secrets`). */
  fields?: { secret: string; label: string; pattern: string; help?: string }[];
}

/** Every connection the compiled config has, every runner service with setup steps, and each warehouse source. */
export function connectionsView(input: {
  compiled: Compiled | null;
  catalog: CatalogEntry[];
  probes: Record<string, Probe>;
  signIns: Record<string, SignIn | null | undefined>;
  google: { accounts: { email: string; primary: boolean; state: string; since: string; detail?: string }[]; error?: string; client_type?: "desktop" | "web" } | null | undefined;
  sources: { source: string; last_ok: string | null; failing: boolean }[] | null;
}) {
  const c = input.compiled ?? {};
  const moduleOf = new Map(input.catalog.flatMap((m) => (m.connections ?? []).map((n) => [n, m.name] as const)));
  const rows: ConnectionRow[] = Object.entries(c.mcp_servers ?? {}).map(([name, m]) => {
    const write = new Set([...(m.tools?.write ?? []), ...(m.tools?.destructive ?? [])]);
    const grants = Object.entries(c.agents ?? {})
      .filter(([, a]) => a.enabled_tools?.[name]?.length)
      .map(([key, a]) => {
        const tools = a.enabled_tools![name]!;
        return { agent: key, name: a.name ?? key, access: tools.some((t) => write.has(t)) ? ("write" as const) : ("read" as const), tools: tools.length };
      });
    return {
      name,
      module: moduleOf.get(name) ?? "",
      kind: "connection",
      transport: m.url ? `http ${new URL(m.url).host}` : "built in",
      tools: { read: m.tools?.read?.length ?? 0, write: (m.tools?.write?.length ?? 0) + (m.tools?.destructive?.length ?? 0) },
      grants,
      setup: m.setup ?? null,
      probe: m.url ? (input.probes[name] ?? null) : null,
      signIn: input.signIns[name] ?? null,
      ...(name === "google_workspace" ? { google: input.google ?? null } : {}),
    };
  });
  // Modules that serve the runner rather than an agent connection (Grafana, ClickHouse): their sign-in, if the board has one.
  for (const m of input.catalog.filter((x) => x.enabled && x.setup && !(x.connections ?? []).length))
    rows.push({ name: m.name, module: m.name, kind: "service", transport: "runner", tools: { read: 0, write: 0 }, grants: [], setup: m.setup ?? null, probe: null, signIn: input.signIns[m.name] ?? null });
  const sources = (input.sources ?? []).map((x) => ({ name: `src_${x.source}`, lastOk: x.last_ok, failing: x.failing, stale: staleSource(x, Date.now()) }));
  return { compiled: Boolean(input.compiled), connections: rows, sources, sourcesError: input.sources === null };
}
