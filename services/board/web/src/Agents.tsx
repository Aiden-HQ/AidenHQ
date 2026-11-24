import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { SignInRequired, api } from "./api";
import { Plan, PlusIcon } from "./components";
import { useEvents } from "./events";
import { useCached } from "./cache";
import { QUERIES, agentOpenQuery, agentProfileQuery, scorecardQuery, useQuery } from "./queries";
import { Bone, FleetSkeleton, SkeletonLines, Updating } from "./Skeleton";
import type { Assignee, Finished, RosterAgent, Session, TaskRef } from "./types";
import { ago, elapsed, runAt as when } from "./util";
import { StatusDot, type StatusTone } from "./ui";

const STATUS: Record<string, { text: string; tone: "ok" | "bad" | "meh" }> = {
  succeeded: { text: "Done", tone: "ok" },
  done: { text: "Done", tone: "ok" },
  failed: { text: "Failed", tone: "bad" },
  error: { text: "Failed", tone: "bad" },
  timed_out: { text: "Timed out", tone: "bad" },
  timeout: { text: "Timed out", tone: "bad" },
  cancelled: { text: "Stopped", tone: "meh" },
  incomplete: { text: "Unfinished", tone: "meh" },
  interrupted: { text: "Interrupted", tone: "meh" },
};
const runStatus = (status: string) => STATUS[status] ?? { text: status, tone: "meh" as const };

/** "+ New agent": a chat with the Agent Architect, opened on what the person needs. */
async function newAgent(onSignIn: () => void, setError: (e: string) => void) {
  const text = window.prompt("What should the new agent do?", "I need an agent that ");
  if (!text?.trim()) return;
  try {
    const { identifier } = await api.newChat(text.trim(), "architect");
    location.hash = `#/c/${identifier}`;
  } catch (e) {
    if (e instanceof SignInRequired) onSignIn();
    else setError((e as Error).message);
  }
}

type Department = RosterAgent["department"];
const GENERAL: Department = { id: "general", name: "General", order: 1_000 };
/** The owner's own agents are listed flat until there are this many; then by department too. */
const FLAT_UNDER = 6;
/** The chief of staff leads its department, as "Your chief of staff". */
const FRONT = "chief-of-staff";

/** Agents by department, in the registry's order (compile resolves it: kernel/defaults.json `departments`). */
function byDepartment(agents: RosterAgent[]): { dept: Department; members: RosterAgent[] }[] {
  const groups = new Map<string, { dept: Department; members: RosterAgent[] }>();
  for (const a of agents) {
    const dept = a.department ?? GENERAL;
    if (!groups.has(dept.id)) groups.set(dept.id, { dept, members: [] });
    groups.get(dept.id)!.members.push(a);
  }
  const front = (a: RosterAgent) => (a.key === FRONT ? 0 : 1);
  for (const g of groups.values()) g.members.sort((x, y) => front(x) - front(y));
  return [...groups.values()].sort((x, y) => x.dept.order - y.dept.order || x.dept.name.localeCompare(y.dept.name));
}

/** Agents with a job running first, a reporting line counting by its busiest member; the order within each half is kept (so with nobody working, nothing moves). */
function workingFirst(agents: RosterAgent[]): RosterAgent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const byKey = new Map(agents.flatMap((a) => (a.key ? [[a.key, a] as const] : [])));
  const hot = new Set(agents.filter((a) => a.state === "working" || a.running > 0).map((a) => a.id));
  // Each working agent warms every agent above it: its team record and whom it reports to.
  for (const a of [...hot].map((id) => byId.get(id)!)) {
    const seen = new Set<string>();
    for (let p = (a.memberOf && byKey.get(a.memberOf)) || (a.reportsTo ? byId.get(a.reportsTo) : undefined); p && !seen.has(p.id); p = (p.memberOf && byKey.get(p.memberOf)) || (p.reportsTo ? byId.get(p.reportsTo) : undefined)) (seen.add(p.id), hot.add(p.id));
  }
  return [...agents].sort((x, y) => Number(hot.has(y.id)) - Number(hot.has(x.id)));
}

/**
 * The org as indented rows: a team's members sit under its record, everyone else under whom they report to (reportsTo); an
 * agent whose parent isn't in this list is a root. The list's order is kept among siblings.
 */
function orgTree(agents: RosterAgent[]): { a: RosterAgent; depth: number }[] {
  const byKey = new Map(agents.flatMap((a) => (a.key ? [[a.key, a] as const] : [])));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const parentOf = (a: RosterAgent) => {
    const p = (a.memberOf && byKey.get(a.memberOf)) || (a.reportsTo ? byId.get(a.reportsTo) : undefined);
    return p && p !== a ? p : undefined;
  };
  const kids = new Map<string, RosterAgent[]>();
  for (const a of agents) {
    const p = parentOf(a);
    if (p) kids.set(p.id, [...(kids.get(p.id) ?? []), a]);
  }
  const out: { a: RosterAgent; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (a: RosterAgent, depth: number) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push({ a, depth });
    for (const k of kids.get(a.id) ?? []) walk(k, depth + 1);
  };
  for (const a of agents) if (!parentOf(a)) walk(a, 0);
  for (const a of agents) walk(a, 0); // a reporting cycle: still listed
  return out;
}

/** A team's load as the owner reads concurrency: jobs running of its members' parallel slots, and what waits. */
type TeamLoad = { running: number; queued: number; capacity: number; size: number; model: string | null };

/** Recent runs folded to one row per task (or per scan, by its title): how many, the latest outcome, when. */
function fold(runs: Finished[]) {
  const rows = new Map<string, { f: Finished; count: number; failed: number }>();
  for (const f of runs) {
    const key = f.tasks.length ? f.tasks.map((t) => t.identifier).join(",") : (f.run?.title ?? f.run?.identifier ?? f.id);
    const row = rows.get(key);
    const bad = runStatus(f.status).tone === "bad" ? 1 : 0;
    if (row) (row.count++, (row.failed += bad));
    else rows.set(key, { f, count: 1, failed: bad });
  }
  return [...rows.values()];
}

/**
 * The Agents page: the fleet as tables, the platform's agents then the owner's own, each by department: where each agent
 * stands, what it's on now, its next scheduled run and its last result. A row opens in place to the rest (routing line,
 * model, every schedule, live plans, recent runs). Then runs from no listed agent (runner jobs).
 *
 * Loads in two parts: the roster (names, departments, schedules: fast) paints the rows; the run history (/api/agents,
 * slower) fills Now and Last result after. Both show the last good copy at once (cache.ts) while they refresh.
 */
export function CrewView({ crew, onSignIn }: { crew: Assignee[]; onSignIn: () => void }) {
  const fleet = useQuery(QUERIES.roster, onSignIn);
  const runs = useQuery(QUERIES.agents, onSignIn);
  const [newError, setNewError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const { reload } = runs;
  useEffect(() => {
    const poll = setInterval(() => document.visibilityState === "visible" && void reload(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => (clearInterval(poll), clearInterval(tick));
  }, [reload]);
  // A Fleet Ops check or a card changes: refresh now (events.ts); the roster too, for a new or paused agent.
  useEvents(["fleet", "approvals"], () => void Promise.all([runs.reload(), fleet.reload()]));

  const data = runs.data;
  const roster = data?.roster ?? fleet.data?.roster;
  const error = newError || runs.error || (!roster ? fleet.error : "");
  const head = (sub: ReactNode) => (
    <header className="page-head">
      <div>
        <h1>Agents</h1>
        <p className="page-sub">{sub}</p>
      </div>
      <span className="spacer" />
      <button className="btn primary" onClick={() => void newAgent(onSignIn, setNewError)}>
        <PlusIcon /> New agent
      </button>
    </header>
  );
  if (!roster)
    return (
      <main className="page wide">
        {head(fleet.error ? "" : "Loading your agents…")}
        {fleet.error ? (
          <div className="offline">Couldn't load your agents: {fleet.error}. Retrying…</div>
        ) : (
          <section className="fleet-section">
            <h2 className="fleet-section-head">Platform agents</h2>
            <FleetSkeleton />
          </section>
        )}
      </main>
    );

  const sessions = data?.sessions ?? [];
  const finishedRuns = data?.finished ?? [];
  const listed = (x: { agentId: string | null }) => roster.some((a) => a.id === x.agentId);
  const other = sessions.filter((s) => !listed(s));
  const otherDone = finishedRuns.filter((f) => !listed(f));
  const working = roster.filter((a) => a.state === "working" && !a.team).length;
  const attention = roster.filter((a) => a.state === "paused" || a.state === "failing").length;
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  // A team record never runs: its row carries its members' runs, and the load against their parallel slots.
  const membersOf = (a: RosterAgent) => (a.team && a.key ? roster.filter((m) => m.memberOf === a.key) : []);
  const teamModel = (ms: RosterAgent[]) => {
    const n = new Map<string, number>();
    for (const m of ms) if (m.model) n.set(m.model, (n.get(m.model) ?? 0) + 1);
    return [...n].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  };
  const row = ({ a, depth }: { a: RosterAgent; depth: number }) => {
    const ms = membersOf(a);
    const ids = new Set([a.id, ...ms.map((m) => m.id)]);
    const mine = sessions.filter((s) => s.agentId && ids.has(s.agentId));
    const parentTeam = a.memberOf ? roster.find((r) => r.key === a.memberOf) : undefined;
    const team: TeamLoad | undefined = a.team
      ? { running: a.running, queued: a.queued, capacity: ms.reduce((n, m) => n + (m.maxParallel ?? 1), 0), size: ms.length, model: teamModel(ms) }
      : undefined;
    const pm = parentTeam ? teamModel(roster.filter((m) => m.memberOf === parentTeam.key)) : null;
    return (
    <AgentRow
      key={a.id}
      a={a}
      depth={depth}
      team={team}
      ownModel={a.memberOf && a.model && a.model !== pm ? a.model : null}
      assignee={crew.find((c) => c.key === a.id) ?? { key: a.id, kind: "agent", name: a.name, ...(a.avatar ? { avatar: a.avatar } : {}) }}
      sessions={mine}
      finished={finishedRuns.filter((f) => f.agentId && ids.has(f.agentId))}
      runsLoaded={!!data}
      now={now}
      open={open.has(a.id)}
      toggle={() => toggle(a.id)}
    />
    );
  };
  // Platform agents ship with AidenHQ (any module); "Your agents" are the instance's own (agents/<key>/ in its repo).
  const platform = roster.filter((a) => a.system !== false);
  const mine = roster.filter((a) => a.system === false);
  const table = (label: string, agents: RosterAgent[], grouped: boolean) => (
    <section className="fleet-section" aria-label={label}>
      <h2 className="fleet-section-head">{label}</h2>
      <div className="fleet" role="table" aria-label={label}>
        <div className="fleet-cols" role="row">
          <span role="columnheader">Agent</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Now</span>
          <span role="columnheader">Next run</span>
          <span role="columnheader">Last result</span>
          <span />
        </div>
        {grouped
          ? byDepartment(agents).map(({ dept, members }) => (
              <div key={dept.id} role="rowgroup" className="fleet-group">
                <div className="fleet-group-head" role="row">
                  <h3>{dept.name}</h3>
                  {dept.description && <span className="hint">{dept.description}</span>}
                </div>
                {orgTree(workingFirst(members)).map(row)}
              </div>
            ))
          : orgTree(workingFirst(agents)).map(row)}
      </div>
    </section>
  );

  return (
    <main className="page wide">
      {head(
        <>
          {roster.length} agents, {data ? (working ? `${working} working now` : "none working now") : "checking who's working"}
          {attention ? `, ${attention} need${attention === 1 ? "s" : ""} you` : ""}
          <Updating on={runs.stale || fleet.stale || !data} />
        </>,
      )}
      {error && <div className="offline">Offline: {error}. Retrying…</div>}
      {platform.length > 0 && table("Platform agents", platform, true)}
      {mine.length > 0 ? (
        table("Your agents", mine, mine.length >= FLAT_UNDER)
      ) : (
        <section className="fleet-section" aria-label="Your agents">
          <h2 className="fleet-section-head">Your agents</h2>
          <p className="empty-state">Agents you add show here. Use New agent to describe one; the Agent Architect designs it with you.</p>
        </section>
      )}
      {(other.length > 0 || otherDone.length > 0) && (
        <section className="agent-group">
          <header className="section-head">
            <h2>Other runs</h2>
            <span className="hint">Runner jobs and runs not tied to an agent above, last 12 hours</span>
          </header>
          <div className="run-list">
            {other.map((s) => (
              <SessionRow key={s.id} s={s} now={now} />
            ))}
            {otherDone.map((f) => (
              <FinishedRow key={f.id} f={f} now={now} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

/** Where the agent stands, from the kernel's jobs (a.state): working, queued (can start now), waiting (only parked waits), idle, failing (its last 3 jobs failed) or paused by the owner. */
function standing(a: RosterAgent, now: number, team?: TeamLoad): { text: string; tone: StatusTone } {
  if (team && (a.state === "working" || a.state === "idle" || a.state === "queued" || a.state === "waiting")) return { text: `${team.running}/${team.capacity} running`, tone: team.running ? "working" : "idle" };
  switch (a.state) {
    case "working": return { text: a.workingSince ? `Working ${elapsed(a.workingSince, now)}` : "Working", tone: "working" };
    case "paused": return { text: "Paused", tone: "needs" };
    case "failing": return { text: "Failing", tone: "failed" };
    case "queued": return { text: "Queued", tone: "idle" };
    case "waiting": return { text: a.waitUntil ? `Waiting until ${when(a.waitUntil)}` : "Waiting", tone: "idle" };
    default: return { text: "Idle", tone: "idle" };
  }
}

/** The soonest scheduled run that isn't paused. */
const nextRun = (a: RosterAgent) => a.schedules.filter((r) => !r.paused && r.nextRunAt).sort((x, y) => x.nextRunAt!.localeCompare(y.nextRunAt!))[0];

/** A click on the row's background opens it; links and buttons inside keep their own clicks. */
const fromRow = (e: MouseEvent, f: () => void) => {
  if (!(e.target as HTMLElement).closest("a, button")) f();
};

function AgentRow({ a, depth, team, ownModel, assignee, sessions, finished, runsLoaded, now, open, toggle }: { a: RosterAgent; depth: number; team?: TeamLoad; ownModel: string | null; assignee: Assignee; sessions: Session[]; finished: Finished[]; runsLoaded: boolean; now: number; open: boolean; toggle: () => void }) {
  const on = sessions.filter((s) => s.state === "working");
  const queued = sessions.filter((s) => s.state === "queued");
  const st = standing(a, now, team);
  const recent = fold(finished);
  const next = nextRun(a);
  const last = recent[0];
  const lastStatus = last?.f.status ?? a.lastRunStatus;
  const lastSt = lastStatus ? runStatus(lastStatus) : null;
  const lastAt = last ? last.f.finishedAt : a.lastRunAt;
  const detail = `agent-detail-${a.id}`;
  const flag = st.tone === "needs" || st.tone === "failed" ? " flag" : lastSt?.tone === "bad" ? " flag-bad" : "";
  return (
    <div role="row" aria-level={depth + 1} style={depth ? ({ "--depth": depth } as CSSProperties) : undefined} className={`fleet-row${a.running ? " busy" : ""}${open ? " open" : ""}${flag}${team ? " team" : ""}${depth ? " nested" : ""}`}>
      <div className="fleet-main" onClick={(e) => fromRow(e, toggle)}>
        <div className="fleet-who" role="cell">
          <span className="crew-portrait">
            <AgentAvatar className="avatar" name={a.name} portrait={assignee.avatar ?? a.avatar} size={36} front={a.key === FRONT} />
          </span>
          <div className="fleet-name">
            <h3>
              <span className="fleet-name-text">{a.name}</span>
            </h3>
            {team ? (
              <p>
                Team of {team.size}
                {team.model ? ` · ${team.model}` : ""}
              </p>
            ) : a.key === FRONT ? (
              <p>Your chief of staff</p>
            ) : (
              (a.title || ownModel) && <p title={a.title ?? undefined}>{[ownModel, a.title].filter(Boolean).join(" · ")}</p>
            )}
          </div>
        </div>
        <div className="fleet-status" role="cell">
          {runsLoaded || st.tone ? <StatusDot tone={st.tone} title={a.stateNote}>{st.text}</StatusDot> : <Bone className="tag-sk" />}
        </div>
        <div className={`fleet-now${on.length || queued.length || !runsLoaded ? "" : " is-empty"}`} role="cell">
          <span className="fleet-label">Now</span>
          {!runsLoaded ? (
            <Bone w="60%" />
          ) : on.length ? (
            <span className="fleet-line">
              <Tasks tasks={on[0]!.tasks} fallback={on[0]!.run} inline />
              {on.length > 1 && <span className="fleet-more">+{on.length - 1} more</span>}
              {queued.length > 0 && <span className="fleet-more">{queued.length} queued</span>}
            </span>
          ) : queued.length ? (
            <span className="fleet-line muted">{queued.length} queued</span>
          ) : (
            <span className="fleet-line faint">Nothing running</span>
          )}
        </div>
        <div className={`fleet-next${next ? "" : " is-empty"}`} role="cell">
          <span className="fleet-label">Next</span>
          {next ? (
            <span className="fleet-line" title={next.title}>
              <b>{when(next.nextRunAt!)}</b>
              <span className="muted fleet-clip">{next.title}</span>
            </span>
          ) : (
            <span className="fleet-line faint">{a.schedules.length ? "Schedules paused" : "When asked"}</span>
          )}
        </div>
        <div className={`fleet-last${lastSt || !runsLoaded ? "" : " is-empty"}`} role="cell">
          <span className="fleet-label">Last</span>
          {!runsLoaded ? (
            <Bone w="70%" />
          ) : lastSt ? (
            <span className="fleet-line" title={last?.f.detail}>
              <span className={`run-status run-${lastSt.tone}`}>{lastSt.text}</span>
              {last && <Tasks tasks={last.f.tasks} fallback={last.f.run} inline />}
              {lastAt && <span className="time">{ago(lastAt, now)}</span>}
            </span>
          ) : (
            <span className="fleet-line faint">No runs yet</span>
          )}
        </div>
        <button className="icon-btn subtle fleet-toggle" aria-expanded={open} aria-controls={detail} aria-label={`${open ? "Hide" : "Show"} ${a.name}'s details`} onClick={toggle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="fleet-detail" id={detail}>
          <section>
            <h4>About</h4>
            {a.title && <p className="fleet-route">{a.title}</p>}
            <dl className="fleet-facts">
              {a.model && (
                <>
                  <dt>Model</dt>
                  <dd>{a.model}</dd>
                </>
              )}
              <dt>Set up</dt>
              <dd>{a.system ? "Platform agent" : "Your agent"}</dd>
            </dl>
            {a.key && <QuickFacts agentKey={a.key} id={a.id} />}
            {a.key && <NeedsYouLine agentKey={a.key} />}
            <div className="ap-bar">
              {a.key && (
                <a className="btn primary" href={`#/agents/${a.key}`}>
                  Open {a.name}'s page
                </a>
              )}
              {/* A paused agent takes no chats (the chat list leaves it out). */}
              {a.state !== "paused" && (
                <a className="btn" href={`#/c/?to=${encodeURIComponent(a.id)}`}>
                  Chat with {a.name}
                </a>
              )}
            </div>
          </section>
          <section>
            <h4>Running now</h4>
            {on.length || queued.length ? (
              <div className="fleet-jobs">
                {on.map((s) => (
                  <div key={s.id} className="crew-job">
                    <Tasks tasks={s.tasks} fallback={s.run} />
                    {s.said && <div className="session-said">{s.said}</div>}
                    {s.plan && <Plan items={s.plan} />}
                  </div>
                ))}
                {queued.length > 0 && (
                  <div className="agent-queued">
                    <span className="queued-dot" /> {queued.length} queued: <Tasks tasks={queued.flatMap((s) => (s.tasks.length ? s.tasks : s.run ? [s.run] : []))} fallback={null} inline />
                  </div>
                )}
              </div>
            ) : (
              <p className="fleet-empty">Nothing right now.</p>
            )}
          </section>
          {!team && <Scorecard id={a.id} />}
        </div>
      )}
    </div>
  );
}

/** Where the agent comes from, and today's spend (the scorecard's last day). */
function QuickFacts({ agentKey, id }: { agentKey: string; id: string }) {
  const profile = useQuery(agentProfileQuery(agentKey)).data;
  const card = useQuery(scorecardQuery(id)).data;
  const today = card?.daily.at(-1)?.costUsd;
  const src = profile?.source;
  return (
    <dl className="fleet-facts">
      <dt>From</dt>
      <dd>{profile ? (src ? `${src.module} module${src.revision ? ` ${src.revision}` : ""}` : "Your agent") : "…"}</dd>
      <dt>Today</dt>
      <dd>{today === undefined ? "…" : usd(today)}</dd>
    </dl>
  );
}

/** The quick look's first line: how many of the agent's tasks wait on the owner, and the first of them. */
function NeedsYouLine({ agentKey }: { agentKey: string }) {
  const { data } = useQuery(agentOpenQuery(agentKey));
  if (!data) return null;
  const first = data.needs[0];
  return first ? (
    <p className="fleet-route">
      <b>{data.needs.length} need{data.needs.length === 1 ? "s" : ""} you:</b> <a href={`#/t/${first.identifier}`}>{first.identifier} {first.title}</a>
    </p>
  ) : (
    <p className="fleet-empty">Nothing needs you.</p>
  );
}

const SPARK = "▁▂▃▄▅▆▇█";
const spark = (xs: number[]) => {
  const max = Math.max(...xs, 0);
  return xs.map((x) => (max ? SPARK[Math.min(7, Math.round((x / max) * 7))] : SPARK[0])).join("");
};
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** The week's diagnostics for one agent: done, sent back (grades), cards rejected, failed runs, billed cost per task; a 7-day trend. Not a ranking. */
export function Scorecard({ id }: { id: string }) {
  const { data: s, error } = useQuery(scorecardQuery(id));
  if (!s && error) return <section><h4>Last 7 days</h4><p className="fleet-empty">Couldn't load the scorecard.</p></section>;
  if (!s) return <section><h4>Last 7 days</h4><SkeletonLines lines={5} /></section>;
  const was = (prior: number) => (prior ? ` (was ${prior})` : "");
  return (
    <section>
      <h4>Last 7 days</h4>
      <dl className="fleet-facts">
        <dt>Tasks done</dt>
        <dd title={s.done.tasks.map((t) => t.identifier).join(", ")}>
          {s.done.count}
          {was(s.done.prior)} <span title="done per day">{spark(s.daily.map((d) => d.done))}</span>
        </dd>
        <dt>Sent back</dt>
        <dd>{s.reopen.graded ? `${s.reopen.reopened} of ${s.reopen.graded} graded tasks` : "no graded tasks"}</dd>
        <dt>Cards rejected</dt>
        <dd>
          {s.approvals.rejected} of {s.approvals.filed} filed{was(s.approvals.priorRejected)}
        </dd>
        <dt>Runs failed</dt>
        <dd>{s.runsFailed}</dd>
        <dt>Cost</dt>
        <dd>
          {usd(s.cost.usd)}
          {s.cost.perDone !== null && `, ${usd(s.cost.perDone)} per finished task`}
          {s.cost.usd > 0 && !s.cost.billed && " (some calls unbilled)"} <span title="cost per day">{spark(s.daily.map((d) => d.costUsd))}</span>
        </dd>
      </dl>
      <p className="fleet-empty">Diagnostics, not a ranking: agents have different jobs.</p>
    </section>
  );
}

function SessionRow({ s, now }: { s: Session; now: number }) {
  const routine = s.run && !s.tasks.some((t) => t.identifier === s.run!.identifier);
  return (
    <div className={`session${s.state === "queued" ? " queued" : ""}`}>
      <div className="session-head">
        <span className={s.state === "queued" ? "queued-dot" : "live-dot"} />
        <b>{s.agent}</b>
        <span className="spacer" />
        {s.startedAt && (
          <span className="time" title={`Started ${new Date(s.startedAt).toLocaleString()}`}>
            {elapsed(s.startedAt, now)}
          </span>
        )}
      </div>
      <Tasks tasks={s.tasks} fallback={s.run} />
      {routine && s.tasks.length > 0 && (
        <div className="session-doing">
          via <a href={`#/t/${s.run!.identifier}`}>{s.run!.title ?? s.run!.identifier}</a>
        </div>
      )}
      {s.said && <div className="session-said">{s.said}</div>}
    </div>
  );
}

function FinishedRow({ f, now }: { f: Finished; now: number }) {
  const st = runStatus(f.status);
  const took = f.startedAt && f.finishedAt ? elapsed(f.startedAt, Date.parse(f.finishedAt)) : undefined;
  return (
    <div className="finished" title={f.detail}>
      <span className={`run-status run-${st.tone}`}>{st.text}</span>
      <span className="finished-agent">{f.agent}</span>
      <Tasks tasks={f.tasks} fallback={f.run} inline />
      <span className="spacer" />
      <span className="time">
        {took && <>{took} · </>}
        {f.finishedAt ? ago(f.finishedAt, now) : ""}
      </span>
    </div>
  );
}

/** The user's tasks a run works on, or the run's own task (a scan) when it names none. */
function Tasks({ tasks, fallback, inline }: { tasks: TaskRef[]; fallback: TaskRef | null; inline?: boolean }) {
  const list = tasks.length ? tasks : fallback ? [fallback] : [];
  if (!list.length) return null;
  return (
    <span className={inline ? "task-links inline" : "task-links"}>
      {list.map((t) => (
        <a key={t.identifier} className="task-link" href={`#/t/${t.identifier}`}>
          <span className="ident">{t.identifier}</span>
          {t.title && <span className="task-title">{t.title}</span>}
        </a>
      ))}
    </span>
  );
}
