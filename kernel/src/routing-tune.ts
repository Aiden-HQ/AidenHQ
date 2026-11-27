// The routing learning loop (docs/design/settings-changes.md, Routing tuning): the Fleet Steward (role routing-tuner) reviews
// yesterday's team routing decisions (team_routes, wakes.ts) against trusted outcomes and files at most one change a UTC day to
// a team's member `repos` patterns and `routing.weights`, as one experiment. Its route is POST /v1/routing/<op>, the
// fleet-steward module's own token plus the caller assertion of the Steward job's tool call in flight (backplane.ts).
// - evidence: the decisions in a window, each with outcomes the kernel recorded (task status and completion time, reopen wakes,
//   finish-gate reopens such as the grader's), never task prose; the team's current values and the open experiment.
// - replay: code re-runs the recorded decisions (each decision's candidate snapshot) with other weights or repos.
// - tune (routing.tune): the typed change, written by the kernel as a commit to instance.yaml (the #742 writer's code host) and
//   filed as one kernel.apply with the Steward as its requester: its tier is computeTier's alone (apply-tier.ts proposes
//   Tier 1 "routing-only" for a commit of this loop that its routingDiff proves). Anything outside those leaves is refused
//   here, never escalated.
// - judge: the open experiment against its revert criterion (a finite schema); a revert rolls back only its own leaves still at
//   their applied values, through the same reviewed apply.
// One experiment is open at a time and one proposal is filed per UTC day: both held by unique indexes in kernel.db.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import type { Write } from "./apply.ts";
import type { Api } from "./channels.ts";
import { routingDiff, type Leaf } from "./apply-tier.ts";
import { canonical, type Rec, type Records, type Requester } from "./records.ts";
import { yamlText } from "./settings-change.ts";
import { DEFAULT_WEIGHTS, pickMember, type Candidate, type Weights } from "./team-routing.ts";
import { openFacts } from "./facts.ts";
import type { RouteSnapshot } from "./wakes.ts";

export class Refused extends Error { status = 422; }
const refuse = (msg: string): never => { throw new Refused(msg); };
type Dict = Record<string, any>;
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** The revert criterion: a metric over the team's decisions since the change applied, above `threshold` on at least `min_sample`. */
export const METRICS = { reopen_rate: "share of finished or reopened tasks that were reopened", cycle_hours: "mean hours from routing to done", blocked_rate: "share of decisions with no member to take the task" } as const;
export type Criterion = { metric: keyof typeof METRICS; min_sample: number; threshold: number; deadline_days: number };
export function criterionProblem(c: unknown): string | undefined {
  if (!isMap(c) || Object.keys(c).some((k) => !["metric", "min_sample", "threshold", "deadline_days"].includes(k))) return "revert: { metric, min_sample, threshold, deadline_days }";
  if (!Object.hasOwn(METRICS, String(c.metric))) return `revert.metric: one of ${Object.keys(METRICS).join(", ")}`;
  if (!Number.isInteger(c.min_sample) || c.min_sample < 1 || c.min_sample > 500) return "revert.min_sample: 1 to 500";
  const max = c.metric === "cycle_hours" ? 720 : 1;
  if (typeof c.threshold !== "number" || !Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > max) return `revert.threshold: 0 to ${max}`;
  if (!Number.isInteger(c.deadline_days) || c.deadline_days < 1 || c.deadline_days > 30) return "revert.deadline_days: 1 to 30";
}

/** A decision with what the kernel recorded of its task since. */
export type Outcome = { task: string; identifier?: string; member: string | null; at: number; repos: string[]; blocked: boolean; status: string; cycle_hours: number | null; reopens: number };
/** One metric over decisions: its value and sample (null value: no sample). */
export function measure(metric: Criterion["metric"], rows: Outcome[]): { value: number | null; sample: number } {
  if (metric === "blocked_rate") return { value: rows.length ? rows.filter((r) => r.blocked).length / rows.length : null, sample: rows.length };
  if (metric === "cycle_hours") {
    const done = rows.filter((r) => r.cycle_hours !== null);
    return { value: done.length ? done.reduce((s, r) => s + r.cycle_hours!, 0) / done.length : null, sample: done.length };
  }
  const seen = rows.filter((r) => r.status === "done" || r.reopens > 0);
  return { value: seen.length ? seen.filter((r) => r.reopens > 0).length / seen.length : null, sample: seen.length };
}

/** A typed routing change: new weights (partial) and members' new repo patterns (null drops them). */
export type Change = { weights?: Partial<Weights>; repos?: Record<string, string[] | null> };

/** The recorded decisions re-run with `change`: how many there were, and the picks that change. Pure. */
export function replay(rows: { task: string; repos: string[]; snapshot: RouteSnapshot; pick: string | null }[], change: Change) {
  const changed: { task: string; was: string | null; now: string | null }[] = [];
  for (const r of rows) {
    const candidates: Candidate[] = r.snapshot.candidates.map((c) => (change.repos && Object.hasOwn(change.repos, c.key) ? { ...c, repos: change.repos[c.key] ?? [] } : c));
    const now = pickMember({ repos: r.repos, candidates, weights: { ...r.snapshot.weights, ...change.weights } }).pick?.key ?? null;
    if (now !== r.pick) changed.push({ task: r.task, was: r.pick, now });
  }
  return { decisions: rows.length, changed: changed.length, picks: changed.slice(0, 50) };
}

const DDL = `CREATE TABLE IF NOT EXISTS routing_experiments (id TEXT PRIMARY KEY, team TEXT NOT NULL, requester TEXT NOT NULL, task TEXT NOT NULL,
  base TEXT NOT NULL, sha TEXT, leaves TEXT NOT NULL, content TEXT NOT NULL, criterion TEXT NOT NULL, notes TEXT NOT NULL, record TEXT,
  state TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, applied_at INTEGER, rollback TEXT, rollback_sha TEXT, rollback_task TEXT, rollback_notes TEXT, verdict TEXT, rejected_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS routing_one_open ON routing_experiments ((1)) WHERE state IN ('filing', 'filed', 'applied', 'reverting');
CREATE UNIQUE INDEX IF NOT EXISTS routing_one_a_day ON routing_experiments (day) WHERE state != 'abandoned';`;
const OPEN = ["filing", "filed", "applied", "reverting"];
const CLOSED_RECORD = ["rejected", "stale", "cancelled", "failed", "unknown"];
type Row = { id: string; team: string; requester: string; task: string; base: string; sha: string | null; leaves: string; content: string; criterion: string; notes: string; record: string | null; state: string; day: string; at: number; applied_at: number | null; rollback: string | null; rollback_sha: string | null; rollback_task: string | null; rollback_notes: string | null; verdict: string | null; rejected_at: number | null };

const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const SHA = /^[0-9a-f]{40}$/;
const TASK = /^[0-9a-f-]{36}$/;
const DAY_MS = 86_400_000;
/** After a team's proposal is rejected (the reviewer's no or the owner's), no proposal for that team for this long, whatever its values. */
const REJECT_COOLDOWN_MS = 3 * DAY_MS;
const fence = (t: string) => { const f = "`".repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${t}\n${f}`; };
const show = (v: unknown) => (v === undefined ? "(unset)" : JSON.stringify(v));

export type RoutingDeps = {
  db: DatabaseSync; records: Pick<Records, "get" | "list">;
  /** The instance repo, its main (settings-change.ts checkoutMain), the code host's write and the kernel.apply filing (as `requester`). */
  instanceRepo: () => string | undefined;
  main: (paths: string[]) => Promise<{ base: string; texts: Map<string, string> }>;
  write: (w: Write) => Promise<{ sha: string }>;
  file: (args: { repo: string; branch: string; sha: string }, task: string, requester: Requester) => Promise<Rec>;
  /** The grants table's agents by id (team records and members). */
  grants: () => Record<string, { key?: string; team?: { name: string } } | undefined>;
  /** The control plane as the owner (task status and completion time only). */
  owner: Api;
  now?: () => number; log?: (msg: string, f?: Record<string, unknown>) => void;
};

export function createRouting(d: RoutingDeps) {
  const { db } = d;
  const now = d.now ?? Date.now;
  db.exec(DDL);
  openFacts(db); // the finish verdicts it counts
  const q = (sql: string) => db.prepare(sql);
  const keyOf = (id: string | null) => (id ? (d.grants()[id]?.key ?? id) : null);
  /** The team's name in instance.yaml and its record's key (team_routes.team) both ways. */
  const teams = () => Object.values(d.grants()).flatMap((g) => (g?.team && g.key ? [{ name: g.team.name, key: g.key }] : []));
  const recordKey = (name: string) => teams().find((t) => t.name === name)?.key ?? refuse(`there is no team ${name}`);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);

  /** The decisions of a team (its record key) in [since, until), with what the kernel recorded of each task since. */
  async function outcomes(key: string, since: number, until: number): Promise<Outcome[]> {
    const rows = q("SELECT task, member, repos, at, state FROM team_routes WHERE team = ? AND at >= ? AND at < ? ORDER BY at LIMIT 200").all(key, since, until) as { task: string; member: string | null; repos: string; at: number; state: string }[];
    const out: Outcome[] = [];
    for (const r of rows) {
      const t = await d.owner("GET", `/api/issues/${encodeURIComponent(r.task)}`);
      const done = t.status === 200 && t.json?.status === "done" && Date.parse(String(t.json?.completedAt ?? "")) > 0;
      out.push({
        task: r.task, ...(typeof t.json?.identifier === "string" ? { identifier: t.json.identifier } : {}), member: keyOf(r.member), at: r.at, repos: JSON.parse(r.repos), blocked: r.state === "blocked",
        status: t.status === 200 ? String(t.json?.status ?? "unknown") : "missing",
        cycle_hours: done ? Math.round(((Date.parse(t.json.completedAt) - r.at) / 3_600_000) * 100) / 100 : null,
        reopens: (q("SELECT COUNT(*) AS n FROM wakes WHERE task = ? AND cause = 'reopen'").get(r.task) as { n: number }).n,
      });
    }
    return out;
  }

  /** Experiment states from their apply records: applied once done, closed when not approved or not run. A crash mid-filing: found again or abandoned. */
  let filing: string | undefined;
  function sync() {
    for (const r of q(`SELECT * FROM routing_experiments WHERE state IN ('filing', 'filed', 'reverting')`).all() as Row[]) {
      if (r.state === "filing") {
        if (r.id === filing) continue;
        const who = JSON.parse(r.requester) as Requester;
        const found = r.sha ? d.records.list(["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"], 50, { task: r.task, kinds: ["kernel.apply"] }).find((x) => x.requester.agent === who.agent && (x.args as { sha?: string }).sha === r.sha) : undefined;
        if (found) q("UPDATE routing_experiments SET state = 'filed', record = ? WHERE id = ?").run(found.id, r.id);
        else q("UPDATE routing_experiments SET state = 'abandoned' WHERE id = ?").run(r.id);
        continue;
      }
      const rec = d.records.get(String(r.state === "filed" ? r.record : r.rollback));
      if (!rec) continue;
      if (r.state === "filed" && rec.state === "done") q("UPDATE routing_experiments SET state = 'applied', applied_at = ? WHERE id = ?").run(Date.parse(rec.updated_at) || now(), r.id);
      else if (r.state === "filed" && CLOSED_RECORD.includes(rec.state)) q("UPDATE routing_experiments SET state = 'rejected', verdict = ?, rejected_at = ? WHERE id = ?").run(`its apply ${rec.id} ended ${rec.state}`, rec.state === "rejected" ? Date.parse(rec.updated_at) || now() : null, r.id);
      else if (r.state === "reverting" && rec.state === "done") q("UPDATE routing_experiments SET state = 'reverted' WHERE id = ?").run(r.id);
      else if (r.state === "reverting" && CLOSED_RECORD.includes(rec.state)) q("UPDATE routing_experiments SET state = 'kept', verdict = ? WHERE id = ?").run(`${r.verdict ?? ""}; its rollback ${rec.id} ended ${rec.state}, so the change stays`.slice(0, 1000), r.id);
    }
  }
  const open = () => q(`SELECT * FROM routing_experiments WHERE state IN (${OPEN.map(() => "?").join(",")})`).get(...OPEN) as Row | undefined;
  const view = (r: Row | undefined) => r && { id: r.id, team: r.team, state: r.state, leaves: JSON.parse(r.leaves), revert: JSON.parse(r.criterion), record: r.record, rollback: r.rollback, applied_at: r.applied_at ? new Date(r.applied_at).toISOString() : null, verdict: r.verdict };

  /** instance.yaml on main with these leaves set (an absent value drops the key, and maps it empties). */
  function edited(text: string, set: { path: string[]; value: unknown }[]): string {
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) refuse("instance.yaml on main doesn't parse");
    for (const { path, value } of set) {
      if (value !== undefined) { doc.setIn(path, doc.createNode(value)); continue; }
      doc.deleteIn(path);
      for (let p = path.slice(0, -1); p.length > 2; p = p.slice(0, -1)) { const n = doc.getIn(p, true); if (YAML.isMap(n) && !n.items.length) doc.deleteIn(p); else break; }
    }
    return yamlText(doc, text);
  }
  /** Checks a written instance.yaml against main: a routing diff and nothing else. */
  function checked(base: string, head: string): Leaf[] {
    const r = routingDiff(base, head);
    if ("problem" in r) refuse(`not a routing change: ${r.problem}`);
    const [b, h] = [YAML.parse(base) ?? {}, YAML.parse(head) ?? {}];
    if (!same({ ...b, teams: undefined }, { ...h, teams: undefined })) refuse("it would change more of instance.yaml than teams");
    return (r as { leaves: Leaf[] }).leaves;
  }
  /** The recorded decisions of a team over the last `days` days, ready to replay. */
  const replayRows = (key: string, days: number) => (q("SELECT task, member, repos, snapshot FROM team_routes WHERE team = ? AND at >= ? AND snapshot IS NOT NULL ORDER BY at LIMIT 1000").all(key, now() - days * DAY_MS) as { task: string; member: string | null; repos: string; snapshot: string }[])
    .map((r) => ({ task: r.task, repos: JSON.parse(r.repos) as string[], snapshot: JSON.parse(r.snapshot) as RouteSnapshot, pick: keyOf(r.member) }));

  function typedChange(team: string, b: Dict): Change {
    const ch: Change = {};
    if (b.weights != null) {
      if (!isMap(b.weights) || !Object.keys(b.weights).length || Object.entries(b.weights).some(([k, v]) => !Object.hasOwn(DEFAULT_WEIGHTS, k) || typeof v !== "number")) refuse("weights: { repo?, continuity?, load? } numbers");
      ch.weights = b.weights as Partial<Weights>;
    }
    if (b.repos != null) {
      if (!isMap(b.repos) || !Object.keys(b.repos).length || Object.entries(b.repos).some(([k, v]) => !KEY.test(k) || (v !== null && (!Array.isArray(v) || v.some((p) => typeof p !== "string"))))) refuse("repos: { <member key>: [owner/name patterns] or null }");
      ch.repos = b.repos as Record<string, string[] | null>;
    }
    if (!ch.weights && !ch.repos) refuse("a change names weights, repos or both");
    if (!KEY.test(team)) refuse("team: a team's name");
    return ch;
  }
  const leafSets = (team: string, ch: Change) => [
    ...Object.entries(ch.weights ?? {}).map(([w, v]) => ({ path: ["teams", team, "routing", "weights", w], value: v as unknown })),
    ...Object.entries(ch.repos ?? {}).map(([m, v]) => ({ path: ["teams", team, "members", m, "repos"], value: (v ?? undefined) as unknown })),
  ];

  /** The code host's commit of the new instance.yaml on `branch` off main's `base`. */
  async function commit(branch: string, base: string, text: string, message: string) {
    const repo = d.instanceRepo() ?? refuse("this kernel has no instance repo (AIDENHQ_INSTANCE_REPO)");
    const { sha } = await d.write({ repo, base, branch, files: { "instance.yaml": text }, message });
    return { repo, sha };
  }

  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const run = lock.then(f); lock = run.catch(() => {}); return run; };

  return {
    /** The decisions of [since, until) (default: the previous UTC day; `days` back from today, up to 7) with their outcomes. */
    async evidence(b: Dict) {
      sync();
      const days = b.days == null ? 1 : Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 7) refuse("days: 1 to 7");
      const today = Date.parse(`${day(now())}T00:00:00Z`);
      const { base, texts } = await d.main(["instance.yaml"]);
      const current = (YAML.parse(texts.get("instance.yaml") ?? "") ?? {}).teams ?? {};
      const out: Dict = {};
      for (const t of teams()) {
        const c = current[t.name] ?? {};
        out[t.name] = { weights: { ...DEFAULT_WEIGHTS, ...(c.routing?.weights ?? {}) }, members: Object.fromEntries(Object.entries(isMap(c.members) ? c.members : {}).map(([k, m]) => [k, { repos: (m as Dict)?.repos ?? [] }])), decisions: await outcomes(t.key, today - days * DAY_MS, today) };
      }
      const filedToday = (q("SELECT COUNT(*) AS n FROM routing_experiments WHERE day = ? AND state != 'abandoned'").get(day(now())) as { n: number }).n;
      return { base_sha: base, window: { since: new Date(today - days * DAY_MS).toISOString(), until: new Date(today).toISOString() }, teams: out, open_experiment: view(open()) ?? null, may_propose_today: !open() && !filedToday, metrics: METRICS };
    },

    /** The recorded decisions of the last `days` days (default 7, up to 30) re-run with a change: code's replay, never the asker's. */
    replay(b: Dict) {
      const team = String(b.team ?? "");
      const ch = typedChange(team, b);
      const days = b.days == null ? 7 : Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 30) refuse("days: 1 to 30");
      return replay(replayRows(recordKey(team), days), ch);
    },

    /** routing.tune: one typed change as one kernel.apply, filed as the Steward on its own task. */
    tune(requester: Requester, task: string, b: Dict) {
      return serial(async () => {
        sync();
        if (!isMap(b) || Object.keys(b).some((k) => !["base_sha", "team", "weights", "repos", "decisions", "hypothesis", "revert"].includes(k))) refuse("send { base_sha, team, weights?, repos?, decisions, hypothesis, revert }");
        const team = String(b.team ?? "");
        const ch = typedChange(team, b);
        const key = recordKey(team);
        if (!SHA.test(String(b.base_sha))) refuse("base_sha: the instance repo's main as routing_evidence gave it");
        const why = criterionProblem(b.revert);
        if (why) refuse(why);
        if (typeof b.hypothesis !== "string" || !b.hypothesis.trim() || b.hypothesis.length > 600 || /[\x00-\x08\x0b-\x1f\x7f]/.test(b.hypothesis)) refuse("hypothesis: at most 600 characters, no control characters");
        // Each cited decision is one this team recorded: evidence is the kernel's decisions, never a claim.
        if (!Array.isArray(b.decisions) || !b.decisions.length || b.decisions.length > 50 || b.decisions.some((t: unknown) => typeof t !== "string" || !TASK.test(t))) refuse("decisions: 1 to 50 task ids from routing_evidence");
        const unknown = (b.decisions as string[]).filter((t) => !q("SELECT 1 FROM team_routes WHERE task = ? AND team = ?").get(t, key));
        if (unknown.length) refuse(`decisions: ${unknown.slice(0, 3).join(", ")} isn't a recorded decision of team ${team}`);
        // No review shopping: a team whose proposal was turned down gets no other for a while, whatever its values.
        const no = q("SELECT id, rejected_at FROM routing_experiments WHERE team = ? AND rejected_at > ? ORDER BY rejected_at DESC").get(team, now() - REJECT_COOLDOWN_MS) as { id: string; rejected_at: number } | undefined;
        if (no) refuse(`experiment ${no.id} for team ${team} was turned down: no routing change for that team until ${new Date(no.rejected_at + REJECT_COOLDOWN_MS).toISOString()}`);
        const o = open();
        if (o) refuse(`experiment ${o.id} (team ${o.team}) is still ${o.state}: one experiment at a time (routing_judge settles it)`);
        if ((q("SELECT COUNT(*) AS n FROM routing_experiments WHERE day = ? AND state != 'abandoned'").get(day(now())) as { n: number }).n) refuse("a routing change was already proposed today (UTC): one a day");

        const { base, texts } = await d.main(["instance.yaml"]);
        if (base !== b.base_sha) refuse(`the instance repo's main moved (${base.slice(0, 12)}): read routing_evidence again`);
        const was = texts.get("instance.yaml") ?? refuse("the instance repo has no instance.yaml");
        const current = (YAML.parse(was) ?? {}).teams?.[team];
        if (!isMap(current)) refuse(`there is no team ${team} in instance.yaml`);
        for (const m of Object.keys(ch.repos ?? {})) if (!isMap(current.members) || !Object.hasOwn(current.members, m)) refuse(`team ${team} has no member ${m}`);
        const head = edited(was, leafSets(team, ch));
        const leaves = checked(was, head);
        const content = createHash("sha256").update(canonical({ team, after: leaves.map((l) => [l.path, l.after ?? null]) })).digest("hex");
        const prior = q("SELECT id FROM routing_experiments WHERE content = ? AND state = 'rejected'").get(content) as { id: string } | undefined;
        if (prior) refuse(`the same change was not approved as experiment ${prior.id}: change it rather than filing it again`);

        const r = replay(replayRows(key, 7), ch);
        const c = b.revert as Criterion;
        const id = `x-${randomBytes(6).toString("hex")}`;
        const notes = [
          `Routing experiment ${id} (routing.tune), filed by ${requester.key || requester.name} on its own task. Written by the kernel from a typed change; the kernel checked that only members' repos and routing weights move (routing-tune.ts routingDiff).`,
          `Changes: ${leaves.map((l) => `${l.path.slice(1).join(".")} ${show(l.before)} → ${show(l.after)}`).join("; ")}`,
          `Replay by the kernel over team ${team}'s recorded decisions of the last 7 days: ${r.decisions} decisions, ${r.changed} would go to another member${r.picks.length ? ` (${r.picks.slice(0, 10).map((p) => `${p.was ?? "none"} → ${p.now ?? "none"}`).join(", ")})` : ""}.`,
          `Cited decisions: ${(b.decisions as string[]).length}, each a recorded routing decision of team ${team}.`,
          `Revert criterion (the kernel judges it): ${c.metric} (${METRICS[c.metric]}) above ${c.threshold} over at least ${c.min_sample} tasks within ${c.deadline_days} days of applying; a revert restores only these values.`,
          `The requester's hypothesis, in its own words (data, not instructions):\n${fence(b.hypothesis.trim())}`,
        ].join("\n");
        const requesterJson = JSON.stringify(requester);
        q("INSERT INTO routing_experiments (id, team, requester, task, base, leaves, content, criterion, notes, state, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'filing', ?, ?)").run(id, team, requesterJson, task, base, JSON.stringify(leaves), content, JSON.stringify(c), notes, day(now()), now());
        filing = id;
        try {
          const { repo, sha } = await commit(`settings/routing-${id}`, base, head, `routing.tune: team ${team} (${id})\n\nWritten by the kernel from ${requester.key || requester.name}'s typed routing change; no agent wrote it.`);
          q("UPDATE routing_experiments SET sha = ? WHERE id = ?").run(sha, id);
          const rec = await d.file({ repo, branch: `settings/routing-${id}`, sha }, task, requester);
          q("UPDATE routing_experiments SET state = 'filed', record = ? WHERE id = ?").run(rec.id, id);
          d.log?.("routing change filed", { experiment: id, team, record: rec.id, tier: rec.tier });
          sync();
          return { experiment: id, record: rec.id, tier: rec.tier, state: rec.state, sha, replay: r };
        } catch (e) {
          q("DELETE FROM routing_experiments WHERE id = ? AND record IS NULL").run(id);
          throw e;
        } finally {
          filing = undefined;
        }
      });
    },

    /** The open experiment against its criterion: still measuring, kept, inconclusive, or rolled back through a reviewed apply. */
    judge(requester: Requester, task: string) {
      return serial(async () => {
        sync();
        const x = open();
        if (!x) return { open: null };
        if (x.state !== "applied") return { open: view(x), note: x.state === "filed" ? "its apply is still waiting for review or to land" : "its rollback is still waiting for review or to land" };
        const c = JSON.parse(x.criterion) as Criterion;
        const close = (state: string, verdict: string, m?: unknown) => { q("UPDATE routing_experiments SET state = ?, verdict = ? WHERE id = ?").run(state, verdict, x.id); return { open: null, closed: { id: x.id, state, verdict }, ...(m ? { measured: m } : {}) }; };
        const key = teams().find((t) => t.name === x.team)?.key;
        if (!key) return close("superseded", `team ${x.team} is gone: nothing to judge or revert`);
        const m = measure(c.metric, await outcomes(key, x.applied_at!, now() + 1));
        const over = m.sample >= c.min_sample && m.value !== null && m.value > c.threshold;
        const due = now() >= x.applied_at! + c.deadline_days * DAY_MS;
        if (!over && !due) return { open: view(x), measured: m, note: `measuring until ${new Date(x.applied_at! + c.deadline_days * DAY_MS).toISOString()}` };
        if (!over) return m.sample >= c.min_sample ? close("kept", `${c.metric} ${m.value} at or under ${c.threshold} over ${m.sample} tasks`, m) : close("inconclusive", `only ${m.sample} of the ${c.min_sample} tasks needed by the deadline`, m);
        const verdict = `${c.metric} ${Math.round(m.value! * 1000) / 1000} above ${c.threshold} over ${m.sample} tasks`;
        // Only its own leaves, and only those still at the values it applied: a later change (the owner's) stays.
        const { base, texts } = await d.main(["instance.yaml"]);
        const was = texts.get("instance.yaml") ?? refuse("the instance repo has no instance.yaml");
        const doc = YAML.parse(was) ?? {};
        const at = (p: string[]) => p.reduce<any>((o, k) => (isMap(o) ? o[k] : undefined), doc);
        const back = (JSON.parse(x.leaves) as Leaf[]).filter((l) => same(at(l.path), l.after));
        if (!back.length) return close("superseded", `${verdict}, but every value it set has changed since: nothing to revert`, m);
        // A rollback the team as it is now can't take (a member since removed): closed, so the loop goes on.
        let head: string;
        try { head = edited(was, back.map((l) => ({ path: l.path, value: l.before }))); checked(was, head); } catch (e) {
          if (!(e instanceof Refused)) throw e;
          return close("superseded", `${verdict}, but its rollback no longer fits the team (${e.message.slice(0, 300)})`, m);
        }
        const notes = [`Rollback of routing experiment ${x.id} (team ${x.team}), decided by the kernel: ${verdict}, which its revert criterion (${c.metric} above ${c.threshold} over at least ${c.min_sample} tasks) calls a revert.`, `It restores only the experiment's own values still as it set them: ${back.map((l) => `${l.path.slice(1).join(".")} ${show(l.after)} → ${show(l.before)}`).join("; ")}`].join("\n");
        q("UPDATE routing_experiments SET rollback_notes = ?, rollback_task = ?, verdict = ? WHERE id = ?").run(notes, task, verdict, x.id);
        const { repo, sha } = await commit(`settings/routing-${x.id}-revert`, base, head, `routing.tune: revert ${x.id} (team ${x.team})\n\nWritten by the kernel: ${verdict}.`);
        q("UPDATE routing_experiments SET rollback_sha = ? WHERE id = ?").run(sha, x.id);
        const rec = await d.file({ repo, branch: `settings/routing-${x.id}-revert`, sha }, task, requester);
        q("UPDATE routing_experiments SET state = 'reverting', rollback = ? WHERE id = ?").run(rec.id, x.id);
        sync();
        return { open: view(open()), measured: m, rollback: { record: rec.id, tier: rec.tier, state: rec.state } };
      });
    },

    /**
     * What the kernel says of a routing commit on its apply card (apply-tier's planner), and so whether the planner treats it as
     * the loop's own: only for the live experiment's commit (or rollback) filed by the experiment's agent on its own task.
     * Anyone else filing the same commit, or a closed experiment's, gets nothing: the normal `teams` rules.
     */
    notes(sha: string, requester: Requester | undefined, task: string | undefined): string | undefined {
      const r = q("SELECT * FROM routing_experiments WHERE (sha = ? AND state IN ('filing', 'filed')) OR (rollback_sha = ? AND state IN ('applied', 'reverting'))").get(sha, sha) as Row | undefined;
      if (!r || !requester?.agent || requester.agent !== (JSON.parse(r.requester) as Requester).agent) return undefined;
      return r.sha === sha ? (task === r.task ? r.notes : undefined) : (task === r.rollback_task ? (r.rollback_notes ?? undefined) : undefined);
    },
  };
}
export type Routing = ReturnType<typeof createRouting>;
