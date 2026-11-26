// Teammates: the agents the owner sees and talks to by name (an agent's compiled `teammate:` block). Every chat entry point
// reaches only these; hidden agents work through their teammate. Read from the compiled config and the grants table (key by
// Paperclip id), never Paperclip metadata, which agents can edit.
import { z } from "zod";
import { faceKitProblem, type FaceKit } from "./face-kit.js";
import { setRoutinePaused } from "./fleet.js";
import { grantsTable } from "./grants.js";
import { AccountError, type AccountSession } from "./kernel-auth.js";
import { moduleId } from "./modules.js";
import type { Agent, Paperclip } from "./paperclip.js";
import type { Compiled } from "./settings.js";
import type { SetupRoute } from "./setup-flows.js";
import type { Store } from "./store.js";
import type { TaskStates } from "./task-state.js";

export type Teammate = { key: string; job: string; sample: string; staff: string[]; controls: string[]; face: string | FaceKit | null };

/** Every compiled teammate by key. */
export function teammateKeys(compiled: Compiled | null): Map<string, Teammate> {
  const out = new Map<string, Teammate>();
  for (const [key, a] of Object.entries(compiled?.agents ?? {})) {
    const t = a.teammate as Partial<Teammate> | undefined;
    if (t && typeof t.job === "string") out.set(key, { key, job: t.job, sample: String(t.sample ?? ""), staff: t.staff ?? [], controls: t.controls ?? [], face: t.face ?? null });
  }
  return out;
}

/** The agent's key by the grants table (setup writes it, keyed by Paperclip id); undefined for an agent it doesn't list. */
export const grantsKeyOf = (id: string): string | undefined => grantsTable(process.env.AIDENHQ_GRANTS_FILE)()[id]?.key;

/** Whether the agent is a teammate: its grants-table key has a compiled teammate block. */
export function isTeammate(agent: Pick<Agent, "id">, keys: Map<string, Teammate>): boolean {
  const key = grantsKeyOf(agent.id);
  return key !== undefined && keys.has(key);
}

/** Who answers for `key` on the owner's surfaces: the teammate whose staff lists it, else itself if a teammate, else Aiden. */
export function teammateFor(key: string, keys: Map<string, Teammate>): string {
  if (keys.has(key)) return key;
  for (const t of keys.values()) if (t.staff.includes(key)) return t.key;
  return "chief-of-staff";
}

// ---------------------------------------------------------------------------------------------------------------- hiring
// The hiring list, a teammate's setup (its routines resumed, its module's trial run once) and each account's set-up-next
// queue (docs/superpowers/plans/2026-11-26-home-teammates-phase-3.md Task 6). Read from the compiled catalog
// (config/modules.json `teammates`, browse rows included) and config; a selection is always a `ref`, `<id>:<key>`.

/** A teammate's face as the roster draws it: a shipped file, a kit spec, or null (features hashed from the key). */
export type HireFace = { src: string } | { kit: FaceKit } | null;
export interface HireRow {
  key: string; name: string; job: string; sample: string; description: string; department: string;
  /** Its module, and how a module change names that module: `name`, or `name@marketplace` for a third-party one. */
  module: string; id: string;
  /** `<id>:<key>`: the one handle for a selection (two marketplaces may list the same agent key). */
  ref: string;
  marketplace: string; browse: boolean; onTeam: boolean;
  /** A browse row's face is only ever a checked kit spec, never a file. */
  face: HireFace;
  /** The modules turned on with it. */
  requires: string[];
  /** The setup flows (module names) its module and what it requires still need. */
  connections: string[];
}
export type TrialState = "none" | "running" | "done" | "failed";
export interface TrialView { state: TrialState; found: { identifier: string; title: string; labels: string[] }[] }
export interface TeammateQueue { first?: string; next: string[]; later: string[] }
export type HomeStart = { nextUp: HireRow | null; more: Pick<HireRow, "key" | "name" | "job" | "face">[] };

type CatalogTeammate = { key: string; name: string; job: string; sample: string; description?: string; department?: string; face?: string | FaceKit | null; first?: number | null };
export type HireCatalogRow = { name: string; enabled?: boolean; marketplace?: string; browse?: boolean; requires?: string[]; agents?: string[]; routines?: string[]; teammates?: CatalogTeammate[] };
export type HireGrants = { agents?: Record<string, { key: string; roles?: string[] }>; routine_keys?: Record<string, string> } | null;

export type TeammatesDeps = {
  pc: Pick<Paperclip, "request" | "routine" | "tasksSince">;
  store: Store;
  states: Pick<TaskStates, "read">;
  sources: () => { compiled: Compiled | null; catalog: HireCatalogRow[]; grants: HireGrants };
  /** The setup flows' done states (setup-flows.ts `states`). */
  flowStates: () => Promise<{ module: string; done: boolean }[]>;
  now?: () => number;
};

const REF = /^([a-z0-9][a-z0-9-]{0,62}(?:@[a-z0-9][a-z0-9-]{0,62})?):([a-z0-9][a-z0-9-]{0,62})$/;
const RefSchema = z.string().max(200).regex(REF);
const QueueSchema = z.object({ first: RefSchema.optional(), next: z.array(RefSchema).max(20), later: z.array(RefSchema).max(20) }).strict();
/** A run that never recorded its task within this long never will (the board stopped between reserving and running). */
const UNRUN_MS = 10 * 60_000;
/** Home's getting-started band shows this long after the welcome. */
const DAY_ONE_MS = 7 * 86_400_000;
const OFFICIAL = "aidenhq";

export function createTeammates(d: TeammatesDeps) {
  const now = d.now ?? Date.now;
  const from = (m: HireCatalogRow) => m.marketplace ?? OFFICIAL;
  /** A module named by a `requires` entry: the installed or official one before a browse listing. */
  const byName = (catalog: HireCatalogRow[], n: string) => catalog.find((x) => x.name === n && !x.browse) ?? catalog.find((x) => x.name === n);
  const closureOf = (catalog: HireCatalogRow[], m: HireCatalogRow) => {
    const out: HireCatalogRow[] = [];
    const visit = (x: HireCatalogRow | undefined) => { if (!x || out.includes(x)) return; out.push(x); for (const r of x.requires ?? []) visit(byName(catalog, r)); };
    visit(m);
    return out;
  };
  const faceOf = (key: string, f: CatalogTeammate["face"], browse: boolean): HireFace =>
    typeof f === "string" ? (browse ? null : { src: `/api/faces/${key}` }) : f && !faceKitProblem(f) ? { kit: f } : null;
  const onTeam = (compiled: Compiled | null, m: HireCatalogRow, key: string) => !m.browse && Boolean(m.enabled) && compiled?.agents?.[key]?.module === m.name && Boolean((compiled.agents[key] as { teammate?: unknown }).teammate);

  /** Every catalog teammate: official first, then the owner's own, then each marketplace A to Z. `flows`: read the setup flows'
   * states for `connections` (pairing reads); without, `connections` is empty (a lookup by ref needs none). */
  async function rows(flows = true): Promise<HireRow[]> {
    const { compiled, catalog } = d.sources();
    const open = new Set(flows ? (await d.flowStates().catch(() => [])).filter((f) => !f.done).map((f) => f.module) : []);
    const rank = (m: HireCatalogRow) => (from(m) === OFFICIAL ? "0" : from(m) === "local" ? "1" : `2${from(m)}`);
    return catalog.filter((m) => m.name !== "kernel").sort((a, b) => rank(a).localeCompare(rank(b))).flatMap((m) => (m.teammates ?? []).map((t) => {
      const id = moduleId(m);
      return {
        key: t.key, name: t.name, job: t.job, sample: t.sample, description: t.description ?? "", department: t.department ?? "General",
        module: m.name, id, ref: `${id}:${t.key}`, marketplace: from(m), browse: Boolean(m.browse), onTeam: onTeam(compiled, m, t.key),
        face: faceOf(t.key, t.face, Boolean(m.browse)), requires: m.requires ?? [],
        connections: closureOf(catalog, m).map((x) => x.name).filter((n) => open.has(n)),
        ...(t.first ? { first: t.first } : {}),
      } as HireRow & { first?: number };
    }));
  }
  /** The teammate onboarding recommends: the available one with the lowest `first`, else the first by job; null when all are hired. */
  const firstOf = (list: (HireRow & { first?: number })[]) => {
    const free = list.filter((r) => !r.onTeam);
    const ranked = free.filter((r) => r.first).sort((a, b) => a.first! - b.first!);
    return (ranked[0] ?? [...free].sort((a, b) => a.job.localeCompare(b.job))[0])?.ref ?? null;
  };
  /** Who builds a new teammate: the agent holding grants role `architect`, by its compiled name and face. */
  const builder = () => {
    const { compiled, grants } = d.sources();
    const key = Object.values(grants?.agents ?? {}).find((g) => g.roles?.includes("architect"))?.key;
    const a = key ? compiled?.agents?.[key] : undefined;
    if (!key || !a) return null;
    const t = (a as { teammate?: { face?: string | FaceKit | null } }).teammate;
    return { key, name: a.name ?? key, face: faceOf(key, t?.face ?? null, false) };
  };

  const resolve = async (raw: string) => {
    let ref: string;
    try { ref = decodeURIComponent(raw); } catch { throw new AccountError(404, "no such teammate"); }
    const row = REF.test(ref) ? (await rows(false)).find((r) => r.ref === ref) : undefined;
    if (!row) throw new AccountError(404, "no such teammate");
    return row;
  };
  /** D9 and D8: the routines a teammate's setup resumes (scheduled or event ones of it, or of a hidden agent of its module or one
   * it requires) and the trial routines of those modules, by compiled key. */
  const plan = (row: HireRow) => {
    const { compiled, catalog } = d.sources();
    const m = catalog.find((x) => x.name === row.module && moduleId(x) === row.id)!;
    const closure = closureOf(catalog, m);
    const hidden = new Set(closure.flatMap((x) => (x.agents ?? []).filter((k) => compiled?.agents?.[k] && !(compiled.agents[k] as { teammate?: unknown }).teammate)));
    const all = Object.entries(compiled?.routines ?? {});
    return {
      resume: all.filter(([, r]) => (r.agent === row.key || hidden.has(r.agent ?? "")) && (r.schedules?.length || r.event != null)).map(([k]) => k),
      trials: all.filter(([k, r]) => r.trial === true && closure.some((x) => x.routines?.includes(k))).map(([k, r]) => ({ key: k, agent: r.agent ?? "" })),
    };
  };
  const liveId = (key: string) => Object.entries(d.sources().grants?.routine_keys ?? {}).find(([, k]) => k === key)?.[0];
  type Trial = { at: string; attempt: number; runs: Record<string, string> };
  const trialOf = (ref: string): Trial | undefined => { try { return JSON.parse(d.store.meta(`trial:${ref}`) ?? "null") ?? undefined; } catch { return undefined; } };
  /** A trial's state from its runs' tasks (the kernel's task state): failed when one failed or a run never started. */
  const stateOf = async (t: Trial, wanted: number): Promise<TrialState> => {
    const ids = Object.values(t.runs);
    if (ids.length < wanted && now() - Date.parse(t.at) > UNRUN_MS) return "failed";
    const got = ids.length ? (await d.states.read({ ids })).tasks : [];
    // A cancelled run counts as failed: the owner can retry it.
    if (got.some((r) => r.attention.some((a) => a.why === "failed") || (r.kind === "done" && r.reason === "cancelled"))) return "failed";
    return ids.length >= wanted && ids.every((id) => got.find((r) => r.task === id)?.kind === "done") ? "done" : "running";
  };

  const queueKey = (account: string) => `teammates:${account}`;
  const queueOf = (account: string): TeammateQueue => {
    try { return QueueSchema.parse(JSON.parse(d.store.meta(queueKey(account)) ?? "null")); } catch { return { next: [], later: [] }; }
  };
  const owner = (who: AccountSession) => { if (!who.account.owner) throw new AccountError(403, "only the owner sets up a teammate"); };

  const routes: SetupRoute[] = [
    {
      method: "GET",
      path: /^\/api\/teammates$/,
      handle: async () => { const list = await rows(); return { rows: list.map(({ first: _f, ...r }: HireRow & { first?: number }) => r), first: firstOf(list), builder: builder() }; },
    },
    {
      method: "GET",
      path: /^\/api\/teammates\/queue$/,
      handle: async (_m, _b, who) => queueOf(who.account.id),
    },
    {
      method: "PUT",
      path: /^\/api\/teammates\/queue$/,
      handle: async (_m, body, who) => {
        const q = QueueSchema.safeParse(body);
        if (!q.success) throw new AccountError(400, "send {first?, next, later}: teammate refs (<module>:<key>), at most 20 each");
        d.store.setMeta(queueKey(who.account.id), JSON.stringify(q.data));
        return q.data;
      },
    },
    {
      // Set up a teammate whose module is on: its routines resumed (only paused ones), then its trial run once per reservation.
      method: "POST",
      path: /^\/api\/teammates\/([^/]{1,400})\/start$/,
      handle: async (m, body, who) => {
        owner(who);
        const row = await resolve(m[1]!);
        const { trial } = z.object({ trial: z.boolean().optional() }).strict().parse(body ?? {});
        if (!row.onTeam) throw new AccountError(409, `${row.name} isn't on the team yet: turn on ${row.id} first`);
        const p = plan(row);
        const resumed: string[] = [];
        for (const key of p.resume) {
          const id = liveId(key);
          const r = id ? await d.pc.routine(id) : undefined;
          if (r?.status === "paused") { await setRoutinePaused(d.pc, r, false); resumed.push(key); }
        }
        const runnable = p.trials.filter((t) => liveId(t.key));
        if (trial === false || !runnable.length) return { resumed, trials: [] };
        // One trial per teammate: the reservation is set once (of two calls only one wins); a rerun only when it failed.
        const mkey = `trial:${row.ref}`;
        let t: Trial = { at: new Date(now()).toISOString(), attempt: 1, runs: {} };
        if (!d.store.claimMeta(mkey, JSON.stringify(t))) {
          const was = trialOf(row.ref)!;
          if ((await stateOf(was, runnable.length)) !== "failed") return { resumed, trials: [] };
          // A recorded run failed: a new attempt, every trial again. No run recorded at all: the same attempt again, so
          // Paperclip's idempotency key dedupes any run it already accepted.
          const failedRun = Object.keys(was.runs).length > 0;
          t = failedRun ? { at: new Date(now()).toISOString(), attempt: was.attempt + 1, runs: {} } : { ...was, at: new Date(now()).toISOString() };
          d.store.setMeta(mkey, JSON.stringify(t));
        }
        const trials: string[] = [];
        for (const r of runnable) {
          if (t.runs[r.key]) continue;
          const run = await d.pc.request<{ status?: string; linkedIssueId?: string }>("POST", `/api/routines/${encodeURIComponent(liveId(r.key)!)}/run`, { source: "manual", idempotencyKey: `aidenhq-trial:${row.ref}:${t.attempt}:${r.key}` });
          if (run?.linkedIssueId) { t.runs[r.key] = run.linkedIssueId; d.store.setMeta(mkey, JSON.stringify(t)); }
          trials.push(r.key);
        }
        return { resumed, trials };
      },
    },
    {
      method: "GET",
      path: /^\/api\/teammates\/([^/]{1,400})\/trial$/,
      handle: async (m): Promise<TrialView> => {
        const row = await resolve(m[1]!);
        const t = trialOf(row.ref);
        const runnable = row.onTeam ? plan(row).trials.filter((x) => liveId(x.key)) : [];
        if (!t || !runnable.length) return { state: "none", found: [] };
        const state = await stateOf(t, runnable.length);
        // What the trial filed: open tasks its routines' agents created since it started.
        const grants = d.sources().grants?.agents ?? {};
        const agents = new Set(Object.entries(grants).filter(([, g]) => runnable.some((x) => x.agent === g.key)).map(([id]) => id));
        const runs = new Set(Object.values(t.runs));
        const found = (await d.pc.tasksSince(t.at))
          .filter((i) => i.createdByAgentId && agents.has(i.createdByAgentId) && !runs.has(i.id) && (i.createdAt ?? "") >= t.at && !["done", "cancelled"].includes(i.status))
          .slice(0, 10)
          .map((i) => ({ identifier: i.identifier, title: i.title, labels: (i.labels ?? []).map((l) => l.name) }));
        return { state, found };
      },
    },
  ];

  /** Home's getting-started band (owner only): while his queue holds a teammate not on the team, or for a week after the welcome. */
  async function homeStart(account: string, isOwner: boolean, welcomedAt: string | undefined): Promise<HomeStart | undefined> {
    if (!isOwner) return undefined;
    const q = queueOf(account);
    const recent = welcomedAt !== undefined && now() - Date.parse(welcomedAt) < DAY_ONE_MS;
    if (!q.next.length && !recent) return undefined;
    const list = await rows();
    const nextUp = q.next.map((ref) => list.find((r) => r.ref === ref && !r.onTeam)).find(Boolean) ?? null;
    if (!nextUp && !recent) return undefined;
    const more = list.filter((r) => !r.onTeam && r !== nextUp).slice(0, 8).map(({ key, name, job, face }) => ({ key, name, job, face }));
    return { nextUp: nextUp ? (({ first: _f, ...r }: HireRow & { first?: number }) => r)(nextUp) : null, more };
  }

  return { routes, rows, homeStart };
}
