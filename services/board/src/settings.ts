// The Settings page's data (web/src/Settings.tsx): read-only views of the compiled config (config/paperclip.yaml, the module
// catalog config/modules.json), the grants table and the live state the board can ask (connection health, sign-ins, the
// model gateway, warehouse sources). Instance settings live in git (instance.yaml): nothing here writes them; a change is
// filed as a task (settings-change.ts). Never a secret: compile leaves secret-looking settings out, and connections are
// shown by name, URL host and tool names only.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EFFORTS, compiledEngine } from "./board.js";

/** The hours a heartbeat may run every (scripts/modules.mjs HEARTBEAT_HOURS), and the tools it needs (HEARTBEAT_TOOLS). */
export const HEARTBEAT_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
export const HEARTBEAT_TOOLS = ["task_list", "task_comments", "task_approvals", "task_comment", "task_finish"];

/** The fleet default spend caps (scripts/modules.mjs CAPS): an agent's own caps in the grants table override them. */
const CAPS = { run_usd: 2, task_usd: 10, day_usd: 30 };

interface SettingDef {
  default?: unknown;
  values?: unknown[];
  required?: boolean;
  /** `url`: the board offers a URL input, checked by services/shared/url-setting.ts (with `host`, when set). */
  type?: string;
  host?: string;
  doc?: string;
}
interface CatalogEntry {
  name: string;
  enabled: boolean;
  chosen?: boolean;
  connections?: string[];
  revision?: string;
  settings?: Record<string, SettingDef>;
  setup?: string;
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
  adapter?: string;
  /** A runner Engineer's engine, when not its adapter's (module.yaml `engine:`). */
  engine?: string;
  model?: string;
  models?: string[];
  reasoning_effort?: string;
  heartbeat?: boolean | number | null;
  trial?: boolean;
  image?: string;
  dispatch?: string;
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
  caps?: Record<string, number>;
  graded?: boolean;
  trial?: boolean;
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
  pendingRaises: number;
  pendingApprovals: number;
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
        ...(live !== undefined ? { live } : {}),
        switch: JSON.stringify(d?.def.values) === JSON.stringify(["on", "off"]),
      };
    });

  const hours = Number(effective.heartbeat_hours?.value ?? 4);
  const grantsByKey = new Map(Object.values(s.grants?.agents ?? {}).map((g) => [g.key, g]));
  const agents = Object.entries(c.agents ?? {}).map(([key, a]) => {
    const g = grantsByKey.get(key);
    const routines = Object.entries(c.routines ?? {})
      .filter(([, r]) => r.agent === key)
      .map(([rk, r]) => ({ key: rk, title: r.title ?? rk, schedules: (r.schedules ?? []).map((x) => ({ cron: x.cron ?? "", timezone: x.timezone ?? "", label: x.label ?? "" })), ...(r.model ? { model: r.model } : {}), ...(r.status ? { status: r.status } : {}), ...(r.webhook ? { webhook: true } : {}) }));
    return {
      key,
      name: a.name ?? key,
      module: a.module ?? "",
      adapter: a.adapter ?? "",
      runsOn: a.dispatch === "runner" ? "runner" : a.image ? `computer (${a.image})` : "Paperclip",
      model: a.model ?? "",
      models: a.models ?? [],
      effort: a.reasoning_effort ?? "",
      heartbeatHours: a.heartbeat === true ? hours : typeof a.heartbeat === "number" ? a.heartbeat : null,
      /** Whether a heartbeat may be turned on (compile refuses one for a runner agent, or one without the tools). */
      canHeartbeat: a.dispatch !== "runner" && HEARTBEAT_TOOLS.every((t) => a.enabled_tools?.paperclip_tasks?.includes(t)),
      // Only an engine that takes an effort shows the setting: Paperclip's own agents run Codex; an engine without efforts, none.
      efforts: EFFORTS[compiledEngine(a) ?? "codex"] ?? [],
      department: a.department ?? { id: "general", name: "General", order: 1_000 },
      routines,
      trial: Boolean(a.trial ?? g?.trial),
      graded: Boolean(g?.graded),
      roles: a.roles ?? [],
      caps: { ...CAPS, ...(g?.caps ?? {}) },
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
    spend: { defaults: CAPS, pendingRaises: s.pendingRaises },
  };
}

/** One connection's live answer: its /healthz (status and body fields), or the error reaching it. */
export interface Probe {
  ok: boolean;
  status?: number;
  state?: string;
  detail?: string;
  channels?: Record<string, boolean>;
  checkedAt: string;
  lastOkAt?: string;
}

/** GET <url origin>/healthz, as scripts/agent-check.mjs asks it: ok unless the HTTP status or `ok: false` says otherwise. */
export async function probe(url: string, timeoutMs = 4000): Promise<Omit<Probe, "lastOkAt">> {
  const checkedAt = new Date().toISOString();
  try {
    const r = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(timeoutMs) });
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(await r.text());
    } catch {}
    const ok = r.ok && j.ok !== false;
    const detail = typeof j.detail === "string" ? j.detail.slice(0, 200) : undefined;
    const channels = j.channels && typeof j.channels === "object" ? Object.fromEntries(Object.entries(j.channels as Record<string, unknown>).map(([k, v]) => [k, v === true])) : undefined;
    return { ok, status: r.status, ...(typeof j.state === "string" ? { state: j.state } : {}), ...(detail ? { detail } : {}), ...(channels ? { channels } : {}), checkedAt };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, detail: `unreachable: ${err.cause?.code ?? err.message}`.slice(0, 200), checkedAt };
  }
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
  google?: { accounts: { email: string; primary: boolean; state: string; since: string; detail?: string }[]; error?: string } | null;
  /** Its module's URL settings (`type: url`), which the board can change: the first without a default is the one to set. */
  urls: UrlSetting[];
}

export interface UrlSetting {
  key: string;
  value: string;
  /** instance.yaml sets it. */
  set: boolean;
  default?: string;
  host?: string;
  doc?: string;
}

export interface SignIn {
  state: string;
  configured: boolean;
  since: string;
  detail?: string;
}

/** Every connection the compiled config has, every runner service with setup steps, and each warehouse source. */
export function connectionsView(input: {
  compiled: Compiled | null;
  catalog: CatalogEntry[];
  probes: Record<string, Probe>;
  signIns: Record<string, SignIn | null | undefined>;
  google: { accounts: { email: string; primary: boolean; state: string; since: string; detail?: string }[]; error?: string } | null | undefined;
  sources: { source: string; last_ok: string | null; failing: boolean }[] | null;
  staleSources: Set<string>;
}) {
  const c = input.compiled ?? {};
  const moduleOf = new Map(input.catalog.flatMap((m) => (m.connections ?? []).map((n) => [n, m.name] as const)));
  const urls = (module: string): UrlSetting[] =>
    Object.entries(input.catalog.find((m) => m.name === module)?.settings ?? {})
      .filter(([, d]) => d.type === "url")
      .map(([key, d]) => {
        const e = c.settings?.[key];
        return { key, value: typeof e?.value === "string" ? e.value : "", set: e?.set ?? false, ...(typeof d.default === "string" ? { default: d.default } : {}), ...(d.host ? { host: d.host } : {}), ...(d.doc ? { doc: d.doc } : {}) };
      });
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
      // A connection that signs in to nothing has no sign-in URLs to set (Grafana's cloud stack while it reads the local one).
      urls: input.signIns[name]?.state === "none" ? [] : urls(moduleOf.get(name) ?? ""),
    };
  });
  // Modules that serve the runner rather than an agent connection (Grafana, ClickHouse): their sign-in, if the board has one.
  for (const m of input.catalog.filter((x) => x.enabled && x.setup && !(x.connections ?? []).length))
    rows.push({ name: m.name, module: m.name, kind: "service", transport: "runner", tools: { read: 0, write: 0 }, grants: [], setup: m.setup ?? null, probe: null, signIn: input.signIns[m.name] ?? null, urls: input.signIns[m.name]?.state === "none" ? [] : urls(m.name) });
  const sources = (input.sources ?? []).map((x) => ({ name: `src_${x.source}`, lastOk: x.last_ok, failing: x.failing, stale: input.staleSources.has(x.source) }));
  return { compiled: Boolean(input.compiled), connections: rows, sources, sourcesError: input.sources === null };
}
