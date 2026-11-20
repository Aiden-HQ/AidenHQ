// Agent teams (docs/configuration.md, Teams): a team is one address (the team record, which never runs) over named members, each a
// real agent. A task assigned to the team goes to one member, picked here by a pure function of a snapshot the wake path
// gathers (wakes.ts route). The schema below is the one both compile (scripts/modules.ts) and the router read.

/** Score weights (teams.<t>.routing.weights): repo match, continuity and load. */
export type Weights = { repo: number; continuity: number; load: number };
export const DEFAULT_WEIGHTS: Weights = { repo: 3, continuity: 1, load: 1 };
/** Fields a member, or the team's `defaults`, may set over its template. */
export const MEMBER_FIELDS = ["name", "repos", "model", "reasoning_effort", "max_parallel", "handbook"] as const;
const TEAM_FIELDS = ["template", "members", "defaults", "caps", "routing"];
const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const NAME = /^\p{L}[\p{L} .'-]{0,29}$/u;
/** A repo pattern: `owner/name`, where either part may be `*` (any). */
const PATTERN = /^([\w.-]+|\*)\/([\w.-]+|\*)$/;
const REPOS_MAX = 20;
/** Weight bounds (the learning loop moves weights within them): each 0 to 10, and load at least 1, so load always counts. */
export const WEIGHT_MAX = 10;
export const LOAD_MIN = 1;
/** Continuity: whether a member finished a task in the task's repo within this window. */
export const CONTINUITY_MS = 7 * 86_400_000;

const isMap = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function memberProblems(where: string, m: unknown, named: boolean): string[] {
  if (!isMap(m)) return [`${where}: a map of ${MEMBER_FIELDS.join(", ")}`];
  const out: string[] = [];
  for (const f of Object.keys(m)) if (!(MEMBER_FIELDS as readonly string[]).includes(f) || (!named && f === "name")) out.push(`${where}: unknown field ${f}`);
  if (named && (typeof m.name !== "string" || !NAME.test(m.name))) out.push(`${where}.name: a short name (letters, spaces, . ' -; at most 30)`);
  if (m.repos != null && (!Array.isArray(m.repos) || m.repos.length > REPOS_MAX || m.repos.some((r) => typeof r !== "string" || !PATTERN.test(r)))) out.push(`${where}.repos: a list of at most ${REPOS_MAX} owner/name patterns (either part may be *)`);
  if (m.model != null && (typeof m.model !== "string" || !m.model.trim())) out.push(`${where}.model: a model id`);
  if (m.reasoning_effort != null && (typeof m.reasoning_effort !== "string" || !/^[a-z]{1,20}$/.test(m.reasoning_effort))) out.push(`${where}.reasoning_effort: an effort level`);
  if (m.max_parallel != null && !(Number.isInteger(m.max_parallel) && (m.max_parallel as number) >= 1 && (m.max_parallel as number) <= 10)) out.push(`${where}.max_parallel: 1 to 10`);
  if (m.handbook != null && (typeof m.handbook !== "string" || !m.handbook.trim() || m.handbook.length > 300 || /[\r\n]/.test(m.handbook))) out.push(`${where}.handbook: one line, at most 300 characters`);
  return out;
}

/** What is wrong with one `teams.<name>` entry (empty: nothing). Compile fails on any; the router reads only checked config. */
export function teamProblems(name: string, t: unknown): string[] {
  const at = `teams.${name}`;
  if (!KEY.test(name)) return [`${at}: a team's name is lowercase letters, digits and -`];
  if (!isMap(t)) return [`${at}: a map of ${TEAM_FIELDS.join(", ")}`];
  const out: string[] = [];
  for (const f of Object.keys(t)) if (!TEAM_FIELDS.includes(f)) out.push(`${at}: unknown field ${f} (known: ${TEAM_FIELDS.join(", ")})`);
  if (typeof t.template !== "string" || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(t.template)) out.push(`${at}.template: <module>.<agent>`);
  if (!isMap(t.members) || !Object.keys(t.members).length) out.push(`${at}.members: at least one member`);
  else for (const [k, m] of Object.entries(t.members)) {
    if (!KEY.test(k)) out.push(`${at}.members.${k}: a member's key is lowercase letters, digits and - (it is permanent)`);
    out.push(...memberProblems(`${at}.members.${k}`, m, true));
  }
  if (t.defaults != null) out.push(...memberProblems(`${at}.defaults`, t.defaults, false));
  if (t.caps != null && (!isMap(t.caps) || Object.keys(t.caps).some((k) => k !== "day_usd") || !(typeof t.caps.day_usd === "number" && t.caps.day_usd > 0 && t.caps.day_usd <= 1000))) out.push(`${at}.caps: { day_usd } (USD, above 0, at most 1000): the whole team's day cap`);
  if (t.routing != null) {
    const w = isMap(t.routing) ? t.routing.weights : undefined;
    if (!isMap(t.routing) || Object.keys(t.routing).some((k) => k !== "weights") || !isMap(w) || Object.entries(w).some(([k, v]) => !Object.hasOwn(DEFAULT_WEIGHTS, k) || typeof v !== "number" || !Number.isFinite(v) || v < (k === "load" ? LOAD_MIN : 0) || v > WEIGHT_MAX))
      out.push(`${at}.routing: { weights: { repo, continuity, load } } (each 0 to ${WEIGHT_MAX}; load at least ${LOAD_MIN})`);
  }
  return out;
}

export const weightsOf = (routing?: { weights?: Partial<Weights> }): Weights => ({ ...DEFAULT_WEIGHTS, ...(routing?.weights ?? {}) });
export const repoMatches = (pattern: string, repo: string) => {
  const [po, pn] = pattern.toLowerCase().split("/"), [ro, rn] = repo.toLowerCase().split("/");
  return (po === "*" || po === ro) && (pn === "*" || pn === rn);
};

/** One member as the router sees it now. */
export type Candidate = {
  id: string; key: string; repos: string[]; maxParallel: number; paused: boolean;
  /** Its live jobs, and its other tasks waiting to start (each task counted once). */
  running: number; queued: number;
  /** Whether it finished a task in one of the task's repos within CONTINUITY_MS (1) or not (0); older snapshots hold a count, read as at most 1. */
  done: number;
};
export type Scored = { key: string; id: string; score: number; repo: number; continuity: number; load: number };
export type Decision = { pick?: Scored; scored: Scored[]; excluded: { key: string; why: string }[] };

/**
 * The member a team task goes to. Eligible: not paused, and the team's day cap not used up (`overBudget`). Score =
 * w.repo × repo match (0 or 1) + w.continuity × continuity (0 or 1: finished something in the repo within the window) −
 * w.load × (running + queued) / max_parallel. Continuity is familiarity, not volume, so load decides between familiar members
 * (a count let the busiest member win every task). Ties go to the least load, then the member key. A busy member still gets
 * it: the task waits in its backlog (wakes.ts re-places it if it never starts). No eligible member: no pick.
 */
export function pickMember({ repos, candidates, weights, overBudget = false }: { repos: string[]; candidates: Candidate[]; weights: Weights; overBudget?: boolean }): Decision {
  const excluded: Decision["excluded"] = [];
  const scored: Scored[] = [];
  for (const c of candidates) {
    if (overBudget) { excluded.push({ key: c.key, why: "the team's day cap is used up" }); continue; }
    if (c.paused) { excluded.push({ key: c.key, why: "paused" }); continue; }
    const repo = repos.some((r) => c.repos.some((p) => repoMatches(p, r))) ? 1 : 0;
    const load = (c.running + c.queued) / Math.max(1, c.maxParallel);
    const continuity = Math.min(1, c.done);
    const score = weights.repo * repo + weights.continuity * continuity - weights.load * load;
    scored.push({ key: c.key, id: c.id, score, repo, continuity, load });
  }
  scored.sort((a, b) => b.score - a.score || a.load - b.load || a.key.localeCompare(b.key));
  return { pick: scored[0], scored, excluded };
}

const n = (x: number) => String(Math.round(x * 100) / 100);
/** The decision record on a routed task: fixed format, so a reader (and the learning loop) can parse it. */
export function decisionText({ team, revision, repos, weights, decision, from }: { team: string; revision: string; repos: string[]; weights: Weights; decision: Decision; from?: string }) {
  const lines = [
    !decision.pick ? `**Blocked:** no member of team ${team} can take this task.`
      : from ? `**Re-routed to ${decision.pick.key}** (team ${team}): it never started and ${from} is busy.`
      : `**Routed to ${decision.pick.key}** (team ${team}).`,
    "",
    `- config: ${revision}`,
    `- repos: ${repos.join(", ") || "none named"}`,
    `- weights: repo ${n(weights.repo)}, continuity ${n(weights.continuity)}, load ${n(weights.load)}`,
    ...decision.scored.map((s) => `- candidate ${s.key}: score ${n(s.score)} = repo ${s.repo} × ${n(weights.repo)} + continuity ${s.continuity} × ${n(weights.continuity)} − load ${n(s.load)} × ${n(weights.load)}`),
    ...decision.excluded.map((e) => `- excluded ${e.key}: ${e.why}`),
    `- pick: ${decision.pick?.key ?? "none"}`,
  ];
  return lines.join("\n");
}
