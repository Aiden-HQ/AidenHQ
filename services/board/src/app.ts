import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentPaused } from "./aidenhq-sdk/agent-paused.js";
import { forOthers } from "./aidenhq-sdk/for-others.js";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Logger } from "pino";
import { z } from "zod";
import { handbook, history } from "./agent-handbook.js";
import { PauseSchema, setAgentPaused } from "./agent-pause.js";
import { HISTORY_PAGE, agentByKey, agentProfile, historyPage, splitTasks, tasksOf } from "./agent-page.js";
import { timelineOf } from "./timeline.js";
import { liveActivity, type SessionSources } from "./live-activity.js";
import { cachedActivity, lastRunsOf, liveRunsOf, makeRuns, pastRunsOf, type LiveRun, type Work } from "./runs.js";
import { agentsView, roster, runTasks, workingOn, type RunContext, type TaskRef, type Working } from "./activity.js";
import { RecurringSchema, changeRecurring, recurringView } from "./recurring.js";
import { ScheduleSchema, scheduleMove } from "./scheduled-moves.js";
import { AddAgentSchema, BadRequest, CreateSchema, HandOverSchema, PassSchema, hasMarker, UpdateSchema, assignees, buildBoard, closedAt, commentView, displayText, executorOf, isWork, openrouterEngine, paperclipUpdate, replyTarget, toCard, workCard, type Assignee, type WorkCard } from "./board.js";
import { FOR_OTHERS, RELAY_MARKER, closedIssue, crewOf, deliveredFrom, deliveredText, foldedChildren, fromMarker, handOverText, mentionedAgents, withHandle, partsToClose, summaryOf, waitsOnItsOwn, type DeliveredFrom } from "./crew.js";
import { AccountError, forwardedProto, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import { INLINE_TYPES, MAX_UPLOAD_BODY, UploadSchema, decode, fileType, fileViews, isPdf, pdfText, safeName } from "./files.js";
import { ControlSchema, CostsSchema, RelaySchema, Refused, holdsRole, appsApi, assertMeantTask, boundedFleetStatus, fleetControl, fleetCosts, fleetStatus, relayableWords, requireAgent, requireFleetRole } from "./fleet.js";
import { metricsText } from "./monitoring.js";
import { isLive, kernelRecords, shownWait, type Approval, type Records, type SettingsCredential } from "./records.js";
import { gatherFacts, scorecard, statusSummary } from "./fleet-stats.js";
import type { AuthorKind, Flow } from "./flow.js";
import { moduleAuthority, moduleStates } from "./modules.js";
import { CommitUnreadable, agentGrants, browseModules, createResolver, marketplacesOf } from "./marketplace.js";
import { connectionsView, readSources, readUpdates, settingsView, type Probe } from "./settings.js";
import { ChangeRefused, ChangesSchema, SETTINGS_LABEL, changesOf, checkChange, settingsByModule, stageOf, taskFor, type Change } from "./settings-change.js";
import { createGrading, gradePassed, type Grading } from "./grading.js";
import { CodeReviewSchema, CombosSchema, TreeRequestSchema, configProblems, insightsOf, upgradeConfig } from "./reviews.js";
import { ReviewsRefused, ReviewsUnavailable, type Reviews } from "./reviews-client.js";
import { UsageSchema, keyUsage, prices, spendSummary } from "./costs.js";
import { ledgerRange, ledgerSummary, ledgerTop } from "./cost-ledger.js";
import { descendants, featureCost, recentFeatures } from "./feature-cost.js";
import { MergeSchema, mergedDescription } from "./merge.js";
import { deviceRoutes } from "./device-signin.js";
import { McpAuthFailed, SIGNIN_LOOPBACK, asksValues, pastedCallback, vendorWords, type McpAuth, type McpAuthStatus } from "./mcpauth.js";
import { organisationRoutes, type OrganisationPoint } from "./organisations.js";
import { setupFlowRoutes, type SetupFlowPoint } from "./setup-flows.js";
import type { SetupField } from "./config.js";
import { welcomeRoutes } from "./welcome.js";
import { GoogleAuthFailed, loopbackPort, type GoogleAuth } from "./google.js";
import { OPEN, Paperclip, PaperclipError, actingAccount, type Agent, type Attachment, type Comment, type Issue, type Label, type Routine } from "./paperclip.js";
import { createMcp, WRITE_TOOLS } from "./mcp.js";
import { createMcpAuth } from "./mcp-auth.js";
import { accountSession, type BoardSession, type SessionOf } from "./session.js";
import { laneAgents, laneMessages, laneSend, type LaneOptions } from "./lane.js";
import { NOTICE_MARKER, askedQuestions, chatAgent, chatAgentMarker, conversation, lastWord, pickAgent, type Message } from "./chats.js";
import { isActive, needsOwner, noStates, shown, statesOf, waitsForAnswer, type ShownState, type StateRow, type TaskStates } from "./task-state.js";
import { addDays, nextWorkday, type Weekday } from "./dates.js";
import { BUCKETS, isBucket, localDate, type Store } from "./store.js";
import { CreateViewSchema, UpdateViewSchema, ViewSpecSchema, type View } from "./views.js";
import { AsideSchema, askGateway, asideMessages, lineageTotal, modelOf, stillSettled, type LineageRow } from "./lineage.js";

/** One module sign-in (board.signins), with its proxy client. */
export interface SignIn { id: string; label: string; connect: string; callback: string; mode?: "redirect" | "device"; httpsOnly?: boolean; missing: string; stopped: string; fields: SetupField[]; auth: McpAuth }

export interface AppOptions {
  /** Paperclip through the kernel, as the owner: every read and every write (all admins write as the owner, 2026-11-12). */
  paperclip: Paperclip;
  /**
   * Who a request comes from, in place of `accounts` (tests only: a stub resolver). The listeners in main.ts never set it;
   * "lan" refuses to start with neither.
   */
  session?: SessionOf;
  store: Store;
  log: Logger;
  allowedHosts: string[];
  staticDir: string;
  timezone: string;
  /** The days Tomorrow rolls into Today; Monday to Friday when not given. */
  workdays?: Weekday[];
  /** Slack host → workspace or organization ID, so the web app opens Slack links in the desktop app. */
  slackTeams?: Record<string, string>;
  /**
   * "lan": the board's https address and home network (3121), a signed-in admin on every API route (admins sign in on the
   * kernel's admin listener, 3120). "internal": the tasks bridge and the kernel, with a bearer token, /internal/ only.
   */
  mode?: "lan" | "internal";
  /** GitHub's REST API for a marketplace's newest pinnable commit (tests: a fake). */
  fetch?: typeof fetch;
  /** The kernel's admin listener (AIDENHQ_ADMIN_URL): sign-in, and the approval page where every card is decided. */
  adminUrl?: string;
  /** googleConnect: Google's Connect from the board's https address `url` (a Web-app OAuth client, ops/setup.sh). */
  lan?: { url: string; googleConnect?: boolean };
  internalToken?: string;
  /** The fast chat lane: its agents and their chat tasks, from the grants table; without it the lane routes answer empty. */
  lane?: LaneOptions;
  /** Where a Codex agent's session log is (see live-activity.ts): without it, a working agent shows no steps. */
  sessions?: SessionSources;
  /** Google sign-in state and re-consent; no banner and no reconnect without it. */
  google?: GoogleAuth;
  /** The modules' sign-ins through their MCP proxies (board.signins, config.ts): a banner and a Connect each. */
  signIns?: SignIn[];
  /** Organisations that run internal apps (organisations.ts): choosing one writes its public client values. */
  organisations?: OrganisationPoint[];
  /** The modules' setup flows (board.setup_flows, setup-flows.ts), with each pair token read from the vault; fetchImpl stands in for fetch to the module's pairing endpoint. */
  setupFlows?: { flows: (SetupFlowPoint & { token?: string })[]; fetchImpl?: typeof fetch };
  /** The first-run wizard's finished marker (data/board/welcome-sent): present means the welcome was sent. */
  welcomeMarker?: string;
  /** The grading module's client (grading.ts); default: built from GRADING_URL and GRADING_BOARD_KEY_FILE. */
  grading?: Grading;
  /** The code-review module's state service, through the kernel (reviews-client.ts). Without it, the Reviews page says the module is off. */
  reviews?: Reviews;
  /**
   * "internal" mode: the kernel's key (secret gateway_board_key, x-gateway-key; held only by the kernel and the board): the model
   * gateway reads its settings, and channels reach the owner's cards, decisions and notices only through the kernel (lean-core 2f).
   */
  gatewayKey?: string;
  /** The model gateway: its spend summary and usage ledger (costs.ts). */
  gateway?: { url: string; token: string };
  /** The kernel's records, read-only (records.ts): the cards every view shows. Without it, there are none. */
  records?: Records;
  /** The kernel's jobs (runs.ts kernelWork): the run pages and a task's run links. Without it, there are none. */
  work?: Work;
  /** The kernel's task states (task-state.ts): the one state every view shows. Without it, no task has one. */
  taskStates?: TaskStates;
  /** The kernel's flow reads (flow.ts): the Flow page. Without it, the page is empty. */
  flow?: Flow;
  /**
   * Board sign-in (kernel-auth.ts, docs/design/access.md): every route on "lan" needs a ready admin's board session, handed off
   * by the kernel. Required there (or the `session` stub).
   */
  accounts?: KernelAuth;
}

/** What the board and agents see of a card; the executor's args stay in the kernel, and a wait reason is bounded here. */
const approvalView = (approval: Approval) => {
  const { args: _args, ...a } = approval;
  return { ...a, ...(a.wait !== null ? { wait: shownWait(a.wait) } : {}) };
};
/** A merge card's view: the PRs and heads it is bound to (never the args whole), so a run can match the head it published. */
const mergeView = (a: Approval) => {
  const prs = ((a.args as { prs?: { repo?: unknown; number?: unknown; head?: unknown }[] } | null)?.prs ?? [])
    .filter((p) => typeof p?.repo === "string" && Number.isInteger(p?.number) && typeof p?.head === "string")
    .map((p) => ({ repo: String(p.repo), number: Number(p.number), head: String(p.head) }));
  return { ...approvalView(a), ...(prs.length ? { prs } : {}) };
};

const REF = /^(?:[0-9a-f-]{36}|[A-Z][A-Z0-9]{1,9}-\d{1,7})$/;
const RECENT_MS = 48 * 3_600_000;
/** How long a board read waits for the parents outside its inventory (Agent work's "part of" links). */
const PARENTS_MS = 1_500;
const WORKWEEK: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

// The page and its assets only. Remote images are blocked too (tracking pixels in email/Slack text).
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly errors?: { field: string; message: string }[]) {
    super(message);
  }
}
/** A saved board written at a stale revision: the 409 carries the row as it is now (null: deleted elsewhere). */
class ViewConflict extends HttpError {
  constructor(readonly current: View | null) {
    super(409, current ? "this board changed elsewhere" : "this board was deleted elsewhere");
  }
}

/**
 * Requests must name an allowed host (DNS rebinding), and writes must be same-origin JSON with the
 * board's header (a cross-site form or fetch can't add it without a CORS preflight, which is never answered).
 */
export function checkRequest(req: Pick<IncomingMessage, "method" | "headers" | "url">, allowedHosts: string[], boardHeader = true): string | undefined {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!allowedHosts.includes(host)) return "unknown host";
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return "JSON only";
  if (boardHeader && req.headers["x-aidenhq-board"] !== "1") return "missing board header";
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      // Scheme, host and port (the scheme from X-Forwarded-Proto, which `tailscale serve` sets).
      if (new URL(origin).origin !== new URL(`${forwardedProto(req)}://${host}`).origin) return "cross-origin";
    } catch {
      return "bad origin";
    }
  } else if (origin === "null") return "opaque origin";
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) return "cross-site";
  return undefined;
}

/** The board's listener, and its sweep (the writes the live watch runs: see `sweep`). */
export function createApp(opts: AppOptions): Server & { sweep(): Promise<void> } {
  const { paperclip: boardPc, store, log } = opts;
  const mode = opts.mode ?? "lan";
  if (mode !== "internal" && !opts.accounts && !opts.session) throw new Error(`the ${mode} listener needs board accounts`);
  const grading = opts.grading ?? createGrading();
  const reviews = opts.reviews ?? undefined;
  const resolveCommit = createResolver(opts.fetch ?? fetch);
  /** The grades of these tasks; the grading module unreachable: undefined, so the caller leaves its graded closes undone. */
  const gradesOf = (ids: string[]) => grading.grades(ids).catch((err) => (log.warn({ err: String(err) }, "grading module unreachable; not closing graded parts as done"), undefined));

  /**
   * Every admin writes as the owner (through the kernel: agents act on their words, owner decision 2026-11-12). Which
   * account wrote a task or comment is recorded (`authored`) from the request's session, for the board's "by <name>" label;
   * never in the text. The kernel is told the account with each write it makes for a session (actingAccount), and logs it.
   * Outside a session (the internal listener, timers, the board's own notices) nothing is recorded.
   */
  /** `req`: a signed-in browser request (routeApi), whose board session a settings change forwards to the kernel. */
  const perRequest = new AsyncLocalStorage<{ session: BoardSession | null; via?: "mcp"; req?: IncomingMessage; credential?: SettingsCredential }>();
  const pc = new Proxy(boardPc, {
    get(client, prop) {
      const value = Reflect.get(client, prop, client);
      if (typeof value !== "function") return value;
      const s = perRequest.getStore()?.session;
      const account = s && s !== OPERATOR ? s.accountId : undefined;
      // What the board posts or opens is announced to open boards (events.ts): the task's id only.
      if (prop === "addComment" || prop === "createIssue")
        return async (...args: unknown[]) => {
          const made = await (account ? actingAccount.run(account, () => value.apply(client, args)) : value.apply(client, args));
          if (account) store.setAuthored(made.id, account);
          store.events.emit("chat", prop === "addComment" ? String(args[0]) : made?.id);
          return made;
        };
      return account ? (...args: unknown[]) => actingAccount.run(account, () => value.apply(client, args)) : value.bind(client);
    },
  }) as Paperclip;

  /** Display names of the accounts other than the owner: what they wrote or decided carries a "by <name>" label. */
  async function bylines(): Promise<Map<string, string>> {
    if (!opts.accounts) return new Map();
    return new Map((await opts.accounts.names()).filter((a) => !a.owner).map((a) => [a.id, a.name || a.email]));
  }
  /** The account behind the request, named to the kernel when it stops a job (the board's own timers: "operator"). */
  const stopper = () => perRequest.getStore()?.session?.accountId ?? "operator";
  /** The signed-in admin's name when that admin is not the owner (what the lane labels "by <name>"). */
  async function laneByline(_req: IncomingMessage): Promise<string | undefined> {
    const s = perRequest.getStore()?.session;
    return s && s !== OPERATOR ? (await bylines()).get(s.accountId) : undefined;
  }
  /** `{ by }` for something an admin other than the owner wrote (a task or comment id), else nothing. */
  const byOf = (names: Map<string, string>, id: string) => {
    const name = names.get(store.authoredBy(id) ?? "");
    return name ? { by: name } : {};
  };
  /** An approval as the board shows it, with the deciding admin's name when that isn't the owner. */
  const shownApproval = (names: Map<string, string>, a: Approval) => {
    const name = a.decidedBy?.startsWith("account:") ? names.get(a.decidedBy.slice("account:".length)) : undefined;
    return { ...approvalView(a), ...(name ? { decidedByName: name } : {}) };
  };
  // Every approval record lives in the kernel (records.ts). A record names its task by id (and its identifier when its filer knew it).
  const records = opts.records ?? kernelRecords(undefined);
  /**
   * A sign-in or setup flow for `module` finished: the open tabs refresh, and the kernel clears the module's down state and wakes
   * the tasks waiting on it. A kernel that doesn't answer is logged, not fatal: the next successful tool call clears the state too.
   */
  function connected(module: string) {
    store.events.emit("connections");
    void records.connectionOk(module).catch((err) => log.warn({ err: String((err as Error).message ?? err).slice(0, 300), module }, "couldn't tell the kernel a connection is up"));
  }
  const identifiers = new Map<string, string>();
  async function named<T extends Approval>(a: T): Promise<T> {
    if (a.identifier !== a.issueId) return a;
    const id = identifiers.get(a.issueId) ?? (await pc.issue(a.issueId).then((i) => i.identifier, () => undefined));
    if (id) identifiers.set(a.issueId, id);
    return id ? { ...a, identifier: id } : a;
  }
  const cardsOf = async (state: Parameters<Records["list"]>[0], opt?: Parameters<Records["list"]>[1]) => Promise.all((await records.list(state, opt)).map(named));
  /** The last complete live read: a failed page falls back to it, never to a short list that would drop a blocked card. */
  let liveCache: Approval[] | undefined;

  const sessionOf = liveActivity(opts.sessions);
  const work = opts.work ?? { job: async () => null, task: async () => [], agent: async () => [], activity: async () => ({ running: [], recent: [], queued: [], parked: [], failing: [] }), stop: async () => [] };
  const kernelActivity = cachedActivity(work);
  const liveRuns = async () => liveRunsOf(await kernelActivity());
  const recentRuns = async () => pastRunsOf(await kernelActivity());
  const taskStates = opts.taskStates ?? noStates;
  /** Rows as views show them: what a row's ref names (a card's sentence, a blocker, how a job ended) is read from what the board already has. */
  /** `known`: identifiers the caller already has (by task id), so only the others are read from the kernel. */
  async function shownRows(rows: StateRow[], known = new Map<string, string>()): Promise<ShownState[]> {
    // A task's own ref (a handback, an orphaned task) names itself: nothing to read.
    const refs = rows.flatMap((r) => [r.ref, r.blocker, ...r.attention.map((a) => a.ref)].filter((x): x is string => Boolean(x) && x !== `task:${r.task}`));
    const blockers = [...new Set(refs.filter((x) => x.startsWith("task:")).map((x) => x.slice(5)).filter((t) => !known.has(t)))];
    const [named, cards, activity] = await Promise.all([
      blockers.length ? statesOf(taskStates, blockers) : new Map<string, StateRow>(),
      refs.some((x) => x.startsWith("record:")) ? records.list("pending").catch(() => []) : [],
      refs.some((x) => x.startsWith("job:")) ? kernelActivity() : undefined,
    ]);
    const jobs = new Map((activity?.recent ?? []).map((j) => [j.id, j]));
    return rows.map((r) => shown(r, { identifier: (t) => known.get(t) ?? named.get(t)?.identifier ?? undefined, card: (id) => cards.find((c) => c.id === id)?.sentence, job: (id) => jobs.get(id) }));
  }
  /** The state of each task (by id) the kernel has facts for; a task it has none for isn't in the map and shows none. */
  async function stateRows(ids: string[]): Promise<Map<string, ShownState>> {
    const read = await statesOf(taskStates, ids);
    return new Map((await shownRows([...read.values()])).map((r) => [r.task, r]));
  }
  const runOf = makeRuns({ work, store, grantsFile: process.env.AIDENHQ_GRANTS_FILE });
  /** The newest runs (kernel jobs) on a task, for the links to their run pages. */
  const runLinks = async (issueId: string, agents: Agent[]) =>
    (await work.task(issueId).catch(() => [])).slice(0, 6).map((j) => ({ id: j.id, agent: agents.find((a) => a.id === j.agent)?.name ?? "Agent", status: j.state, at: j.started_at }));
  /** A run's page data with the names of its agent and task. */
  async function runView(id: string) {
    const run = await runOf(id);
    if (!run) throw new HttpError(404, "the kernel has no such run");
    const [agents, issue] = await Promise.all([pc.agents(), run.issueId ? pc.issueSummary(run.issueId).catch(() => undefined) : undefined]);
    return { ...run, agent: agents.find((a) => a.id === run.agentId)?.name ?? "Agent", issue: issue ? { identifier: issue.identifier, title: issue.title } : null };
  }
  /** A Paperclip-run Codex agent's live words, plan and steps from its session log, on top of what Paperclip says. */
  async function withSession(w: Working | null | undefined, live: LiveRun[], issueId: string, full: boolean): Promise<Working | null> {
    const run = w && !w.queued && !w.plan ? live.find((r) => r.issueId === issueId && r.status === "running") : undefined;
    const a = run && (await sessionOf(run.agentId, run.startedAt));
    if (!w || !a) return w ?? null;
    return { ...w, ...(a.said ? { said: a.said, saidAt: a.saidAt } : {}), ...(full ? { ...(a.plan ? { plan: a.plan } : {}), ...(a.steps.length ? { steps: a.steps } : {}) } : {}) };
  }

  async function context() {
    const [me, agents, labels, company] = await Promise.all([pc.me(), pc.agents(), pc.labels(), pc.company()]);
    return { me, agents, labels, assignees: assignees(agents), prefix: company.issuePrefix ?? "" };
  }

  /**
   * Setup's log tasks an agent holds, from the grants table only (the kernel's task-scope.ts logTasks reads the same fields):
   * logs, never board work.
   */
  const logTasks = (): Set<string> => {
    try {
      const g = JSON.parse(readFileSync(process.env.AIDENHQ_GRANTS_FILE ?? "", "utf8")) as { agents?: Record<string, { memory_inbox?: string; review_log?: string; chat_task?: string }>; fleet_issues?: string };
      return new Set([...Object.values(g.agents ?? {}).flatMap((a) => [a.memory_inbox, a.review_log, a.chat_task]), g.fleet_issues].filter((x): x is string => typeof x === "string" && x !== ""));
    } catch { return new Set(); }
  };
  /** The tasks the board shows: assigned to the user, the Researcher or an Engineer; never setup's log tasks an agent holds. */
  const mine = (issues: Issue[], ctx: { me: string; assignees: Assignee[] }) =>
    issues.filter((i) => (i.assigneeAgentId ? ctx.assignees.some((a) => a.key === i.assigneeAgentId) && !logTasks().has(i.id) && !logTasks().has(i.identifier) : i.assigneeUserId === ctx.me));

  /** A task the board may change: assigned to the user, the Researcher or an Engineer. */
  async function ownIssue(ref: string) {
    if (!REF.test(ref)) throw new HttpError(400, "bad task reference");
    const [ctx, issue] = await Promise.all([context(), pc.issue(ref)]);
    // A chat (label `chat`) is the owner's conversation with any agent.
    const assigned = isChat(issue, ctx) || mine([issue], ctx).length > 0;
    return { ctx, issue, assigned };
  }

  /** `ownIssue`, refused unless the board may change it. */
  async function editableIssue(ref: string, refusal = "this task isn't yours or the Researcher's") {
    const own = await ownIssue(ref);
    if (!own.assigned) throw new HttpError(403, refusal);
    return own;
  }

  const isChat = (i: Issue, ctx: { labels: Label[] }) => Boolean(i.labels?.some((l) => l.name === "chat") || i.labelIds?.some((id) => ctx.labels.find((l) => l.id === id)?.name === "chat"));

  /** The kernel (gateway_board_key): every channel reaches the owner's cards, decisions and notices only through it. */
  const kernelKeyed = (req: IncomingMessage) => Boolean(opts.gatewayKey && keyMatches(req.headers["x-gateway-key"], opts.gatewayKey));
  /** An agent through the tasks bridge: the kernel's caller assertion (X-AidenHQ-Caller), granted `tool` on paperclip_tasks (and `role`, if named). */
  async function requireAgentTool(req: IncomingMessage, tool: string, role?: string) {
    const ok = (g: { roles?: string[]; tools?: Record<string, string[]> }) => (g.tools?.paperclip_tasks ?? []).includes(tool) && (!role || (g.roles ?? []).includes(role));
    try {
      return await requireAgent(pc, req, ok, `only an agent granted ${tool}${role ? ` with the ${role} role` : ""} may call this`);
    } catch (err) {
      throw err instanceof Refused ? new HttpError(403, err.message) : err;
    }
  }

  /**
   * Memory inboxes (memory_note): the grants table names each agent's inbox task, and only the tasks bridge's memory_note
   * writes there. Every board tool an agent calls on a named task refuses one, before any other check. Read fresh.
   */
  async function refuseMemoryInbox(...refs: string[]) {
    let inboxes: Set<string>;
    try {
      const agents = JSON.parse(readFileSync(process.env.AIDENHQ_GRANTS_FILE ?? "", "utf8"))?.agents ?? {};
      inboxes = new Set(Object.values(agents as Record<string, { memory_inbox?: string }>).flatMap((g) => (g.memory_inbox ? [g.memory_inbox] : [])));
    } catch {
      return;
    }
    if (!inboxes.size) return;
    // A malformed reference is left to the route's own check.
    for (const ref of refs.filter((r) => REF.test(r))) {
      const id = /^[0-9a-f-]{36}$/i.test(ref) ? ref : (await pc.issue(ref)).id;
      if (inboxes.has(id)) throw new HttpError(403, "that task is a memory inbox; only memory_note writes there");
    }
  }

  /** A label by name, created on first use. */
  async function labelNamed(ctx: { labels: Label[] }, name: string, color: string): Promise<Label> {
    return ctx.labels.find((l) => l.name === name) ?? (await pc.createLabel(name, color));
  }

  /** A call to the code-review service: off answers 404, its refusals 400 in its words, unreachable 502. */
  async function reviewsCall<T>(f: (r: Reviews) => Promise<T>): Promise<T> {
    if (!reviews) throw new HttpError(404, "the code-review module is off");
    try {
      return await f(reviews);
    } catch (e) {
      if (e instanceof ReviewsRefused) throw new HttpError(e.status === 404 ? 404 : 400, e.message);
      if (e instanceof ReviewsUnavailable) throw new HttpError(502, e.message);
      throw e;
    }
  }

  /**
   * A typed settings change (docs/design/settings-changes.md): checked, filed as the owner's own task (kept here by task id for
   * the page), and handed to the kernel with the owner's sign-in it was made in (the board session of a save, the OAuth bearer
   * of the MCP's change_settings), so the kernel checks it and decides the change as that account.
   */
  async function fileSettingsChange(changes: Change[]) {
    const ctx0 = perRequest.getStore();
    let credential = ctx0?.credential;
    if (!credential && ctx0?.req && opts.accounts) {
      const board = (await opts.accounts.sessionOf(ctx0.req))?.token;
      if (!board) throw new HttpError(401, "sign in");
      credential = { board };
    }
    const { compiled, catalog } = readSources(settingsFiles());
    try {
      for (const ch of changes) checkChange(ch, compiled, catalog);
    } catch (e) {
      if (e instanceof ChangeRefused) throw new HttpError(400, e.message);
      throw e;
    }
    // The module's own check of the values it is about to be given (module.yaml `validate:`): a refusal is the field's error.
    const unchecked: string[] = [];
    for (const [module, settings] of settingsByModule(changes, catalog)) {
      const v = await records.validate(module, settings).catch((e: Error) => { throw new HttpError(502, `couldn't check ${module}'s settings: ${e.message}`); });
      if (!v.ok) throw new HttpError(422, v.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join(" "), v.errors);
      if (v.unchecked) unchecked.push(v.unchecked);
    }
    const ctx = await context();
    const label = await labelNamed(ctx, SETTINGS_LABEL, "#7048e8");
    const { title, description } = taskFor(changes, compiled);
    const issue = await pc.createIssue({ title, description, status: "todo", priority: "medium", assigneeUserId: ctx.me, labelIds: [label.id] });
    store.setMeta(`settings-change:${issue.id}`, JSON.stringify(changes));
    // The kernel checks it again, has the instance repo's code host write exactly its files and files the apply on the task.
    let filed: { record: string; tier: number; state: string };
    try {
      filed = await records.settingsChange(issue.id, changes, credential);
    } catch (e) {
      if (!(e as { refused?: boolean }).refused) {
        // A lost response, a timeout or a 5xx: the kernel may have filed it, so the task stays open to show whatever it did.
        const why = String((e as Error).message).slice(0, 300);
        await pc.addComment(issue.id, `**Outcome unknown:** ${why}. The kernel may still have filed this change.`).catch(() => {});
        log.warn({ issue: issue.identifier, err: why }, "settings change outcome unknown");
        throw new HttpError(502, `couldn't tell whether the change was written (${issue.identifier}): ${why}`);
      }
      await pc.addComment(issue.id, `**Not written:** ${String((e as Error).message).slice(0, 500)}`).catch(() => {});
      await pc.updateIssue(issue.id, { status: "cancelled" }).catch(() => {});
      log.warn({ issue: issue.identifier, err: String((e as Error).message).slice(0, 300) }, "settings change not written");
      throw new HttpError(422, `not written: ${(e as Error).message}`);
    }
    log.info({ issue: issue.identifier, changes: changes.map((c) => c.kind) }, "settings change filed");
    return { identifier: issue.identifier, ...filed, ...(unchecked.length ? { unchecked } : {}) };
  }

  // Agent activity (Paperclip runs).
  /** The task a run is attached to, and the user's tasks it works on. */
  async function runContext(issueId: string | null, prefix: string): Promise<RunContext> {
    if (!issueId) return { run: null, tasks: [] };
    const issue = await pc.issueSummary(issueId).catch(() => undefined);
    if (!issue) return { run: null, tasks: [] };
    const tasks = runTasks(issue, prefix);
    await titled(tasks);
    return { run: { identifier: issue.identifier, title: issue.title }, tasks };
  }

  /** Names the tasks that carry only an identifier, looked up at once. */
  const titled = (tasks: TaskRef[]) => Promise.all(tasks.filter((t) => t.title == null).map(async (t) => (t.title = (await refCache(t.identifier).catch(() => null))?.title)));

  async function activity(ctx: { agents: Awaited<ReturnType<typeof pc.agents>>; prefix: string }, withPast: boolean) {
    // The roster never fails the page: without routines or run history, cards just show less. Started alongside the runs.
    const rosterParts = withPast ? pc.routines().catch(() => []) : undefined;
    const [live, past] = await Promise.all([liveRuns(), withPast ? recentRuns() : Promise.resolve([])]);
    const view = await agentsView({ live, past, agents: ctx.agents, resolve: (id) => runContext(id, ctx.prefix) });
    if (!rosterParts) return view;
    await titled([...view.sessions, ...view.finished].flatMap((x) => x.tasks));
    const act = await kernelActivity();
    return { ...view, roster: roster(ctx.agents, await rosterParts, lastRunsOf(act), act) };
  }

  /** Who is working on which task. Never fails the board: without it, cards just show no activity. */
  async function working(ctx: Parameters<typeof activity>[0]) {
    try {
      const view = await activity(ctx, false);
      return { map: workingOn(view.sessions), active: view.sessions.filter((x) => x.state === "working").length };
    } catch (err) {
      log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "agent activity unavailable");
      return { map: new Map<string, never>(), active: 0 };
    }
  }

  /**
   * The one issue inventory both Tasks layouts are built from: the open issues and those closed in the last 48 hours (each list
   * paged to LIST_BOUND; `incomplete` when a bound cut it), the kernel's snapshot of the open tasks and those it saw close in that
   * window (one read, one `as_of`), and the project catalog (null when it can't be read). Read-only: the sweep writes.
   */
  async function inventory() {
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const [ctx, open, closed, read, projects] = await Promise.all([
      context(),
      pc.openListed(),
      pc.closedListed(since),
      taskStates.read({ open: true, closed_since: since }),
      pc.projects().catch((err) => (log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "project catalog unavailable"), null)),
    ]);
    return { ctx, since, open: open.issues, closed: closed.issues, incomplete: open.incomplete || closed.incomplete, read, projects };
  }

  /**
   * Agent work: every issue its own card (no folding), with its kernel lane. Open issues all show (a task with no kernel row is
   * Idle, "No reported state"); a closed one only while the kernel's row says it closed in the window. The brief, the owner's
   * settings tasks and setup's log tasks are never work.
   */
  async function agentWork(inv: Awaited<ReturnType<typeof inventory>>, states: Map<string, ShownState>, ctx: Awaited<ReturnType<typeof context>>): Promise<WorkCard[]> {
    const logs = logTasks();
    const byId = new Map([...inv.closed, ...inv.open].map((i) => [i.id, i]));
    const kids = new Map<string, string[]>();
    for (const i of byId.values()) if (i.parentId && i.assigneeAgentId) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i.assigneeAgentId]);
    const shown = [...byId.values()].filter((i) => isWork(i) && !logs.has(i.id) && !logs.has(i.identifier));
    // Done: the kernel's row is done and Paperclip's own close time is in the window (a close fact the kernel dated by a later
    // edit never brings an old task back).
    const cards = shown.filter((i) => !closedIssue(i) || (states.get(i.id)?.lane === "done" && closedAt(i) >= inv.since));
    // A parent outside the inventory (closed before the window) is read by id, a few at a time (issueSummary caches each a
    // minute), for at most PARENTS_MS: a link still missing then shows on the next read.
    const missing = [...new Set(cards.flatMap((i) => (i.parentId && !byId.has(i.parentId) ? [i.parentId] : [])))];
    const parents = new Map<string, string>();
    const lookup = (async () => {
      for (let n = 0; n < missing.length; n += 4) await Promise.all(missing.slice(n, n + 4).map((id) => pc.issueSummary(id).then((p) => void parents.set(p.id, p.identifier), () => {})));
    })();
    await Promise.race([lookup, new Promise((r) => setTimeout(r, PARENTS_MS).unref())]);
    const out: WorkCard[] = [];
    for (const i of cards) {
      const closed = closedIssue(i);
      // An open issue whose row still says done was reopened after the snapshot: no state yet.
      const state = !closed && states.get(i.id)?.lane === "done" ? null : (states.get(i.id) ?? null);
      const parent = i.parentId ? (byId.get(i.parentId)?.identifier ?? parents.get(i.parentId) ?? null) : null;
      out.push(workCard(i, ctx.assignees, state, parent, [...new Set(kids.get(i.id) ?? [])].filter((a) => a !== i.assigneeAgentId)));
    }
    return out;
  }

  /**
   * The board's writes that used to ride on GET /api/board, run by the live watch (and once at start-up): settled tasks that
   * changed come back, crew parts of tasks closed elsewhere close, and new tasks get a place on My day.
   */
  async function sweep() {
    const ctx = await context();
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const [all, listed] = await Promise.all([pc.openIssues().then((l) => mine(l, ctx)), pc.closedListed(since).then((l) => mine(l.issues, ctx))]);
    const settledAt = store.settledAt();
    const closed = listed.filter((i) => {
      if (!settledAt.has(i.id)) return true;
      if (stillSettled(settledAt.get(i.id), i, null)) return false;
      store.unsettle(i.id);
      return true;
    });
    const open = await closeLeftoverParts(all, closed, ctx);
    // Agents' sub-tasks are part of their parent's card: they never get a place of their own.
    const folded = foldedChildren([...open, ...closed], ctx.assignees);
    store.placeNew(open.filter((i) => !folded.has(i.id)).map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status })));
  }

  /** The account the page is signed in as: saved boards are its own. */
  const viewer = () => perRequest.getStore()?.session?.accountId ?? "operator";
  const savedViews = (): View[] => store.views(viewer()).map((r) => ({ ...r, spec: ViewSpecSchema.parse(JSON.parse(r.spec)) }));
  const viewConflict = (id: string) => new ViewConflict(savedViews().find((x) => x.id === id) ?? null);

  /** The owner's last comment on a crew part, by the part's last activity (closeLeftoverParts). */
  const ownComments = new Map<string, { stamp: string; at: string | undefined }>();
  /** Close the crew parts of tasks closed elsewhere (`partsToClose`), and return the open tasks left. */
  async function closeLeftoverParts(open: Issue[], closed: Issue[], ctx: Awaited<ReturnType<typeof context>>): Promise<Issue[]> {
    const known = new Map([...open, ...closed].map((i) => [i.id, i]));
    const crew = (i: Issue) => ctx.assignees.some((a) => a.kind !== "me" && a.key === i.assigneeAgentId);
    // A parent closed before the recent window isn't loaded: fetch it.
    const missing = [...new Set(open.filter((i) => i.parentId && crew(i) && !known.has(i.parentId)).map((i) => i.parentId!))];
    // Every board refresh asks again: a parent closed long ago changes rarely (a minute's cache), and a part's comments are
    // read again only when the part has changed.
    for (const p of await Promise.all(missing.map((id) => pc.issueSummary(id).catch(() => null)))) if (p) known.set(p.id, p);
    const ownCommentAt = async (part: Issue) => {
      const stamp = part.lastActivityAt ?? part.updatedAt;
      const hit = ownComments.get(part.id);
      if (hit?.stamp === stamp) return hit.at;
      const at = (await pc.comments(part.id)).filter((c) => commentView(c, ctx.me, []).author.kind === "me").at(-1)?.createdAt;
      ownComments.set(part.id, { stamp, at });
      return at;
    };
    // A part closes done only with a passing grade; the grading module unreachable: none closes done (cancel needs no grade).
    const candidates = await partsToClose(open, known, ctx.assignees, ownCommentAt);
    const view = await gradesOf(candidates.filter((c) => c.status === "done").map((c) => c.part.id));
    const leftover = candidates.filter((c) => c.status === "cancelled" || (view && gradePassed(view, c.part.id)));
    if (!leftover.length) return open;
    const busy = (await working(ctx)).map;
    const gone = new Set<string>();
    for (const { part, status } of leftover) {
      if (busy.has(part.identifier)) continue;
      try {
        await pc.updateIssue(part.id, { status });
        gone.add(part.id);
        log.info({ issue: part.identifier, status }, "crew part closed with its task");
      } catch (err) {
        log.warn({ issue: part.identifier, err: String((err as Error).message ?? err).slice(0, 300) }, "could not close a crew part");
      }
    }
    return open.filter((i) => !gone.has(i.id));
  }

  /**
   * Put an agent on a task: a sub-task assigned to it, created as the user so the runner takes the
   * description as the user's request. An agent already on the task gets the instructions as a
   * comment on its part instead: one part per agent.
   */
  async function addToCrew(ctx: Awaited<ReturnType<typeof context>>, parent: Issue, agent: Assignee, instructions: string, executor: { model?: string; effort?: string }, marker = "") {
    // The user's words lose any hidden markers; only the board's own (where a message came from) stay.
    const text = marker ? `${displayText(instructions)}\n\n${marker}` : displayText(instructions);
    const existing = (await pc.children(parent.id)).find((k) => k.assigneeAgentId === agent.key && !["done", "cancelled"].includes(k.status));
    if (existing) {
      await pc.addComment(existing.id, text, true);
      log.info({ issue: parent.identifier, part: existing.identifier, agent: agent.name }, "instructions to the crew");
      return existing;
    }
    const assign = paperclipUpdate(
      { ...parent, assigneeAgentId: null, assigneeAdapterOverrides: null },
      { assignee: agent.key, ...(agent.kind === "engineer" && executor.model ? { model: executor.model } : {}), ...(agent.kind === "engineer" && executor.effort ? { effort: executor.effort } : {}) },
      ctx,
    );
    // Every part carries the task's title, which Paperclip would take for a duplicate of the first one.
    const part = await pc.createIssue({
      title: parent.title,
      description: text,
      status: "todo",
      priority: parent.priority,
      parentId: parent.id,
      allowDuplicate: true,
      ...assign,
    });
    if ((part as Issue & { deduplicated?: boolean }).deduplicated) throw new HttpError(409, `Paperclip returned ${part.identifier} instead of a new task`);
    store.markSeen(part.id, new Date(Date.now() + 5_000).toISOString());
    log.info({ issue: parent.identifier, part: part.identifier, agent: agent.name }, "agent joined");
    return part;
  }

  /** The user's task a chat belongs to: the task itself, or the task an agent's part is part of. */
  async function userTaskOf(issue: Issue, ctx: Awaited<ReturnType<typeof context>>): Promise<Issue | undefined> {
    if (issue.assigneeUserId === ctx.me && !issue.assigneeAgentId) return issue;
    if (!issue.parentId) return undefined;
    const parent = await pc.issue(issue.parentId);
    return parent.assigneeUserId === ctx.me ? parent : undefined;
  }

  /**
   * A message of the user's for one agent on their task, from a mention or passed on by another
   * agent: it goes to that agent's part as the user's own comment, with where it came from. Its latest part
   * takes it (reopened when it was done, so the work and the session carry on); otherwise it joins the task.
   */
  async function deliver(ctx: Awaited<ReturnType<typeof context>>, task: Issue, agent: Assignee, text: string, from: DeliveredFrom) {
    const body = deliveredText(displayText(text), from);
    const parts = (await pc.children(task.id)).filter((k) => k.assigneeAgentId === agent.key && k.status !== "cancelled");
    const part = parts.find((k) => k.status !== "done") ?? parts.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    if (!part) return addToCrew(ctx, task, agent, body, {}, fromMarker(from));
    if (part.status === "done") await pc.updateIssue(part.id, { status: "todo" });
    await pc.addComment(part.id, `${body}\n\n${fromMarker(from)}`);
    log.info({ issue: task.identifier, part: part.identifier, agent: agent.name, from: from.identifier }, "message delivered");
    return part;
  }

  async function issueView(ref: string) {
    const { ctx, issue, assigned } = await ownIssue(ref);
    const [comments, busy, files, parent, kids, names, runs] = await Promise.all([
      pc.comments(issue.id),
      working(ctx),
      pc.attachments(issue.id).catch(() => []),
      issue.parentId ? pc.issueSummary(issue.parentId).catch(() => undefined) : undefined,
      // The crew works in sub-tasks of the user's task.
      issue.assigneeUserId === ctx.me ? pc.children(issue.id).catch(() => []) : Promise.resolve([] as Issue[]),
      bylines(),
      runLinks(issue.id, ctx.agents),
    ]);
    const kidStates = await statesOf(taskStates, [issue.id, ...kids.map((k) => k.id)]);
    const crew = crewOf(issue, kids, { assignees: ctx.assignees, working: busy.map, state: (id) => kidStates.get(id) });
    // Each crew member's latest word, when there's one issue to read it from (a fan-out shows its count instead):
    // what it says while working, else its last comment.
    const said = Object.fromEntries(
      await Promise.all(
        crew.map(async (m) => {
          const live = m.issues.length === 1 ? busy.map.get(m.issues[0]!.identifier) : undefined;
          if (live?.said && !live.queued) return [m.agent, { text: live.said, at: live.saidAt ?? new Date().toISOString() }];
          const c = m.issues.length === 1 ? await pc.latestComment(m.issues[0]!.id).catch(() => undefined) : undefined;
          const view = c && commentView(c, ctx.me, ctx.agents);
          return [m.agent, view && view.author.kind !== "me" ? { text: summaryOf(c.body), at: c.createdAt } : null];
        }),
      ),
    );
    store.markSeen(issue.id);
    const state = (await stateRows([issue.id])).get(issue.id) ?? null;
    const placement = store.placements().get(issue.id);
    const rec = store.recurring(issue.id);
    return {
      ...toCard(issue, ctx.assignees, new Date().toISOString()),
      ...byOf(names, issue.id),
      state,
      description: displayText(issue.description),
      bucket: placement?.bucket ?? null,
      editable: assigned,
      settled: store.settledAt().has(issue.id),
      labelIds: issue.labelIds ?? (issue.labels ?? []).map((l) => l.id),
      executor: executorOf(issue, ctx.assignees),
      replyTarget: replyTarget(issue, ctx.assignees, crew.length > 0),
      scheduled: store.schedules().get(issue.id) ?? null,
      recurring: rec ? recurringView(rec, await pc.routine(rec.routineId).catch(() => undefined)) : null,
      working: busy.map.get(issue.identifier) ?? null,
      comments: comments.map((c) => ({ ...commentView(c, ctx.me, ctx.agents), ...byOf(names, c.id) })),
      files: fileViews(files, ctx.me),
      // An agent's sub-task links back to the task it works on.
      parent: parent ? { identifier: parent.identifier, title: parent.title } : null,
      crew: crew.map((m) => ({ ...m, said: said[m.agent] ?? null })),
      runs,
    };
  }

  // A chat's conversation, re-read only when the chat has changed (the list asks for every chat's last word).
  const conversations = new Map<string, { stamp: string; messages: Message[] }>();
  async function chatMessages(issue: Issue, ctx: Awaited<ReturnType<typeof context>>, comments?: Comment[]): Promise<Message[]> {
    const stamp = `${issue.lastActivityAt ?? issue.updatedAt}`;
    const hit = conversations.get(issue.id);
    if (!comments && hit?.stamp === stamp) return hit.messages;
    // Lists truncate descriptions, and the opening message's marker sits at the end.
    const full = issue.descriptionTruncated ? await pc.issue(issue.id) : issue;
    const name = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id)?.name ?? "Agent";
    const messages = conversation(full, comments ?? (await pc.comments(issue.id)), ctx.me, name, isChat(issue, ctx));
    conversations.set(issue.id, { stamp, messages });
    return messages;
  }

  /**
   * One chat, as the conversation view shows it: messages, the live run, files, approvals, and the work handed out from it.
   * `peek` (a prefetch from a hovered row) leaves it unread.
   */
  async function chatView(ref: string, peek = false) {
    const { ctx, issue } = await editableIssue(ref, "this chat isn't yours");
    const [comments, files, busy, live, kids, parent, names] = await Promise.all([
      pc.comments(issue.id),
      pc.attachments(issue.id).catch(() => []),
      working(ctx),
      liveRuns(),
      pc.children(issue.id).catch(() => [] as Issue[]),
      issue.parentId ? pc.issueSummary(issue.parentId).catch(() => undefined) : undefined,
      bylines(),
    ]);
    const [messages, states] = await Promise.all([chatMessages(issue, ctx, comments), stateRows([issue.id, ...kids.map((k) => k.id)])]);
    const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
    const ids = new Set([issue.id, ...kids.map((k) => k.id)]);
    const agent = agentOf(chatAgent(issue));
    if (!peek) store.markSeen(issue.id);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      open: !["done", "cancelled"].includes(issue.status),
      agent: agent ? { key: agent.id, name: agent.name } : { key: "", name: "You" },
      state: states.get(issue.id) ?? null,
      // The owner's side of the chat: an admin other than the owner wrote it gets their name on it (the opening is the task's).
      messages: messages.map((m) => (m.kind === "owner" ? { ...m, ...byOf(names, m.id === `${issue.id}:opening` ? issue.id : m.id) } : m)),
      working: await withSession(busy.map.get(issue.identifier), live, issue.id, true),
      files: fileViews(files, ctx.me),
      approvals: (await cardsOf("recent", { limit: 50 })).filter((a) => ids.has(a.issueId)).map((a) => shownApproval(names, a)),
      // Work handed out from this chat (Aiden's delegations are children of the chat).
      handedOut: await Promise.all(
        kids
          .filter((k) => k.status !== "cancelled")
          .map(async (k) => ({ identifier: k.identifier, title: k.title, agent: agentOf(k.assigneeAgentId)?.name ?? "You", state: states.get(k.id) ?? null, updatedAt: k.lastActivityAt ?? k.updatedAt, working: await withSession(busy.map.get(k.identifier), live, k.id, false) })),
      ),
      parent: parent ? { identifier: parent.identifier, title: parent.title } : null,
      runs: await runLinks(issue.id, ctx.agents),
      asks: await asksOf(issue, kids, states, ctx),
    };
  }

  /**
   * The questions work handed out from a chat asks the owner: each task the kernel says waits for his answer (its question is
   * the wait's), with the options of the agent's newest reply that offered some. Only work the chat's own agent or the owner put
   * under it counts: another agent can't hang a task under his chat to collect his words.
   */
  const handedOutBy = (chat: Issue, k: Issue, me: string) =>
    k.parentId === chat.id && (k.createdByAgentId ? k.createdByAgentId === chatAgent(chat) : k.createdByUserId === me);
  async function asksOf(chat: Issue, kids: Issue[], states: Map<string, ShownState>, ctx: Awaited<ReturnType<typeof context>>) {
    const asking = kids.filter((k) => k.assigneeAgentId && handedOutBy(chat, k, ctx.me) && waitsForAnswer(states.get(k.id)));
    return Promise.all(
      asking.map(async (k) => {
        const st = states.get(k.id)!;
        const q = askedQuestions(await pc.comments(k.id).catch(() => [] as Comment[]), k.assigneeAgentId);
        const question = st.question ?? "";
        return { id: q?.id ?? `wait:${k.id}`, at: q?.at ?? st.since, text: q?.text ?? question, questions: q?.questions ?? [{ question, options: [] }], identifier: k.identifier, agent: ctx.agents.find((a) => a.id === k.assigneeAgentId)?.name ?? "Agent" };
      }),
    );
  }

  /**
   * The lineage strip: a chat's or task's delegated tasks and theirs, each with its state, model, latest word, tokens and
   * cost (the usage ledger, by task), and the pending approvals on any of them (decided through the Approvals routes).
   */
  async function lineage(ref: string) {
    const { ctx, issue } = await ownIssue(ref);
    const kids = (await pc.children(issue.id)).filter((k) => k.status !== "cancelled");
    // Paperclip limits concurrent list requests per client: a few at a time.
    const grand: Issue[][] = [];
    for (let i = 0; i < kids.length; i += 4) grand.push(...(await Promise.all(kids.slice(i, i + 4).map((k) => pc.children(k.id).then((l) => l.filter((g) => g.status !== "cancelled")).catch(() => [] as Issue[])))));
    const all = [...kids, ...grand.flat()];
    const [states, busy, names] = await Promise.all([stateRows(all.map((i) => i.id)), working(ctx), bylines()]);
    const usage = store.usageByIssue(all.flatMap((i) => [i.id, i.identifier]));
    const pending = await cardsOf("pending");
    const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
    const row = async (k: Issue, children: LineageRow[]): Promise<LineageRow & { approvals: ReturnType<typeof shownApproval>[] }> => {
      const w = busy.map.get(k.identifier);
      const c = w?.said ? undefined : await pc.latestComment(k.id).catch(() => undefined);
      const u = usage.get(k.id) ?? usage.get(k.identifier);
      return {
        identifier: k.identifier,
        title: k.title,
        agent: agentOf(k.assigneeAgentId)?.name ?? "You",
        model: modelOf(k, agentOf(k.assigneeAgentId)),
        state: states.get(k.id) ?? null,
        latest: w?.said ? { text: summaryOf(w.said, 160), at: w.saidAt ?? k.updatedAt } : c && c.authorType === "agent" ? { text: summaryOf(c.body, 160), at: c.createdAt } : null,
        tokens: u ? u.tokens : null,
        usd: u ? u.usd : null,
        startedAt: k.createdAt,
        endedAt: k.completedAt ?? k.cancelledAt ?? null,
        children,
        approvals: pending.filter((a) => a.issueId === k.id).map((a) => shownApproval(names, a)),
      };
    };
    const rows = await Promise.all(kids.map(async (k, i) => row(k, await Promise.all((grand[i] ?? []).map((g) => row(g, []))))));
    return { identifier: issue.identifier, children: rows, total: lineageTotal(rows) };
  }

  /** Settle a finished chat or task out of the active lists (or bring it back): the board's own state, never Paperclip's. */
  async function settle(ref: string, body: unknown) {
    const { settled } = parse(z.object({ settled: z.boolean() }).strict(), body);
    const { ctx, issue } = await editableIssue(ref);
    if (!settled) {
      store.unsettle(issue.id);
      return { settled: false };
    }
    const kids = await pc.children(issue.id).catch(() => [] as Issue[]);
    const chat = isChat(issue, ctx);
    const states = await stateRows([issue.id, ...kids.map((k) => k.id)]);
    // A task needs to be finished; a chat only to be at rest (nothing running, nothing waiting on anyone).
    if (chat ? isActive(states.get(issue.id)) : states.get(issue.id)?.kind !== "done") throw new HttpError(409, chat ? "this chat isn't finished: its agent is working or waiting on you" : "only a finished task can be settled");
    if (kids.some((k) => isActive(states.get(k.id)))) throw new HttpError(409, "work handed out from here is still running or waiting on you");
    const agent = ctx.agents.find((a) => a.id === (chat ? chatAgent(issue) : issue.assigneeAgentId))?.name ?? "You";
    store.settle({ issueId: issue.id, identifier: issue.identifier, title: issue.title, agent, kind: chat ? "chat" : "task" });
    store.events.emit("chat", issue.id);
    return { settled: true };
  }

  /**
   * The side chat: the owner's question about a task, answered by the front agent's model through the gateway with the task
   * as fenced data. Nothing is posted on the task and no agent wakes; the conversation lives in the owner's browser.
   */
  async function aside(ref: string, body: unknown) {
    const { messages } = parse(AsideSchema, body);
    if (!opts.gateway) throw new HttpError(503, "the board has no model gateway configured (AIDENHQ_GATEWAY_URL, gateway_board_key)");
    const { ctx, issue } = await ownIssue(ref);
    const [comments, kids] = await Promise.all([pc.comments(issue.id), pc.children(issue.id).catch(() => [] as Issue[])]);
    const name = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id)?.name ?? "Agent";
    const front = ctx.agents.find((a) => a.metadata?.setupKey === "aidenhq:chief-of-staff") ?? ctx.agents[0];
    const model = String(front?.metadata?.model ?? "~deepseek/deepseek-flash-latest").replace(/^openrouter\//, "");
    const prompt = asideMessages(
      {
        issue,
        agent: issue.assigneeAgentId ? name(issue.assigneeAgentId) : "the owner",
        comments: comments.slice(-8).map((c) => ({ ...c, author: c.authorAgentId ? name(c.authorAgentId) : "the owner" })),
        children: kids.filter((k) => k.status !== "cancelled").map((k) => ({ identifier: k.identifier, title: k.title, status: k.status, agent: name(k.assigneeAgentId) })),
      },
      messages,
    );
    return { answer: await askGateway(opts.gateway, model, prompt) };
  }

  /** Upload one file to a task (validation, decoding, a PDF's text); returns the new attachment and whether a PDF was readable. */
  async function upload(issue: Issue, body: unknown): Promise<{ attachment: Attachment; readable?: boolean }> {
    const input = parse(UploadSchema, body);
    const data = decode(input.data);
    if (typeof data === "string") throw new BadRequest(data);
    const name = safeName(input.name);
    const type = fileType(input.type, name);
    const attachment = await pc.addAttachment(issue.id, name, type, data);
    log.info({ issue: issue.identifier, type, bytes: data.length }, "file attached");
    if (isPdf(type, name)) {
      const text = await pdfText(data);
      if (!text) {
        // Nothing ends silently: the person hears the file can't be read, instead of the agent skipping it.
        log.warn({ issue: issue.identifier }, "no text in an attached PDF");
        await pc.addComment(issue.id, `I couldn't read ${name} (it looks scanned or protected). Send it as a picture or another format.\n\n${NOTICE_MARKER}`);
        return { attachment, readable: false };
      } else
        await pc
          .addAttachment(issue.id, `${name}.txt`, "text/plain", Buffer.from(text, "utf8"))
          .catch((err) => log.warn({ err: String(err.message ?? err).slice(0, 300), issue: issue.identifier }, "couldn't attach a PDF's text"));
    }
    return { attachment };
  }

  /** Attach a file to a task the board may change; a PDF also gets its text as `<name>.txt`, for the agents. */
  async function attach(ref: string, body: unknown) {
    const { issue } = await editableIssue(ref);
    const { readable } = await upload(issue, body);
    return readable === false ? { ...(await issueView(issue.id)), readable: false } : issueView(issue.id);
  }

  /** A task's file, for the user: downloaded, except plain images, which open in the browser. */
  async function download(res: ServerResponse, ref: string, id: string) {
    const { issue } = await ownIssue(ref);
    const file = (await pc.attachments(issue.id)).find((a) => a.id === id);
    if (!file) throw new HttpError(404, "no such file");
    const data = await pc.attachmentContent(file.id);
    const inline = INLINE_TYPES.has(file.contentType);
    const name = file.originalFilename ?? "file";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      "content-type": inline ? file.contentType : "application/octet-stream",
      "content-length": String(data.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
    });
    res.end(data);
  }

  /**
   * Merge one of the user's tasks into another: its description goes into the other's word for word
   * (`mergedDescription`), its files are copied and the user's sub-tasks move over, and it's cancelled
   * with its crew. A task with an Engineer on it is refused: its workspace and branches don't move.
   */
  async function merge(ref: string, body: unknown) {
    const { into } = parse(MergeSchema, body);
    if (!REF.test(into)) throw new HttpError(400, "bad task reference");
    const { ctx, issue } = await ownIssue(ref);
    // An agent's part stands for the user's task it belongs to.
    const [source, target] = await Promise.all([userTaskOf(issue, ctx), pc.issue(into).then((i) => userTaskOf(i, ctx))]);
    if (!source || !target) throw new HttpError(403, "only your own tasks merge");
    const closed = (i: Issue) => ["done", "cancelled"].includes(i.status);
    if (source.id === target.id) throw new HttpError(400, "a task can't be merged into itself");
    if (closed(source)) throw new HttpError(409, `${source.identifier} is already closed`);
    if (closed(target)) throw new HttpError(409, `${target.identifier} is closed: reopen it first`);
    if (target.parentId === source.id) throw new HttpError(400, `${target.identifier} is part of ${source.identifier}`);
    if (store.recurring(source.id)) throw new HttpError(409, `${source.identifier} repeats: stop it first`);
    const kids = await pc.children(source.id);
    const kind = (i: Issue) => ctx.assignees.find((a) => a.kind !== "me" && a.key === i.assigneeAgentId)?.kind;
    const engineers = kids.filter((k) => kind(k) === "engineer" && k.status !== "cancelled");
    if (engineers.length) {
      const names = engineers.map((k) => ctx.assignees.find((a) => a.key === k.assigneeAgentId)).map((a) => a?.name ?? "an Engineer");
      throw new HttpError(409, `${source.identifier} has ${[...new Set(names)].join(" and ")}'s work on it, which can't move: merge ${target.identifier} into it instead, or dismiss the Engineer first`);
    }
    // Lists truncate descriptions; these come from single reads, so they're whole.
    const files = await pc.attachments(source.id);
    for (const f of files) await pc.addAttachment(target.id, f.originalFilename ?? "file", f.contentType, await pc.attachmentContent(f.id));
    await pc.updateIssue(target.id, { description: mergedDescription(target, source) });
    for (const k of kids) if (k.assigneeUserId === ctx.me && !k.assigneeAgentId) await pc.updateIssue(k.id, { parentId: target.id });
    // The crew's parts close with the task, except one an agent is busy with (the board closes it later).
    const busy = (await working(ctx)).map;
    for (const k of kids) if (kind(k) && !closed(k) && !busy.has(k.identifier)) await pc.updateIssue(k.id, { status: "cancelled" });
    store.unschedule(source.id);
    // Cancelled first: a comment on a closed task wakes nobody, and the notice marker keeps it from the Researcher.
    await pc.updateIssue(source.id, { status: "cancelled" });
    await pc.addComment(source.id, `Merged into ${target.identifier}.\n\n${NOTICE_MARKER}`);
    log.info({ issue: source.identifier, into: target.identifier, files: files.length }, "task merged");
    return { merged: source.identifier, into: target.identifier, files: files.length };
  }

  async function schedule(ref: string, body: unknown) {
    const { issue } = await editableIssue(ref);
    const result = scheduleMove(store, issue, parse(ScheduleSchema, body), opts.timezone);
    log.info({ issue: issue.identifier, scheduled: result.scheduled, movedNow: result.movedNow }, "move scheduled");
    return { identifier: issue.identifier, ...result };
  }

  async function recurringChange(ref: string, body: unknown) {
    const { ctx, issue } = await editableIssue(ref);
    const recurring = await changeRecurring(pc, store, { me: ctx.me, labels: ctx.labels, assistant: ctx.assignees.find((a) => a.kind === "assistant")?.key }, issue, parse(RecurringSchema, body), opts.timezone, log);
    return { identifier: issue.identifier, recurring };
  }

  // The tasks bridge (agents' tools, with the agent's own credential) and the runner (its key), behind the internal token.
  const internal: typeof routes = [
    // Fleet tools of the Chief of Staff: the kernel's caller assertion names the caller, who must be the CoS.
    // The status read also takes fleet-read (the Fleet Steward).
    { method: "POST", path: /^\/internal\/fleet\/status$/, handle: async (_m, body, _u, req) => fleetCall(req, async (pc) => {
      // The summary is extra: a failed read there never fails fleet_status (summary: null). After the status reads, not beside
      // them (Paperclip limits concurrent list requests per client).
      const window = (body as { window?: string } | null)?.window === "7d" ? "7d" : "24h";
      const status = await fleetStatus(pc, records, kernelActivity);
      const summary = await statusSummary(pc, recentRuns, store, records, grading, window).catch((err) => (log.warn({ err: String(err) }, "fleet summary failed"), null));
      // A bounded reply: the lists are what get long, and a cut-off payload is unreadable.
      return boundedFleetStatus({ ...status, summary });
    }, ["fleet-admin", "fleet-read"]) },
    { method: "POST", path: /^\/internal\/fleet\/costs$/, handle: async (_m, body, _u, req) => fleetCall(req, (pc) => fleetCosts(pc, parse(CostsSchema, body ?? {}).days)) },
    { method: "POST", path: /^\/internal\/fleet\/control$/, handle: async (_m, body, _u, req) => fleetCall(req, async (pc, cos) => fleetControl(pc, cos, parse(ControlSchema, body), store)) },
    {
      // The Chief of Staff relays the owner's own chat message, word for word, to an engineer's task. The agent picks the
      // comment and the task, never the words; it lands as the owner's own comment with the delivered-from marker, so the runner acts on it.
      method: "POST",
      path: /^\/internal\/relay$/,
      handle: async (_m, body, _u, req) =>
        fleetCall(req, async (_pc, cos) => {
          const { comment_id, target } = parse(RelaySchema, body);
          const ctx = await context();
          const chats = (await pc.openIssues()).filter((i) => i.assigneeAgentId === cos.id && (i.labels ?? []).some((l) => l.name === "chat"));
          let source: { chat: Issue; comment: Comment } | undefined;
          for (const chat of chats) {
            const comment = (await pc.comments(chat.id)).find((c) => c.id === comment_id);
            if (comment) source = { chat, comment };
          }
          if (!source) throw new Refused("refused: that comment is not on your open `chat` task");
          const words = relayableWords(source.comment, ctx.me);
          if (!REF.test(target)) throw new Refused("refused: target must be a task identifier");
          await refuseMemoryInbox(target);
          const dest = await pc.issue(target).catch(() => undefined);
          const agent = dest && ctx.assignees.find((a) => a.key === dest.assigneeAgentId);
          if (!dest || !agent || dest.assigneeAgentId === cos.id) throw new Refused("refused: target must be a task assigned to an engineer");
          if (["done", "cancelled"].includes(dest.status)) throw new Refused("refused: that task is closed");
          // An answer to the questions an agent this chat handed work to is asking (never an engineer's: the runner reads
          // relayed words there as the owner's instructions): handed out by the chat's own agent or the owner, and written after it asked.
          const kids = await pc.children(source.chat.id);
          const states = await stateRows(kids.map((k) => k.id));
          const asking = kids.filter((k) => k.assigneeAgentId && !["done", "cancelled"].includes(k.status) && handedOutBy(source.chat, k, ctx.me) && waitsForAnswer(states.get(k.id)));
          const ask = agent.kind === "engineer" ? undefined : asking.find((k) => k.id === dest.id);
          if (ask) {
            // The words must be newer than the question: the kernel's start of the open owner wait, never a guess from comments.
            const askedAt = states.get(ask.id)!.wait_since;
            if (!askedAt) throw new Refused("refused: the kernel has no open question on that task; answer on the task");
            if (source.comment.createdAt <= askedAt) throw new Refused("refused: that message was written before the agent asked; ask the owner again");
          }
          if (!ask && !["engineer", "assistant"].includes(agent.kind)) throw new Refused("refused: target must be an engineer's task, or a task handed out from this chat whose agent is asking the owner");
          // One set of tasks that could take the owner's words: whenever more than one could, the words must name the target.
          // Engineer tasks that could take the owner's words: those with their review or checks under way (the kernel's state).
          const engineers = (await pc.openIssues()).filter((i) => ctx.assignees.some((a) => a.key === i.assigneeAgentId && a.kind === "engineer"));
          const engineerStates = await stateRows(engineers.map((i) => i.id));
          const inReview = engineers.filter((i) => ["card_review", "card_owner", "module_wait"].includes(engineerStates.get(i.id)?.reason ?? "")).map((i) => i.identifier);
          const waiting = [...new Set([...inReview, ...asking.filter((k) => ctx.assignees.find((a) => a.key === k.assigneeAgentId)?.kind !== "engineer").map((k) => k.identifier)])];
          assertMeantTask(words, dest.identifier, waiting, ctx.prefix);
          // Once per message, whatever the target: reserved before posting, released if the post fails.
          const key = `relayed:${comment_id}`;
          if (store.meta(key)) throw new Refused("refused: that message was already relayed");
          store.setMeta(key, new Date().toISOString());
          const from: DeliveredFrom = { identifier: source.chat.identifier, commentId: source.comment.id, note: `Written in chat on ${source.chat.identifier}.` };
          let posted: Comment;
          try {
            posted = await pc.addComment(dest.id, `${deliveredText(words, from)}\n\n${fromMarker(from)}\n${RELAY_MARKER}`);
          } catch (err) {
            store.delMeta(key);
            throw err;
          }
          log.info({ chat: source.chat.identifier, task: dest.identifier }, "chat message relayed");
          return { relayed: true, task: dest.identifier, to: agent.name, comment_id: posted.id };
        }),
    },
    {
      // The owner asks, through Aiden, for an app's access to change (docs/design/access.md, In-app requests and roles): his own
      // chat comment becomes an in-app request on that app, with his email as the requester. Aiden picks the comment and the
      // app, never the words; the app's agent gets only the request id and acts on it with app_role_set.
      method: "POST",
      path: /^\/internal\/owner\/app-request$/,
      handle: async (_m, body, _u, req) =>
        fleetCall(req, async (_pc, cos) => {
          const { comment_id, app } = parse(z.object({ comment_id: z.string().regex(/^[0-9a-f-]{36}$/), app: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/) }).strict(), body);
          const ctx = await context();
          const chats = (await pc.openIssues()).filter((i) => i.assigneeAgentId === cos.id && (i.labels ?? []).some((l) => l.name === "chat"));
          let comment: Comment | undefined;
          for (const chat of chats) comment ??= (await pc.comments(chat.id)).find((c) => c.id === comment_id);
          if (!comment) throw new Refused("refused: that comment is not on your open `chat` task");
          const words = relayableWords(comment, ctx.me);
          if (!opts.accounts) throw new Refused("refused: the board has no kernel to file it with");
          const key = `app-request:${comment_id}`;
          if (store.meta(key)) throw new Refused("refused: that message was already filed as a request");
          // The kernel checks the words name the app and files them as the owner's request.
          const r = await opts.accounts.ownerRequest(app, words).catch((e: AccountError) => { throw new Refused(e.message); });
          store.setMeta(key, r.id);
          log.info({ app, request: r.id }, "owner's app request filed");
          return { request_id: r.id, app, note: `Pass ${r.id} to ${app}'s agent; it acts on it with app_role_set.` };
        }),
    },
    {
      // Every card on one task, any state, read from the kernel's records (an agent's task_approvals through the tasks bridge; no args).
      method: "GET",
      path: /^\/internal\/approvals$/,
      handle: async (_m, _b, url, req) => {
        const issue = url.searchParams.get("issue");
        if (!issue) throw new HttpError(400, "issue=<task>");
        await requireAgentTool(req, "task_approvals");
        // A lookup that failed is not a task with no cards: the run's check for a merge card must be able to tell them apart.
        const task = await pc.issue(issue).then((i) => i.id, (e: Error) => {
          throw new HttpError(502, `couldn't read ${issue}: ${String(e?.message ?? e).slice(0, 200)}`);
        });
        // `tier0`: a merge the fleet files for a green PR is Tier 0 in the agents org, and the run's check for the card that
        // wakes it must see it. `strict`: a kernel that didn't answer must not read as "no cards". This task's merges are read
        // by kind: the newest page, and every page of the states one can still be in (the reviewer's or owner's wait, and the
        // approved or claimed run), so neither newer writes nor a full page of ended merges can hide the card that matters.
        const kinds = ["github.merge", "codehost-local.merge"];
        const mine = (a: Approval) => a.issueId === task || a.identifier === task;
        const [recent, history, running, waiting] = await Promise.all([
          cardsOf("recent", { task, limit: 50, tier0: true, strict: true }),
          cardsOf("recent", { task, limit: 1000, tier0: true, strict: true, kinds }),
          records.allOf("approved", kinds),
          records.allOf("pending", kinds),
        ]);
        const shown = [...new Map([...recent, ...history, ...running.filter(mine), ...waiting.filter(mine)].map((a) => [a.id, a])).values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return { approvals: shown.map(mergeView) };
      },
    },
    // Board changes are the Researcher's (board-writer), through the tasks bridge with its own credential.
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/schedule$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_schedule", "board-writer"), await refuseMemoryInbox(dec(m[1]!)), schedule(dec(m[1]!), body)) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/recurring$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_recurring", "board-writer"), await refuseMemoryInbox(dec(m[1]!)), recurringChange(dec(m[1]!), body)) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/merge$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_merge", "board-writer"), await refuseMemoryInbox(dec(m[1]!), parse(MergeSchema, body).into), merge(dec(m[1]!), body)) },
    {
      // An agent attaches a file to the task it is working on (a `file` deliverable): only that task, never another's.
      // The body is the browser route's ({name, type, data} base64); the reply is the new file as the board lists it.
      method: "POST",
      path: /^\/internal\/issues\/([^/]+)\/files$/,
      maxBody: MAX_UPLOAD_BODY + 1024,
      handle: async (m, body, _u, req) => {
        const agent = await requireAgentTool(req, "task_file_upload");
        const ref = dec(m[1]!);
        if (!REF.test(ref)) throw new HttpError(400, "bad task reference");
        await refuseMemoryInbox(ref);
        const issue = await pc.issue(ref);
        if (issue.assigneeAgentId !== agent.id) throw new HttpError(403, "a file may be attached only to the task assigned to you");
        const { attachment } = await upload(issue, body);
        const [all, owner] = await Promise.all([pc.attachments(issue.id).catch(() => [attachment]), pc.me()]);
        // fileViews gives the same shape the browser's file list has (a PDF's text version is `textOf`).
        return { file: fileViews(all.some((f) => f.id === attachment.id) ? all : [...all, attachment], owner).find((f) => f.id === attachment.id) };
      },
    },
    {
      // An agent passes one of the user's messages on to another agent on the same task. Only the
      // user's own comment travels, word for word: the agent picks which one and for whom, never the words.
      method: "POST",
      path: /^\/internal\/issues\/([^/]+)\/pass$/,
      // The Researcher through the tasks bridge.
      handle: async (m, body, _u, req) => {
        await requireAgentTool(req, "task_pass_on", "board-writer");
        await refuseMemoryInbox(dec(m[1]!));
        const { comment, to, by } = parse(PassSchema, body);
        const { ctx, issue } = await ownIssue(dec(m[1]!));
        const task = await userTaskOf(issue, ctx);
        if (!task) throw new HttpError(400, "only on the user's tasks and their agents' parts");
        const c = (await pc.comments(issue.id)).find((x) => x.id === comment && !x.deletedAt);
        if (!c || c.authorType !== "user" || c.authorUserId !== ctx.me || hasMarker(c.body, NOTICE_MARKER) || forOthers(c.body)) throw new HttpError(400, "pass on a comment the user wrote on this task");
        const named = ctx.assignees.find((a) => a.kind !== "me" && a.key === to);
        const byName = withHandle(ctx.assignees, to);
        const agent = named ?? (byName.length === 1 ? byName[0] : undefined);
        if (!agent) throw new HttpError(400, `${byName.length > 1 ? "more than one agent answers to" : "no agent is called"} ${to}: ${ctx.assignees.flatMap((a) => (a.kind === "me" ? [] : [a.name])).join(", ")}`);
        // An agent may pass only to the Researcher, an Engineer, or an agent already on this task; never the Chief of Staff.
        const chief = holdsRole(agent.key, "fleet-admin");
        const onTask = (await pc.children(task.id)).some((k) => k.assigneeAgentId === agent.key);
        if (chief || (agent.kind === "agent" && !onTask)) throw new HttpError(403, `${agent.name} can't be passed to from here`);
        if (agent.key === issue.assigneeAgentId) throw new HttpError(400, `this is ${agent.name}'s own chat`);
        const key = `passed:${c.id}:${agent.key}`;
        if (store.meta(key)) return { passed: false, reason: `already passed on to ${agent.name}` };
        // A message already delivered here keeps pointing at the chat it was written in.
        const origin = deliveredFrom(c.body) ?? { identifier: issue.identifier, commentId: c.id };
        const sender = by ? withHandle(ctx.assignees, by)[0] : undefined;
        const part = await deliver(ctx, task, agent, displayText(c.body).replace(/\n\n_(Written in|Passed on by) [^\n]*_$/, ""), { ...origin, note: `Passed on by ${sender?.name ?? "an agent"} from ${issue.identifier}.` });
        store.setMeta(key, new Date().toISOString());
        return { passed: true, to: agent.name, part: part.identifier };
      },
    },
  ];

  // Where OAuth sign-ins start on a board without an https address: the loopback board, through an SSH tunnel (docs/setup.md).
  const TUNNEL = "http://localhost:3121 through ssh -N -L 3121:127.0.0.1:3121 <you>@<host> from your laptop";
  const googleViaBoard = mode === "lan" && !!opts.lan?.googleConnect && !!opts.lan.url.startsWith("https://");
  /** Where the board's sign-ins return for a request to `host`: its https address when Connect runs there, else the request's own. */
  const signInOrigin = (host: string) => (googleViaBoard ? opts.lan!.url : `http://${host}`);
  /**
   * Where a module sign-in (board.signins) started at `host` returns: the loopback address it came from (a tunnel), or the
   * board's https address (BOARD_LAN_URL) when the request reached the board by that name. Undefined anywhere else: plain
   * http off loopback never carries a sign-in.
   */
  const httpsBoard = mode === "lan" && !!opts.lan?.url.startsWith("https://") ? new URL(opts.lan!.url) : undefined;
  const vendorOrigin = (host: string): string | undefined => {
    const h = host.toLowerCase();
    if (loopbackPort(h)) return `http://${h}`;
    return httpsBoard && h.replace(/:\d+$/, "") === httpsBoard.hostname ? httpsBoard.origin : undefined;
  };
  /** Where a sign-in started at `host` returns: loopback (pasted back) unless the vendor takes only https (`https_only`). */
  const redirectOrigin = (s: SignIn, host: string, oneClick = false) => (s.httpsOnly || oneClick ? vendorOrigin(host) : SIGNIN_LOOPBACK);

  // ------------------------------------------------------------------ Settings (settings.ts)

  const settingsFiles = () => ({ compiled: process.env.BOARD_PAPERCLIP_CONFIG ?? "/config/paperclip.yaml", catalog: process.env.BOARD_MODULES_FILE ?? "/config/modules.json", grants: process.env.AIDENHQ_GRANTS_FILE });

  async function settingsData() {
    const pending = await records.list("owner");
    return settingsView({
      ...readSources(settingsFiles()),
      boardTimezone: opts.timezone,
      pendingApprovals: pending.length,
      updates: readUpdates(join(dirname(process.env.AIDENHQ_GENERATIONS_FILE ?? "/generations/generations.jsonl"), "updates.json")),
    });
  }

  // Each HTTP connection's /healthz, asked at most every 20 s (the page polls); when it last answered ok, since the board started.
  let probed: { at: number; probes: Record<string, Probe> } | null = null;
  const lastOk = new Map<string, string>();
  async function connectionsData(fresh: boolean) {
    const { compiled, catalog } = readSources(settingsFiles());
    if (fresh || !probed || Date.now() - probed.at > 20_000) {
      const results = Object.entries(await records.connectionHealth());
      for (const [n, p] of results) if (p.ok) lastOk.set(n, p.checkedAt);
      probed = { at: Date.now(), probes: Object.fromEntries(results.map(([n, p]) => [n, { ...p, ...(lastOk.has(n) ? { lastOkAt: lastOk.get(n) } : {}) }])) };
    }
    const [google, states, sources] = await Promise.all([
      opts.google?.status(),
      signInStates(fresh),
      appsApi<{ sources?: { source: string; last_ok: string | null; failing: boolean }[] }>("/internal/sources", { auth: true, timeoutMs: 5000 }).then(
        (r) => r.sources ?? [],
        () => null,
      ),
    ]);
    // Its Connect: the picker first where the proxy offers a choice of scopes, and the per-install values first while it has none.
    const signIns = Object.fromEntries(states.map((s) => [s.id, s.status && { ...s.status, offer: s.offer, ...(s.mode === "device" ? { mode: "device" as const } : {}), ...(asksValues(s.status) && s.fields.length ? { fields: s.fields } : {}) }] as const));
    return connectionsView({ compiled, catalog, probes: probed.probes, signIns, google, sources });
  }

  /** A sign-in's card rows without the suggestions the owner dismissed (a row's `dismiss` key, kept for good in the store). */
  const undismissed = (id: string, lines: NonNullable<McpAuthStatus["lines"]>) =>
    lines.map((l) => (l.dismiss && store.meta(`dismissed:${id}:${l.dismiss}`) ? (({ hint: _h, action: _a, dismiss: _d, ...rest }) => rest)(l) : l));

  /**
   * Each module sign-in's state (McpAuth caches it for a minute; `fresh` asks again), undefined where the proxy can't be asked,
   * and whether its Connect offers a choice of scopes.
   */
  const signInStates = (fresh = false) => Promise.all((opts.signIns ?? []).map(async (x) => {
    const status = await x.auth.status(fresh ? 0 : undefined);
    return { ...x, status: status?.lines ? { ...status, lines: undismissed(x.id, status.lines) } : status, offer: await x.auth.offers() };
  }));

  const routes: { method: string; path: RegExp; maxBody?: number; handle: (m: RegExpMatchArray, body: unknown, url: URL, req: IncomingMessage) => Promise<unknown> }[] = [
    // A sign-in's Connect dialog: its name and Connect path, whether it is set up (asked afresh: the dialog waits on it after a
    // save), the values it asks for first, and the scopes on offer.
    {
      method: "GET",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})$/,
      handle: async (m, _b, _u, req) => {
        const id = m[1]!;
        const s = (opts.signIns ?? []).find((x) => x.id === id);
        if (!s) throw new HttpError(404, "no such sign-in");
        const [status, offer] = await Promise.all([s.auth.status(0), s.auth.scopes()]);
        // Signed in: the picker opens on what the token grants now, not on the recommended set.
        const granted = status?.state === "ok" && offer ? (status.scope ?? "").split(/[\s,]+/).filter((x) => x && x !== "offline_access" && offer.supported.includes(x)) : [];
        return {
          id,
          label: s.label,
          connect: s.connect,
          configured: Boolean(status?.configured),
          asks: asksValues(status),
          detail: status?.detail,
          fields: s.fields,
          scopes: offer && offer.supported.length > 1 ? { ...offer, ...(granted.length ? { granted } : {}) } : null,
          state: status?.state ?? "unknown",
          mode: s.mode ?? "redirect",
          // What stops this sign-in before it starts, in words (checked here, so the vendor's page never shows a bare refusal).
          // The same rule the Connect path applies (vendorOrigin): from here, can the vendor send the browser back?
          preflight: s.mode !== "device" && s.httpsOnly && !vendorOrigin(String(req.headers.host ?? ""))
            ? httpsBoard
              ? `${s.label} sends you back only to ${httpsBoard.origin}. Open the board there to connect it.`
              : `${s.label} sends you back only to an https address, and this board has none yet. Give the board its https address (docs/setup.md, Tailscale), then connect from there.`
            : null,
          // The address the default sign-in ends on (pasted back below), and the domain one click returns to instead.
          redirect: s.httpsOnly || s.mode === "device" ? null : `${SIGNIN_LOOPBACK}${s.callback}`,
          oneClick: s.httpsOnly ? null : (httpsBoard?.hostname ?? null),
        };
      },
    },
    // Test connection: one live read through the sign-in's proxy, answered in words (ok, or what is wrong and how to fix it).
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/check$/,
      handle: async (m) => {
        const s = (opts.signIns ?? []).find((x) => x.id === m[1]);
        if (!s) throw new HttpError(404, "no such sign-in");
        const r = await s.auth.check();
        store.events.emit("connections");
        return r;
      },
    },
    // Test connection for Google: one live read through the same Google connection the Connect button uses.
    {
      method: "POST",
      path: /^\/api\/google\/check$/,
      handle: async () => {
        if (!opts.google) throw new HttpError(404, "Google sign-in isn't set up on the board");
        const r = await opts.google.check();
        store.events.emit("connections");
        return r;
      },
    },
    // Finishing a Google sign-in with a Desktop client: the loopback address its tab ended on, pasted on its Connect dialog.
    {
      method: "POST",
      path: /^\/api\/google\/finish$/,
      handle: async (_m, body) => {
        if (!opts.google) throw new HttpError(404, "Google sign-in isn't set up on the board");
        const { url: pasted } = parse(z.object({ url: z.string().max(8000) }).strict(), body);
        try {
          const back = pastedCallback(pasted, `${SIGNIN_LOOPBACK}/google/callback`);
          const { email } = await opts.google.finish(back.state, back.code, back.code ? undefined : back.error);
          log.info({ account: email }, "Google account connected");
        } catch (err) {
          log.warn({ err: String((err as Error).message ?? err).slice(0, 500) }, "Google sign-in failed");
          throw err instanceof McpAuthFailed || err instanceof GoogleAuthFailed ? new HttpError(400, `Couldn't connect Google: ${err.message}`) : new HttpError(502, "Couldn't connect Google: google-workspace-mcp isn't answering");
        }
        connected("google");
        return { ok: true };
      },
    },
    // Dismissing a suggestion on a sign-in's card (a row's `dismiss` key, e.g. GitHub's "code review can post as its own App" for
    // one org): kept for good; the row stays, without its suggestion.
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/dismiss$/,
      handle: async (m, body) => {
        const s = (opts.signIns ?? []).find((x) => x.id === m[1]);
        if (!s) throw new HttpError(404, "no such sign-in");
        const { key } = parse(z.object({ key: z.string().regex(/^[\w.:/-]{1,120}$/) }).strict(), body);
        store.setMeta(`dismissed:${s.id}:${key}`, new Date().toISOString());
        return { ok: true };
      },
    },
    // Finishing a loopback sign-in: the address its tab ended on, pasted on Connect. Checked to be exactly that redirect; the
    // proxy then exchanges the code as the callback would (its state is single-use, the PKCE verifier never left it).
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/finish$/,
      handle: async (m, body) => {
        const s = (opts.signIns ?? []).find((x) => x.id === m[1] && !x.httpsOnly);
        if (!s) throw new HttpError(404, "no such sign-in");
        const { url: pasted } = parse(z.object({ url: z.string().max(8000) }).strict(), body);
        try {
          const back = pastedCallback(pasted, `${SIGNIN_LOOPBACK}${s.callback}`);
          if (!back.code) throw new McpAuthFailed(`${s.label} didn't grant access: ${vendorWords(back.error ?? "", back.description)}`);
          await s.auth.finish(back.state, back.code);
        } catch (err) {
          log.warn({ err: String((err as Error).message ?? err).slice(0, 500) }, `${s.label} sign-in failed`);
          throw err instanceof McpAuthFailed ? new HttpError(400, `Couldn't connect ${s.label}: ${err.message}`) : new HttpError(502, `Couldn't connect ${s.label}: ${s.label.toLowerCase()}-mcp isn't answering`);
        }
        log.info(`${s.label} connected`);
        connected(s.id);
        return { ok: true };
      },
    },
    {
      method: "GET",
      path: /^\/api\/board$/,
      handle: async () => {
        const inv = await inventory();
        const { ctx } = inv;
        // Who is working and the connections' states don't depend on the tasks: started with them, not after.
        const extras = Promise.all([working(ctx), opts.google?.status(), signInStates(), bylines(), spendSummary(opts.gateway)]);
        extras.catch(() => {}); // awaited below; this only keeps a failure there from going unhandled meanwhile
        // My day: the tasks the board shows (mine), a settled one kept off until something happens on it (the sweep unsettles it).
        const settledAt = store.settledAt();
        const open = mine(inv.open, ctx);
        const closed = mine(inv.closed, ctx).filter((i) => !stillSettled(settledAt.get(i.id), i, null));
        const routines = store.allRecurring().size ? new Map((await pc.routines()).map((r) => [r.id, r])) : new Map<string, Routine>();
        const recurring = new Map([...store.allRecurring()].map(([id, r]) => { const v = recurringView(r, routines.get(r.routineId)); return [id, { summary: v.summary, nextRun: v.nextRun, paused: v.paused }]; }));
        const [busy, google, signIns, names, summary] = await extras;
        // The header's spend line: the day and the month against the install's spend limits.
        const spend = summary?.install ?? null;
        const rows = new Map(inv.read.tasks.map((r) => [r.task, r]));
        const board = buildBoard({ open, closed, placements: store.placements(), seen: store.allSeen(), schedules: store.schedules(), recurring, installedAt: store.meta("installed_at")!, assignees: ctx.assignees, crew: { working: busy.map, state: (id) => rows.get(id) } });
        const cards = [...Object.values(board.buckets).flat(), ...board.recurring, ...board.done];
        // One kernel snapshot for both layouts: each row's refs named once (identifiers from the inventory).
        const idents = new Map([...inv.open, ...inv.closed].map((i) => [i.id, i.identifier]));
        const states = new Map((await shownRows(inv.read.tasks, idents)).map((r) => [r.task, r]));
        const work = await agentWork(inv, states, ctx);
        for (const card of cards) {
          const w = busy.map.get(card.identifier);
          if (w) card.working = w;
          card.state = states.get(card.id) ?? null;
          Object.assign(card, byOf(names, card.id));
        }
        // Lists truncate long descriptions; the brief is read in full.
        const brief = open.find((i) => i.id === board.brief?.id);
        if (board.brief && brief?.descriptionTruncated) board.brief.description = displayText((await pc.issue(brief.id)).description);
        // When Tomorrow next rolls into Today: the next calendar day, except before days off.
        const today = localDate(opts.timezone);
        const rollsOn = nextWorkday(today, opts.workdays ?? WORKWEEK);
        return { ...board, work, asOf: inv.read.as_of, incomplete: inv.incomplete, projects: inv.projects, assignees: ctx.assignees, labels: ctx.labels, prefix: ctx.prefix, timezone: opts.timezone, slackTeams: opts.slackTeams ?? {}, rollsOn, rollsTomorrow: rollsOn === addDays(today, 1), buckets: board.buckets, agentsActive: busy.active, spend, google: google ?? null, signIns: signIns.map(({ id, label, missing, stopped, status, offer, mode }) => ({ id, label, missing, stopped, status: status ?? null, offer, ...(mode === "device" ? { mode } : {}) })) };
      },
    },
    // Saved boards (views.ts): the signed-in account's own; a write at a stale rev is a 409 with the row as it is now (null: gone).
    { method: "GET", path: /^\/api\/views$/, handle: async () => ({ views: savedViews() }) },
    {
      method: "POST",
      path: /^\/api\/views$/,
      handle: async (_m, body) => {
        const v = parse(CreateViewSchema, body);
        const row = store.addView(viewer(), v.name, JSON.stringify(v.spec));
        return { ...row, spec: v.spec };
      },
    },
    {
      method: "PUT",
      path: /^\/api\/views\/([0-9a-f-]{36})$/,
      handle: async (m, body) => {
        const v = parse(UpdateViewSchema, body);
        if (!store.updateView(viewer(), m[1]!, v.rev, { name: v.name, spec: v.spec && JSON.stringify(v.spec) })) throw viewConflict(m[1]!);
        return savedViews().find((x) => x.id === m[1]);
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/views\/([0-9a-f-]{36})$/,
      handle: async (m, _b, url) => {
        const rev = Number(url.searchParams.get("rev"));
        if (!Number.isInteger(rev) || rev < 1) throw new HttpError(400, "rev is the view's revision");
        if (!store.deleteView(viewer(), m[1]!, rev)) throw viewConflict(m[1]!);
        return { ok: true };
      },
    },
    { method: "GET", path: /^\/api\/issues\/([^/]+)$/, handle: async (m) => issueView(dec(m[1]!)) },
    { method: "GET", path: /^\/api\/runs\/(j-[0-9a-f]{16})$/, handle: async (m) => runView(m[1]!) },
    { method: "GET", path: /^\/api\/chats\/([^/]+)$/, handle: async (m, _b, url) => chatView(dec(m[1]!), url.searchParams.has("peek")) },
    { method: "GET", path: /^\/api\/agents$/, handle: async () => activity(await context(), true) },
    // The Agents page's first paint: who is in the fleet, where each sits and its schedules (no run history; /api/agents
    // brings that, with each agent's last run, after).
    { method: "GET", path: /^\/api\/agents\/roster$/, handle: async () => {
        const [agents, routines, act] = await Promise.all([pc.agents(), pc.routines().catch(() => []), kernelActivity()]);
        return { roster: roster(agents, routines, new Map(), act) };
      },
    },
    // One agent's page (web/src/AgentPage.tsx): its profile, then its tasks. Registered before the uuid routes; a key is never a uuid.
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)$/,
      handle: async (m) => {
        const [agents, routines, activity] = await Promise.all([pc.agents(), pc.routines().catch(() => []), kernelActivity()]);
        const agent = agentByKey(agents, m[1]!);
        if (!agent) throw new HttpError(404, "no such agent");
        const { compiled, catalog } = readSources(settingsFiles());
        return { profile: agentProfile({ agent, agents, routines, activity, effort: compiled?.agents?.[m[1]!]?.reasoning_effort ?? null, catalog }) };
      },
    },
    // The Handbook tab (agent-handbook.ts): main handbook, the owner's rules, the compiled text, the fork's state; and its history.
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/handbook$/,
      handle: async (m) => {
        const agent = agentByKey(await pc.agents(), m[1]!);
        if (!agent) throw new HttpError(404, "no such agent");
        const { compiled, catalog } = readSources(settingsFiles());
        const module = typeof agent.metadata?.module === "string" ? agent.metadata.module : "instance";
        const text = await pc.request<{ content?: string }>("GET", `/api/agents/${encodeURIComponent(agent.id)}/instructions-bundle/file?path=AGENTS.md`).then((r) => String(r.content ?? ""), () => null);
        return handbook({ key: m[1]!, module, revision: catalog.find((c) => c.name === module)?.revision?.slice(0, 7), compiled: text, dirs: { modules: process.env.BOARD_MODULES_DIR, instance: process.env.BOARD_INSTANCE_DIR } });
      },
    },
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/handbook\/history$/,
      handle: async (m) => {
        if (!agentByKey(await pc.agents(), m[1]!)) throw new HttpError(404, "no such agent");
        return history(m[1]!, process.env.BOARD_INSTANCE_DIR);
      },
    },
    {
      method: "POST",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/pause$/,
      handle: async (m, body) => {
        const agent = agentByKey(await pc.agents(), m[1]!);
        if (!agent) throw new HttpError(404, "no such agent");
        const ask = parse(PauseSchema, body);
        const done = await setAgentPaused(pc, agent, ask, (id) => work.stop({ agent: id }, stopper()));
        log.info({ agent: m[1], paused: ask.paused }, ask.paused ? "agent paused" : "agent resumed");
        store.events.emit("fleet");
        return done;
      },
    },
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/tasks$/,
      handle: async (m, _b, url) => {
        const ctx = await context();
        const agent = agentByKey(ctx.agents, m[1]!);
        if (!agent) throw new HttpError(404, "no such agent");
        const chat = ctx.labels.find((l) => l.name === "chat");
        if (url.searchParams.get("view") === "history") {
          const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
          const status = url.searchParams.get("status");
          const closed = await pc.closedFor(agent.id, { q: url.searchParams.get("q") ?? "", ...(status === "done" || status === "cancelled" ? { status } : {}), offset, limit: HISTORY_PAGE });
          return historyPage(closed, offset, chat?.id, await stateRows(closed.map((i) => i.id)), ctx.agents);
        }
        const mine = tasksOf(await pc.openIssues(), agent.id, chat?.id);
        return splitTasks(mine, await stateRows(mine.map((i) => i.id)), ctx.agents);
      },
    },
    // The Activity tab (timeline.ts): the agent's last 50 jobs, one kernel read; task titles from what Paperclip already lists.
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/timeline$/,
      handle: async (m) => {
        const agents = await pc.agents();
        const agent = agentByKey(agents, m[1]!);
        if (!agent) throw new HttpError(404, "no such agent");
        const [jobs, open, closed, routines] = await Promise.all([work.agent(agent.id), pc.openIssues().catch(() => []), pc.closedFor(agent.id, { limit: 100 }).catch(() => []), pc.routines().catch(() => [])]);
        return { entries: timelineOf(jobs, { agents, issues: [...open, ...closed], routines }) };
      },
    },
    // A card's "Explain" (explain.ts): who decided, why, what was asked and what it would change.
    {
      method: "GET",
      path: /^\/api\/approvals\/(k-[0-9a-f]{16})\/explain$/,
      handle: async (m) => records.explain(m[1]!).then((explanation) => ({ explanation }), (e: Error & { status?: number }) => { throw new HttpError(e.status === 404 ? 404 : 502, e.message); }),
    },
    { method: "GET", path: /^\/api\/agents\/([0-9a-f-]{36})\/scorecard$/, handle: async (m) => scorecard(await gatherFacts(pc, recentRuns, store, records, grading), m[1]!) },
    {
      // Chats: open ones first, then the 20 newest finished ones; each with its agent and state.
      method: "GET",
      path: /^\/api\/chats$/,
      handle: async () => {
        const ctx = await context();
        const label = await labelNamed(ctx, "chat", "#0ea5e9");
        // Every open task too (for the work handed out from open chats), in the same round trip rather than after.
        const [open, closed, openTasks] = await Promise.all([pc.labelled(label.id, OPEN), pc.labelled(label.id, "done,cancelled", "20"), pc.openIssues()]);
        const newest = (a: Issue, b: Issue) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt);
        const all = [...open.sort(newest), ...closed.sort(newest)];
        // Work an agent handed out from an open chat (a child task of it): listed under that chat's agent.
        const chatIds = new Map(open.map((i) => [i.id, i.identifier]));
        const kids = chatIds.size ? openTasks.filter((i) => i.parentId && chatIds.has(i.parentId) && !all.some((c) => c.id === i.id)) : [];
        const states = await stateRows([...all, ...kids].map((i) => i.id));
        const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
        const row = (i: Issue, agent: ReturnType<typeof agentOf>) => ({
          identifier: i.identifier,
          title: i.title,
          open: !["done", "cancelled"].includes(i.status),
          agent: agent ? { key: agent.id, name: agent.name } : { key: "", name: "You" },
          state: states.get(i.id) ?? null,
          updatedAt: i.lastActivityAt ?? i.updatedAt,
        });
        const settledAt = store.settledAt();
        const chats = await Promise.all(
          all.map(async (i) => {
            const messages = await chatMessages(i, ctx).catch(() => [] as Message[]);
            const r = row(i, agentOf(chatAgent(i)));
            const said = lastWord(messages);
            // Settled: out of the active list until something happens on it (then it comes back on its own).
            const settled = stillSettled(settledAt.get(i.id), i, r.state);
            if (!settled && settledAt.has(i.id)) store.unsettle(i.id);
            // Unread: the agent spoke after the owner last opened the chat.
            return { ...r, ...(said ? { preview: said } : {}), unread: said?.from === "agent" && said.at > store.seenAt(i.id), ...(settled ? { settled } : {}) };
          }),
        );
        const handedOut = kids.map((i) => ({ ...row(i, agentOf(i.assigneeAgentId)), from: chatIds.get(i.parentId!)!, unread: false }));
        const agents = ctx.agents
          .filter((a) => !agentPaused(a))
          .map((a) => ({ key: a.id, name: a.name, front: a.metadata?.setupKey === "aidenhq:chief-of-staff" }));
        // A settled chat whose handed-out work runs or waits on the owner is active again.
        for (const c of chats) {
          if (!c.settled || !handedOut.some((h) => h.from === c.identifier && isActive(h.state))) continue;
          delete (c as { settled?: boolean }).settled;
          store.unsettle(all.find((i) => i.identifier === c.identifier)!.id);
        }
        return { chats: [...chats, ...handedOut], agents };
      },
    },
    {
      // Everything that needs someone, from the kernel (task-state.ts): each open task with attention, oldest first, and the
      // fleet's counts (needs you, failed, unexplained idle).
      method: "GET",
      path: /^\/api\/needs-you$/,
      handle: async () => {
        const ctx = await context();
        const [read, open] = await Promise.all([taskStates.read({ open: true }), pc.openIssues()]);
        const byId = new Map(open.map((i) => [i.id, i]));
        const rows = await shownRows(read.tasks.filter((r) => r.attention.length && byId.has(r.task)));
        const items = rows.map((state) => {
          const i = byId.get(state.task)!;
          return { identifier: i.identifier, title: i.title, agent: ctx.agents.find((a) => a.id === (i.assigneeAgentId ?? chatAgent(i)))?.name ?? "You", state };
        });
        // The counts come from the rows the list shows.
        const has = (r: ShownState, f: (a: ShownState["attention"][number]) => boolean) => r.attention.some(f);
        const counts = {
          needs_you: rows.filter((r) => has(r, (a) => a.who === "owner")).length,
          failed: rows.filter((r) => has(r, (a) => a.why === "failed")).length,
          unexplained_idle: rows.filter((r) => has(r, (a) => ["unpolled", "orphaned", "unknown", "history_expired"].includes(a.why))).length,
        };
        // approvals: the Tier 2 cards the owner decides in Approvals.
        return { counts, items, approvals: (await records.list("owner")).length };
      },
    },
    // Approvals: the cards, open ones first, then the newest decided ones with their outcome, and the newest Tier 0 runs (made
    // at once, shown after the fact; read apart so they never crowd the cards out). Read-only: every card is decided on the
    // kernel's approval page (or in a channel).
    {
      method: "GET",
      path: /^\/api\/approvals$/,
      handle: async () => {
        const names = await bylines();
        // Live records (`approved`, and `claimed` ones an executor holds) are read apart from the capped history, in their own
        // read with no tier filter (a Tier 0 merge held on review is claimed too), paged to the last one: a hundred newer writes
        // must never push a blocked merge out of the list the owner watches, and neither may the kernel's own page size. The
        // wider recent list adds the ended Tier 0 audit rows.
        // A page of the live read that fails (the kernel restarting) is not "no live records": the cached page is kept instead
        // of publishing a short list that would drop an old blocked merge off the cards. The kernel-down fallback below still
        // answers what the capped reads have.
        const [cards, all, live] = await Promise.all([
          cardsOf("recent", { limit: 100 }),
          cardsOf("recent", { limit: 100, tier0: true }),
          records.live().then((rows) => Promise.all(rows.map(named))).then((rows) => ((liveCache = rows), rows), () => liveCache ?? []),
        ]);
        const held = [...live.filter((a) => isLive(a.state)), ...all.filter((a) => a.state === "auto" || isLive(a.state))];
        const seen = new Set(cards.map((c) => c.id));
        const rest = held.filter((a) => !seen.has(a.id) && (seen.add(a.id), true));
        return { approvals: [...cards, ...rest].map((a) => shownApproval(names, a)) };
      },
    },
    {
      // A new chat: with the agent named (body.agent or a leading @name), else Aiden.
      method: "POST",
      path: /^\/api\/chats$/,
      handle: async (_m, body, _u, req) => {
        const ctx = await context();
        const input = parse(z.object({ text: z.string().trim().min(1).max(8000), agent: z.string().max(200).optional() }).strict(), body);
        const crew = ctx.agents;
        const named = input.agent ? crew.find((a) => a.id === input.agent || a.metadata?.setupKey === `aidenhq:${input.agent}` || a.name.toLowerCase() === input.agent!.toLowerCase()) : undefined;
        const { agent, note } = named && !agentPaused(named) ? { agent: named, note: undefined } : pickAgent(input.text, crew);
        // A fast-lane agent answers in the lane, not in a task: the board opens its lane chat (`lane:<key>`).
        const lane = (await laneAgents(pc, opts.lane)).find((l) => l.id === agent.id);
        if (lane) {
          await laneSend(pc, opts.lane, lane.key, input.text, await laneByline(req));
          return { identifier: `lane:${lane.key}` };
        }
        const label = await labelNamed(ctx, "chat", "#0ea5e9");
        const title = input.text.split("\n")[0]!.replace(/^@\S+\s*/, "").slice(0, 80) || "New chat";
        const issue = await pc.createIssue({ title, description: `${note ? `${input.text}\n\n${note}` : input.text}\n\n${chatAgentMarker(agent.id)}`, status: "todo", assigneeAgentId: agent.id, labelIds: [label.id] });
        log.info({ issue: issue.identifier, agent: agent.name }, "chat started");
        return { identifier: issue.identifier };
      },
    },
    // The fast chat lane's agents and their chats (lane.ts): each agent's chat task.
    { method: "GET", path: /^\/api\/lane$/, handle: async () => ({ agents: await laneAgents(pc, opts.lane) }) },
    { method: "GET", path: /^\/api\/lane\/([^/]+)\/messages$/, handle: async (m, _b, url) => laneMessages(pc, opts.lane, dec(m[1]!), url.searchParams.get("after") ?? "") },
    {
      method: "POST",
      path: /^\/api\/lane\/([^/]+)\/messages$/,
      handle: async (m, body, _u, req) => {
        const { text } = parse(z.object({ text: z.string().trim().min(1).max(8000) }).strict(), body);
        await laneSend(pc, opts.lane, dec(m[1]!), text, await laneByline(req));
        return { ok: true };
      },
    },
    {
      // Not right: one line from the person, recorded as a correction; the chat reopens.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/not-right$/,
      handle: async (m, body) => {
        const own = await editableIssue(dec(m[1]!), "this task isn't yours");
        const { ctx } = own;
        const { issue } = own;
        const { text } = parse(z.object({ text: z.string().trim().min(1).max(500) }).strict(), body);
        const label = await labelNamed(ctx, "correction", "#dc2626");
        await pc.addComment(issue.id, `Not right: ${text}\n\n<!-- aidenhq-correction -->`);
        const labelIds = [...new Set([...(issue.labelIds ?? issue.labels?.map((l) => l.id) ?? []), label.id])];
        // Back to the chat's agent, so the correction wakes it (agents often hand a chat back to the owner).
        const agentId = issue.assigneeAgentId ? undefined : chatAgent(issue);
        await pc.updateIssue(issue.id, { status: "todo", labelIds, ...(agentId ? { assigneeAgentId: agentId, assigneeUserId: null } : {}) });
        return issueView(issue.id);
      },
    },
    // The Flow page (flow.ts): the period's bottlenecks, DORA and idle items in one read; one item's waterfall; the code host's history import.
    {
      method: "GET",
      path: /^\/api\/flow$/,
      handle: async (_m, _b, url) => {
        const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 7;
        const scope = url.searchParams.get("scope") ?? "all", journey = url.searchParams.get("journey") ?? undefined;
        if (!/^[a-z0-9-]{1,63}$/.test(scope)) throw new HttpError(400, "bad scope");
        if (journey !== undefined && !/^[a-z0-9-]{1,63}$/.test(journey)) throw new HttpError(400, "bad journey");
        const now = Date.now();
        const flow = opts.flow;
        if (!flow) return { summary: null, idle: [] };
        const [summary, idle] = await Promise.all([flow.summary({ since: new Date(now - days * 864e5).toISOString(), to: new Date(now).toISOString(), scope, journey }), flow.idle()]);
        return { summary, idle };
      },
    },
    // The journeys (the Timeline tab): which ones modules declare, and one's items over the period, filtered and sorted by the
    // kernel. A task's title is the task's own, from what Paperclip lists (open tasks, and those changed in the period); the
    // fact log keeps none.
    {
      method: "GET",
      path: /^\/api\/flow\/journeys$/,
      handle: async () => ({ journeys: (await opts.flow?.journeys()) ?? [] }),
    },
    {
      method: "GET",
      path: /^\/api\/flow\/journey$/,
      handle: async (_m, _b, url) => {
        const p = url.searchParams;
        const name = p.get("name") ?? "";
        if (!/^[a-z0-9-]{1,63}$/.test(name)) throw new HttpError(400, "bad journey");
        const days = [7, 30, 90].includes(Number(p.get("days"))) ? Number(p.get("days")) : 7;
        const author = (p.get("author") ?? "agent,owner,outside").split(",").filter((a): a is AuthorKind => a === "agent" || a === "owner" || a === "outside");
        const sort = (["recent", "slowest", "rounds"] as const).find((x) => x === p.get("sort")) ?? "recent";
        const now = Date.now();
        const since = new Date(now - days * 864e5).toISOString();
        const list = await opts.flow?.journey({ journey: name, since, to: new Date(now).toISOString(), author, sort, limit: 500 });
        if (list?.items.some((x) => x.task && !x.title)) {
          const tasks = [...(await pc.openIssues().catch(() => [])), ...(await pc.tasksSince(since).catch(() => []))];
          const title = new Map(tasks.map((i) => [i.id, i.title]));
          for (const x of list.items) if (x.task && !x.title) x.title = title.get(x.task) ?? null;
        }
        return list ?? null;
      },
    },
    {
      method: "GET",
      path: /^\/api\/flow\/item$/,
      handle: async (_m, _b, url) => {
        const id = url.searchParams.get("id") ?? "";
        if (!/^[\w:.#@/-]{1,200}$/.test(id)) throw new HttpError(400, "bad item");
        const item = await opts.flow?.item(id);
        if (!item) throw new HttpError(404, "Flow has no such item");
        return item;
      },
    },
    // The Costs tab's ledger views (cost-ledger.ts): aggregates over ?from&to&bucket, and one agent's or model's top runs and tasks.
    {
      method: "GET",
      path: /^\/api\/costs\/ledger$/,
      handle: async (_m, _b, url) => ledgerSummary({ store, agents: () => pc.agents(), key: keyUsage, spend: () => spendSummary(opts.gateway), issue: (id) => pc.issueSummary(id), prices }, ledgerRange(url.searchParams)),
    },
    {
      method: "GET",
      path: /^\/api\/costs\/top$/,
      handle: async (_m, _b, url) =>
        ledgerTop({ store, agents: () => pc.agents(), issue: (id) => pc.issueSummary(id) }, ledgerRange(url.searchParams), { agentId: url.searchParams.get("agent") ?? undefined, model: url.searchParams.get("model") ?? undefined }),
    },
    // What each feature (a top-level task and its delegated tree) cost and how long it took (feature-cost.ts): the last 14 days...
    {
      method: "GET",
      path: /^\/api\/costs\/features$/,
      handle: async () => {
        const now = Date.now();
        const from = new Date(now - 14 * 864e5).toISOString();
        const [open, closed, approvals] = await Promise.all([pc.openIssues(), pc.closedSince(from, "500"), records.list("recent", { limit: 1000 })]);
        return recentFeatures([...open, ...closed], store.usageByRun(from), approvals, now);
      },
    },
    // ...and one task's own tree, for its page: null when nothing is delegated under it.
    {
      method: "GET",
      path: /^\/api\/issues\/([^/]+)\/feature-cost$/,
      handle: async (m) => {
        const { issue } = await ownIssue(dec(m[1]!));
        const { tasks, truncated } = await descendants(issue, (id) => pc.children(id));
        if (!tasks.length) return { cost: null };
        const ids = [issue, ...tasks].flatMap((i) => [i.id, i.identifier]);
        return { cost: featureCost(issue, tasks, store.usageByRun("", ids), await records.list("recent", { limit: 1000 }), Date.now(), truncated) };
      },
    },
    // Read-only module catalog (compiled config/modules.json), for Settings > Modules.
    // One module's page (web/src/ModulePage.tsx): its row, its agents, their open work, what it may do and who needs it.
    {
      method: "GET",
      path: /^\/api\/modules\/(?!browse$)([a-z0-9-]+)$/,
      handle: async (m) => {
        const text = readFileSync(process.env.BOARD_MODULES_FILE ?? "/config/modules.json", "utf8");
        const module = moduleStates(text).find((r) => r.name === m[1]);
        if (!module) throw new HttpError(404, "no such module");
        const ctx = await context();
        const [routines, open, activity] = await Promise.all([pc.routines().catch(() => []), pc.openIssues(), kernelActivity()]);
        const { compiled, catalog } = readSources(settingsFiles());
        const chat = ctx.labels.find((l) => l.name === "chat");
        const mine = module.agents.flatMap((key) => { const a = agentByKey(ctx.agents, key); return a ? [{ key, a }] : []; });
        const owned = mine.map(({ a }) => tasksOf(open, a.id, chat?.id));
        const states = await stateRows(owned.flat().map((i) => i.id));
        const tasks = owned.map((list) => splitTasks(list, states, ctx.agents));
        const ongoing = tasks.flatMap((t) => [...t.needs, ...t.ongoing]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return {
          module,
          agents: mine.map(({ key, a }) => agentProfile({ agent: a, agents: ctx.agents, routines, activity, effort: compiled?.agents?.[key]?.reasoning_effort ?? null, catalog })),
          ongoing,
          // Its routines as compiled: on or off (quiet start pauses a schedule until the owner turns it on), and whose.
          routines: module.routines.flatMap((key) => { const r = compiled?.routines?.[key]; return r ? [{ key, title: r.title ?? key, agent: r.agent ?? "", on: r.status !== "paused", scheduled: Boolean(r.schedules?.length) }] : []; }),
          authority: moduleAuthority(text, module.name),
          neededBy: module.neededBy,
          requires: module.requires,
        };
      },
    },
    { method: "GET", path: /^\/api\/modules$/, handle: async () => ({ modules: moduleStates(readFileSync(process.env.BOARD_MODULES_FILE ?? "/config/modules.json", "utf8")), advisories: await records.advisories().catch(() => []) }) },
    // Browse, marketplaces and an agent's grants (lane E, src/marketplace.ts), read from the compiled catalog and config.
    { method: "GET", path: /^\/api\/modules\/browse$/, handle: async (_m, _b, url) => browseModules(readSources(settingsFiles()).catalog, url.searchParams.get("q") ?? "", url.searchParams.get("kind") ?? "") },
    { method: "GET", path: /^\/api\/marketplaces$/, handle: async () => marketplacesOf(readSources(settingsFiles()).catalog, resolveCommit) },
    // The commit a marketplace would be pinned at (the newest 7+ days old), for the owner to see before filing add or update.
    { method: "POST", path: /^\/api\/marketplaces\/resolve$/, handle: async (_m, body) => resolveCommit(parse(z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict(), body).repo).catch((e) => Promise.reject(e instanceof CommitUnreadable ? new HttpError(422, e.message) : e)) },
    {
      method: "GET",
      path: /^\/api\/agents\/by-key\/([a-z0-9-]+)\/grants$/,
      handle: async (m) => {
        const { compiled, catalog } = readSources(settingsFiles());
        return agentGrants(compiled, catalog, m[1]!) ?? Promise.reject(new HttpError(404, "no such agent"));
      },
    },
    // The Reviews page (web/src/Reviews.tsx, docs/design/code-review.md): the code-review module's runs and repos,
    // one-off runs, and the owner's change to settings.code_review (filed like any settings change).
    {
      method: "GET",
      path: /^\/api\/reviews\/setup$/,
      handle: async () => {
        const { compiled, catalog } = readSources(settingsFiles());
        const mod = catalog.find((m) => m.name === "code-review");
        const gh = (await signInStates()).find((s) => s.id === "github")?.status;
        const current = compiled?.settings?.code_review?.value ?? mod?.settings?.code_review?.default ?? null;
        const parsed = CodeReviewSchema.safeParse(current);
        return {
          module: Boolean(mod?.enabled && reviews),
          github: { configured: Boolean(gh?.configured), connected: gh?.state === "ok", state: gh?.state ?? null },
          config: parsed.success ? parsed.data : upgradeConfig(current),
          problems: parsed.success ? [] : configProblems(current),
        };
      },
    },
    { method: "GET", path: /^\/api\/reviews$/, handle: async (_m, _b, url) => reviewsCall((r) => r.list({ repo: url.searchParams.get("repo") ?? undefined, status: url.searchParams.get("status") ?? undefined, limit: Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100) })) },
    { method: "GET", path: /^\/api\/reviews\/run\/([\w-]{1,80})$/, handle: async (m) => reviewsCall((r) => r.get(m[1]!)) },
    { method: "GET", path: /^\/api\/reviews\/repos$/, handle: async () => reviewsCall((r) => r.repos()) },
    { method: "GET", path: /^\/api\/reviews\/engines$/, handle: async () => reviewsCall((r) => r.engines()) },
    { method: "GET", path: /^\/api\/reviews\/available$/, handle: async (_m, _b, url) => reviewsCall((r) => r.available((url.searchParams.get("q") ?? "").slice(0, 100))) },
    {
      method: "GET",
      path: /^\/api\/reviews\/insights$/,
      handle: async (_m, _b, url) => {
        const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
        return reviewsCall(async (r) => insightsOf((await r.list({ limit: 500 })).runs, days));
      },
    },
    { method: "GET", path: /^\/api\/reviews\/catalog$/, handle: async (_m, _b, url) => reviewsCall((r) => r.catalog(parse(CatalogQuerySchema, { repo: url.searchParams.get("repo") ?? "", ...(url.searchParams.get("commit") ? { commit: url.searchParams.get("commit") } : {}) }))) },
    { method: "GET", path: /^\/api\/reviews\/report\/([\w-]{1,80})$/, handle: async (m) => reviewsCall((r) => r.report(m[1]!)) },
    // One POST, two targets: a PR link (a one-off PR review) or a tree target (a whole-repo review). Signed-in admins only, like every route.
    { method: "POST", path: /^\/api\/reviews$/, handle: async (_m, body) => reviewsCall<unknown>((r) => (typeof body === "object" && body !== null && "target" in body ? r.runTree(parse(TreeRequestSchema, body)) : r.run(parse(OneOffSchema, body)))) },
    // The owner's dismissal of an open finding (signed in: every admin is an owner); recorded as theirs, with their reason.
    { method: "POST", path: /^\/api\/reviews\/dismiss$/, handle: async (_m, body) => reviewsCall((r) => r.dismiss({ ...parse(DismissSchema, body), by: "owner (board)" })) },
    {
      // The whole code_review value the page edited, checked here for the owner's feedback, then the normal settings change.
      method: "POST",
      path: /^\/api\/reviews\/config$/,
      maxBody: 200_000,
      handle: async (_m, body) => {
        const { value } = parse(ReviewConfigSchema, body);
        const problems = configProblems(value);
        if (problems.length) throw new HttpError(400, problems.slice(0, 3).join("; "));
        return fileSettingsChange([{ kind: "setting", key: "code_review", value: value as never }]);
      },
    },
    // Settings (web/src/Settings.tsx): the compiled config, read-only, with what the board can see live. Edits go through git.
    { method: "GET", path: /^\/api\/settings$/, handle: async () => settingsData() },
    { method: "GET", path: /^\/api\/settings\/connections$/, handle: async (_m, _b, url) => connectionsData(url.searchParams.has("fresh")) },
    {
      // A typed settings change (docs/design/settings-changes.md): checked here, filed as the owner's own task with no
      // assignee, and handed to the kernel (POST /v1/settings/change), which checks it again, has the instance repo's code
      // host write exactly its files and files the kernel.apply on the task.
      method: "POST",
      path: /^\/api\/settings\/change$/,
      handle: async (_m, body) => fileSettingsChange(parse(ChangesSchema, body).changes),
    },
    {
      // The settings changes filed in the last two weeks, and where each stands (task, then its apply card).
      method: "GET",
      path: /^\/api\/settings\/changes$/,
      handle: async () => {
        const ctx = await context();
        const label = ctx.labels.find((l) => l.name === SETTINGS_LABEL);
        if (!label) return { changes: [] };
        const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
        const tasks = (await pc.labelled(label.id, "backlog,todo,in_progress,in_review,blocked,done,cancelled", "20")).filter((i) => i.createdAt >= since);
        // A list may cut descriptions short; the typed change is at the end of one, so read those in full.
        const full = await Promise.all(tasks.map((i) => (i.descriptionTruncated ? pc.issue(i.id) : i)));
        const changes = (
          await Promise.all(
            full.map(async (i) => {
              const kept = store.meta(`settings-change:${i.id}`);
              const items = kept ? (JSON.parse(kept) as Change[]) : changesOf(i.description);
              return items ? [{ identifier: i.identifier, title: i.title, createdAt: i.createdAt, items, ...stageOf(i.status, await records.list("recent", { task: i.id, limit: 50, strict: true }).catch(() => undefined), i.createdAt) }] : [];
            }),
          )
        ).flat();
        return { changes: changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
      },
    },
    // Read-only view of the apps platform (apps-mcp's status), for the Apps tab.
    { method: "GET", path: /^\/api\/apps$/, handle: async () =>
        // `node.login_url`: the apps' Tailscale node waiting for its one-time sign-in. A bearer secret, so only here behind the owner's sign-in, never in a notice.
        appsApi("/internal/status").then(
          async (apps) => ({ apps, node: await appsApi<{ up: boolean; login_url?: string }>("/internal/apps-node", { auth: true, timeoutMs: 5000 }).catch(() => undefined) }),
          (e: Error) => ({ apps: [], error: e.message }),
        ),
    },
    {
      method: "PATCH",
      path: /^\/api\/issues\/([^/]+)$/,
      handle: async (m, body) => {
        const { ctx, issue } = await editableIssue(dec(m[1]!));
        const update = parse(UpdateSchema, body);
        const patch = paperclipUpdate(issue, update, ctx);
        if (Object.keys(patch).length) await pc.updateIssue(issue.id, patch);
        log.info({ issue: issue.identifier, fields: Object.keys(patch) }, "task updated");
        // Closed before the grader settled it: there is nothing left to grade, so its row ends (a timer catches closes made
        // elsewhere, e.g. a cancel in Paperclip itself).
        if (update.status === "done" || update.status === "cancelled") await grading.settle(issue.id, `the task was ${update.status} before the grader settled it`).catch((err) => log.warn({ issue: issue.identifier, err: String(err) }, "couldn't settle the grade of a closed task; the grading module's timer will"));
        // Done or cancelled closes the crew's open parts too, except one an agent is busy with or one waiting on its own trigger.
        if ((update.status === "done" || update.status === "cancelled") && issue.assigneeUserId === ctx.me) {
          const [kids, busy] = await Promise.all([pc.children(issue.id), working(ctx)]);
          const open = kids.filter((k) => !["done", "cancelled"].includes(k.status) && !waitsOnItsOwn(k) && !busy.map.has(k.identifier) && ctx.assignees.some((a) => a.kind !== "me" && a.key === k.assigneeAgentId));
          const view = update.status === "done" ? await gradesOf(open.map((k) => k.id)) : undefined;
          for (const k of open) {
            if (update.status === "done" && !(view && gradePassed(view, k.id))) continue;
            await pc.updateIssue(k.id, { status: update.status });
          }
        }
        return issueView(issue.id);
      },
    },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/comments$/,
      handle: async (m, body, _u, req) => {
        const { ctx, issue: asked } = await editableIssue(dec(m[1]!));
        const issue = asked;
        // `brief`: the chat's send, which refetches the chat itself, so the reply skips building the whole task view.
        const { body: text, brief } = parse(z.object({ body: z.string().trim().min(1).max(30_000), answer: z.boolean().optional(), brief: z.boolean().optional() }).strict(), body);
        const view = async () => (brief ? { identifier: issue.identifier } : issueView(issue.id));
        // @-mentions: the agents named, other than the one this chat is with, get the message on their part.
        const task = await userTaskOf(issue, ctx);
        const own = issue.id === task?.id ? ctx.assignees.find((a) => a.kind === "assistant")?.key : issue.assigneeAgentId;
        const named = task ? mentionedAgents(text, ctx.assignees) : [];
        const others = named.filter((a) => a.key !== own);
        // Hidden markers are machine-only: the runner ignores comments that carry its marker.
        let posted;
        if (!others.length || named.length > others.length) posted = await pc.addComment(issue.id, displayText(text), true);
        // On the user's own task the message stays in the team chat; the Researcher leaves it to the others.
        else if (issue.id === task!.id) posted = await pc.addComment(issue.id, `${displayText(text)}\n\n${FOR_OTHERS}`, true);
        log.info({ issue: issue.identifier, mentions: named.map((a) => a.name) }, "comment added");
        // A message to a finished chat reopens it.
        // A chat keeps its agent: a message to a chat the agent handed back goes to that agent again.
        if (isChat(issue, ctx) && (!issue.assigneeAgentId || issue.status === "done" || issue.status === "cancelled")) {
          const agentId = chatAgent(issue);
          await pc.updateIssue(issue.id, { status: "todo", ...(agentId && !issue.assigneeAgentId ? { assigneeAgentId: agentId, assigneeUserId: null } : {}) });
        }
        const where = issue.id === task?.id ? "the team chat" : `${ctx.assignees.find((a) => a.key === issue.assigneeAgentId)?.name ?? "another agent"}'s chat`;
        const parts = [];
        for (const a of others) parts.push(await deliver(ctx, task!, a, text, { identifier: issue.identifier, commentId: posted?.id, note: `Written in ${where} on ${issue.identifier}.` }));
        // A message that left this chat for another agent's: the board opens that one.
        return { ...(await view()), ...(!posted && parts[0] ? { movedTo: parts[0].identifier } : {}) };
      },
    },
    {
      // Stop: the kernel ends the task's running job (cancelled), the task stays open with the kernel's own note.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/stop$/,
      handle: async (m) => {
        const { issue } = await editableIssue(dec(m[1]!));
        const stopped = await work.stop({ task: issue.id }, stopper());
        log.info({ issue: issue.identifier, stopped }, "run stopped by the owner");
        store.events.emit("chat", issue.id);
        return { stopped: stopped.length };
      },
    },
    {
      // Bring an agent onto one of your tasks: a sub-task assigned to it, with your instructions.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/agents$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(dec(m[1]!));
        if (issue.assigneeUserId !== ctx.me) throw new HttpError(403, "agents join your own tasks");
        const input = parse(AddAgentSchema, body);
        const agent = ctx.assignees.find((a) => a.key === input.agent && a.kind !== "me");
        if (!agent) throw new HttpError(400, "unknown agent");
        await addToCrew(ctx, issue, agent, input.instructions, { model: input.model, effort: input.effort });
        return issueView(issue.id);
      },
    },
    {
      // A stuck agent's part goes to another: the user's instructions, plus a note that someone tried first.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/handover$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(dec(m[1]!));
        if (issue.assigneeUserId !== ctx.me) throw new HttpError(403, "only your own tasks");
        const { from, to } = parse(HandOverSchema, body);
        if (!REF.test(from)) throw new HttpError(400, "bad task reference");
        const part = await pc.issue(from);
        if (part.parentId !== issue.id) throw new HttpError(400, "that isn't part of this task");
        // Only the user's own words travel as instructions: an agent's proposal needs approving first.
        if (!part.createdByUserId || part.createdByAgentId) throw new HttpError(400, "these instructions came from an agent, not from you: add the agent with your own instead");
        const fromAgent = ctx.assignees.find((a) => a.key === part.assigneeAgentId);
        const agent = ctx.assignees.find((a) => a.key === to && a.kind !== "me");
        if (!agent || !fromAgent || agent.key === fromAgent.key) throw new HttpError(400, "pick another agent");
        await addToCrew(ctx, issue, agent, handOverText(displayText(part.description), fromAgent.name), {});
        // A status change wakes nobody: a comment here would read as an instruction to the runner.
        await pc.updateIssue(part.id, { status: "cancelled" });
        log.info({ issue: issue.identifier, from: part.identifier, to: agent.name }, "handed over");
        return issueView(issue.id);
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/files$/, maxBody: MAX_UPLOAD_BODY + 1024, handle: async (m, body) => attach(dec(m[1]!), body) },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/move$/,
      handle: async (m, body) => {
        const { issue } = await editableIssue(dec(m[1]!));
        const { bucket, position } = parse(z.object({ bucket: z.enum(BUCKETS), position: z.enum(["top", "bottom"]).default("top") }).strict(), body);
        store.move(issue.id, bucket, position);
        return { ok: true };
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/schedule$/, handle: async (m, body) => schedule(dec(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/recurring$/, handle: async (m, body) => recurringChange(dec(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/merge$/, handle: async (m, body) => merge(dec(m[1]!), body) },
    { method: "GET", path: /^\/api\/issues\/([^/]+)\/lineage$/, handle: async (m) => lineage(dec(m[1]!)) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/settle$/, handle: async (m, body) => settle(dec(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/aside$/, maxBody: 100_000, handle: async (m, body) => aside(dec(m[1]!), body) },
    // The Settled view: what the owner settled, searchable by identifier, title or agent.
    { method: "GET", path: /^\/api\/settled$/, handle: async (_m, _b, url) => ({ settled: store.settledList((url.searchParams.get("q") ?? "").slice(0, 200)) }) },
    {
      method: "PUT",
      path: /^\/api\/buckets\/([a-z]+)$/,
      handle: async (m, body) => {
        const bucket = m[1];
        if (!isBucket(bucket)) throw new HttpError(404, "no such bucket");
        const { ids } = parse(z.object({ ids: z.array(z.string().regex(/^[0-9a-f-]{36}$/)).max(1000) }).strict(), body);
        // Only tasks the board shows can be ranked.
        const ctx = await context();
        const open = new Set(mine(await pc.openIssues(), ctx).map((i) => i.id));
        store.setOrder(bucket, ids.filter((id) => open.has(id)));
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: /^\/api\/buckets\/today\/carried$/,
      handle: async (_m, body) => {
        // Today's carried-over tasks, all at once: keep them for today, or move them on.
        const { action } = parse(z.object({ action: z.enum(["keep", "tomorrow", "later"]) }).strict(), body);
        if (action === "keep") return { ok: true, count: store.keepCarried() };
        const ctx = await context();
        const open = new Set(mine(await pc.openIssues(), ctx).map((i) => i.id));
        const ids = store.carried().filter((id) => open.has(id));
        store.moveAll(ids, action);
        log.info({ moved: ids.length, to: action }, "carried-over tasks moved");
        return { ok: true, count: ids.length };
      },
    },
    {
      method: "POST",
      path: /^\/api\/issues$/,
      handle: async (_m, body) => {
        const input = parse(CreateSchema, body);
        const ctx = await context();
        const todo = ctx.labels.find((l) => l.name === "todo");
        const issue = await pc.createIssue({
          title: input.title,
          description: input.description,
          status: "todo",
          priority: "medium",
          assigneeUserId: ctx.me,
          ...(todo ? { labelIds: [todo.id] } : {}),
        });
        store.move(issue.id, input.bucket, "top");
        store.markSeen(issue.id, new Date(Date.now() + 5_000).toISOString());
        log.info({ issue: issue.identifier, bucket: input.bucket }, "task created");
        return { id: issue.id, identifier: issue.identifier };
      },
    },
    {
      // State and title of tasks referenced in text ("PEN-12"), so links show whether they're done.
      method: "GET",
      path: /^\/api\/refs$/,
      handle: async (_m, _body, url) => {
        const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim().toUpperCase()))].filter((s) => /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(s)).slice(0, 100);
        const out: Record<string, { state: ShownState | null; title: string }> = {};
        for (let i = 0; i < ids.length; i += 6) {
          await Promise.all(
            ids.slice(i, i + 6).map(async (id) => {
              const ref = await refCache(id);
              if (ref) out[id] = ref;
            }),
          );
        }
        return out;
      },
    },
    {
      method: "GET",
      path: /^\/api\/models\/([0-9a-f-]{36})$/,
      handle: async (m) => {
        const ctx = await context();
        const a = ctx.assignees.find((x) => x.key === m[1] && x.kind === "engineer");
        if (!a) throw new HttpError(404, "not an Engineer");
        const models = [...new Set([...(a.defaultModel ? [a.defaultModel] : []), ...(a.models ?? [])])];
        return { default: a.defaultModel ?? null, models, efforts: a.efforts ?? [] };
      },
    },
  ];

  // Referenced tasks change rarely; a short cache keeps the brief cheap to render.
  const refs = new Map<string, { at: number; value: { state: ShownState | null; title: string } | null }>();
  async function refCache(id: string) {
    const hit = refs.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = await pc.issue(id).then(
      async (i) => ({ state: (await stateRows([i.id])).get(i.id) ?? null, title: i.title }),
      (err) => (err instanceof PaperclipError && err.status === 404 ? null : Promise.reject(err)),
    );
    refs.set(id, { at: Date.now(), value });
    return value;
  }

  async function fleetCall<T>(req: IncomingMessage, run: (pc: Paperclip, caller: Agent) => Promise<T>, allowed = ["fleet-admin"]): Promise<T> {
    try {
      return await run(pc, await requireFleetRole(pc, req, allowed));
    } catch (err) {
      throw err instanceof Refused ? new HttpError(403, err.message) : err;
    }
  }

  async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL, internal: typeof routes) {
    const route = internal.find((r) => r.method === req.method && r.path.test(url.pathname));
    if (!route) throw new HttpError(404, "not found");
    const body = await readJson(req, route.maxBody);
    send(res, 200, JSON.stringify(await route.handle(url.pathname.match(route.path)!, body, url, req)), "application/json");
  }

  /** Account administration on the board: any admin, and never the owner's account. The kernel acts as that admin's session. */
  const RoleSchema = z.enum(["admin", "user"]);
  const setupFlows = opts.setupFlows?.flows.length && opts.accounts ? setupFlowRoutes({
    ...opts.setupFlows,
    accounts: opts.accounts,
    store,
    settings: () => readSources(settingsFiles()).compiled?.settings,
    file: fileSettingsChange,
    // "none": the connection needs no sign-in (Grafana with grafana_source: local), so its flow is done.
    onSetupChange: () => store.events.emit("setup"),
    signedIn: async (id) => ["ok", "none"].includes((await signInStates()).find((x) => x.id === id)?.status?.state ?? ""),
    scopeChoice: async (id) => Boolean(await (opts.signIns ?? []).find((x) => x.id === id)?.auth.offers()),
    signInMode: (id) => (opts.signIns ?? []).find((x) => x.id === id)?.mode ?? "redirect",
    connected: connectionSignedIn,
    boardUrl: signInOrigin,
    redirectUrl: (signin, host) => {
      const s = (opts.signIns ?? []).find((x) => x.id === signin);
      return s && `${redirectOrigin(s, host) ?? httpsBoard?.origin ?? SIGNIN_LOOPBACK}${s.callback}`;
    },
  }) : undefined;
  const accountRoutes: { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession, host: string) => Promise<unknown> }[] = [
    { method: "GET", path: /^\/api\/accounts$/, handle: async (_m, _b, who) => opts.accounts!.call("list", who) },
    // Your own signed-in browsers.
    { method: "GET", path: /^\/api\/accounts\/sessions$/, handle: async (_m, _b, who) => opts.accounts!.call("sessions", who) },
    { method: "POST", path: /^\/api\/accounts\/sessions\/([\w-]{1,64})\/revoke$/, handle: async (m, _b, who) => opts.accounts!.call("revoke_session", who, { id: m[1]! }) },
    // The Claude apps (MCP clients) this admin has signed in, and ending one.
    { method: "GET", path: /^\/api\/accounts\/mcp-clients$/, handle: async (_m, _b, who) => opts.accounts!.mcpGrants(who) },
    { method: "POST", path: /^\/api\/accounts\/mcp-clients\/([\w-]{1,64})\/revoke$/, handle: async (m, _b, who) => opts.accounts!.mcpRevoke(who, m[1]!) },
    {
      method: "POST",
      path: /^\/api\/accounts$/,
      handle: async (_m, body, who) => opts.accounts!.call("invite", who, parse(z.object({ email: z.string().email().max(200), name: z.string().max(100).default(""), role: RoleSchema }).strict(), body)),
    },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/role$/, handle: async (m, body, who) => opts.accounts!.call("role", who, { id: m[1]!, role: parse(z.object({ role: RoleSchema }).strict(), body).role }) },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/(disable|enable)$/, handle: async (m, _b, who) => opts.accounts!.call(m[2]!, who, { id: m[1]! }) },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/link$/, handle: async (m, _b, who) => opts.accounts!.call("link", who, { id: m[1]! }) },
    ...(opts.accounts && opts.welcomeMarker
      ? welcomeRoutes({
          accounts: opts.accounts,
          store,
          flows: opts.setupFlows?.flows ?? [],
          marker: opts.welcomeMarker,
          post: (text) => {
            const chats = routes.find((r) => r.method === "POST" && r.path.test("/api/chats"))!;
            return perRequest.run({ session: OPERATOR }, () => chats.handle([] as unknown as RegExpMatchArray, { text }, undefined as never, undefined as never)) as Promise<{ identifier: string }>;
          },
        })
      : []),
    // A sign-in's per-install value (board.signins `secrets`), from its Connect dialog: the kernel checks it against the
    // declared pattern, writes it to the vault and recreates the proxy, which then reads it (the dialog waits for that).
    {
      method: "POST",
      path: /^\/api\/sign-ins\/([a-z0-9-]{1,63})\/secret$/,
      handle: async (m, body, who) => {
        // A ready admin, as for the setup flows' saves; the kernel then lets only the owner write.
        if (!who.ready || who.account.role !== "admin") throw new HttpError(403, "totp");
        const s = (opts.signIns ?? []).find((x) => x.id === m[1]);
        const { secret, value } = parse(z.object({ secret: z.string().max(64), value: z.string().min(1).max(1000) }).strict(), body);
        if (!s?.fields.some((f) => f.secret === secret)) throw new HttpError(400, "not one of this sign-in's values");
        return opts.accounts!.call("save_secret", who, { module: s.id, secret, value });
      },
    },
    ...(opts.accounts && opts.organisations?.length ? organisationRoutes({ orgs: opts.organisations, accounts: opts.accounts, store, onApplied: () => store.events.emit("connections") }) : []),
    ...((opts.signIns ?? []).some((s) => s.mode === "device") ? deviceRoutes({ signIns: opts.signIns!, onSignedIn: connected }) : []),
    // App admins (docs/design/access.md, Per-app roles): every shared app, its admins and default; name or remove one.
    ...(setupFlows?.routes ?? []),
    { method: "GET", path: /^\/api\/app-admins$/, handle: async (_m, _b, who) => opts.accounts!.call("app_admins", who) },
    {
      method: "POST",
      path: /^\/api\/app-admins\/([a-z][a-z0-9-]{1,30})$/,
      handle: async (m, body, who) => opts.accounts!.call("app_admin_set", who, { app: m[1]!, ...parse(z.object({ email: z.string().max(200), admin: z.boolean() }).strict(), body) }),
    },
  ];

  /**
   * The session gate for every API route on "lan" (reads and file downloads included). Open: /api/session and /api/sign-out;
   * signing in, claiming a link and enrolling happen on the kernel's admin listener (`adminUrl`), and the board's own session
   * comes from the kernel's handoff (/auth/start). Returns true when it answered the request, else the session the board
   * routes run under.
   */
  async function accountGate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<true | BoardSession> {
    const accounts = opts.accounts!;
    const path = url.pathname;
    if (path === "/api/sign-out" && req.method === "POST") {
      await accounts.signOut(req, res, SECURITY_HEADERS);
      return true;
    }
    const who = await accounts.sessionOf(req);
    if (path === "/api/session" && req.method === "GET") {
      const account = who ? { id: who.account.id, email: who.account.email, name: who.account.name, role: who.account.role, owner: who.account.owner } : null;
      send(res, 200, JSON.stringify({ mode, account, googleConnect: googleViaBoard, signInConnect: true, adminUrl: opts.adminUrl ?? null }), "application/json");
      return true;
    }
    if (!who) throw new HttpError(401, "sign in");
    const a = accountRoutes.find((r) => r.method === req.method && r.path.test(path));
    if (a) {
      const body = req.method === "GET" ? undefined : await readJson(req);
      // Under the request's context, as routeApi's routes run: a setup flow's settings change carries this board session.
      const out = await perRequest.run({ session: accountSession(who), req }, () => a.handle(path.match(a.path)!, body, who, String(req.headers.host ?? "").toLowerCase()));
      send(res, 200, JSON.stringify(out), "application/json");
      return true;
    }
    // A ready admin: writes as the owner (through the kernel); `authored` records which account it was.
    const session = accountSession(who);
    if (!session) throw new HttpError(403, "this account has no board access");
    return session;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (opts.session) {
      const session = await opts.session(req);
      if (!session) throw new HttpError(401, "sign in");
      if (session.role !== "admin") throw new HttpError(403, "this account has no board access");
      return routeApi(req, res, url, session);
    }
    const session = await accountGate(req, res, url);
    if (session === true) return;
    return routeApi(req, res, url, session);
  }

  /** Every board route, once the listener's gate has let the request in: `session` is recorded on what it writes (see `pc`). */
  async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, session: BoardSession | null) {
    const path = url.pathname;
    return perRequest.run({ session, req }, async () => {
      const file = req.method === "GET" ? /^\/api\/issues\/([^/]+)\/files\/([0-9a-f-]{36})$/.exec(path) : null;
      if (file) return download(res, dec(file[1]!), file[2]!);
      // Live updates (events.ts): an event stream, behind the same gate.
      if (req.method === "GET" && path === "/api/events") {
        return store.events.stream(req, res, SECURITY_HEADERS);
      }
      const route = routes.find((r) => r.method === req.method && r.path.test(path));
      if (!route) throw new HttpError(404, "not found");
      const body = req.method === "GET" ? undefined : await readJson(req, route.maxBody);
      const result = await route.handle(path.match(route.path)!, body, url, req);
      await sendCompressed(req, res, 200, JSON.stringify(result), "application/json");
    });
  }

  /** Starting a Google or MCP sign-in: any ready admin (all admins act as the owner); the callbacks' single-use state is their proof. */
  const adminSignedIn = async (req: IncomingMessage) => {
    const s = opts.session ? await opts.session(req) : accountSession(await opts.accounts!.sessionOf(req));
    return s?.role === "admin";
  };
  const isConnect = (path: string) => path === "/google/connect" || /^\/connect\/[a-z0-9-]{1,63}$/.test(path) || (opts.signIns ?? []).some((s) => s.connect === path);
  /**
   * The one link the kernel gives the owner for a module (kernel connection-state.ts): to its sign-in's Connect, else its setup
   * flow's own connect path, else its setup page. Those handlers word what can't work from this address (an https-only vendor
   * on a plain-http board, a loopback flow away from the tunnel), so the link is the same in every exposure mode.
   */
  function connectLink(res: ServerResponse, module: string) {
    const to = (opts.signIns ?? []).find((s) => s.id === module)?.connect
      ?? opts.setupFlows?.flows.find((f) => f.module === module && f.connect_url)?.connect_url
      ?? `/#/setup/${module}`;
    res.writeHead(302, { ...SECURITY_HEADERS, location: to, "cache-control": "no-store" }).end();
  }
  /** A connect path's connection (a setup flow's connect_url): signed in, or undefined when the board serves no such path. */
  async function connectionSignedIn(path: string): Promise<boolean | undefined> {
    if (path === "/google/connect") return opts.google ? !!(await opts.google.status())?.accounts.some((a) => a.state === "ok") : undefined;
    const s = (opts.signIns ?? []).find((x) => x.connect === path);
    return s ? (await s.auth.status())?.state === "ok" : undefined;
  }

  /**
   * Connect a Google account, or reconnect an expired one: /google/connect sends the browser to Google's
   * consent screen, Google sends it back to /google/callback, and google-workspace-mcp stores the token. On the
   * laptop's loopback address (a Desktop-app client), or at the board's https address (BOARD_LAN_URL, registered as a
   * redirect on a Web-app client: the company OAuth app, ops/setup.sh). The callback needs no session (a cookie isn't sent
   * on Google's cross-site redirect): its single-use state, minted for the owner's session, is the proof.
   */
  async function handleGoogle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!opts.google) throw new HttpError(404, "Google sign-in isn't set up on the board (no google_auth_token)");
    // A Desktop client returns only to loopback: the sign-in ends on the board's loopback address, pasted back on its Connect
    // dialog unless a tunnel brings it here. A Web client returns to the board's https address (or the loopback board).
    const desktop = (await opts.google.status())?.client_type === "desktop";
    if (!desktop && !googleViaBoard && !loopbackPort(req.headers.host)) throw new HttpError(403, `connect Google from ${TUNNEL}`);
    const callback = desktop ? `${SIGNIN_LOOPBACK}/google/callback` : `${signInOrigin(String(req.headers.host).toLowerCase())}/google/callback`;
    try {
      if (url.pathname === "/google/connect") {
        const account = url.searchParams.get("account") || undefined;
        // From a link (a banner, an old page): the Connect dialog, which opens this again (`go`) and takes the pasted address.
        if (desktop && !url.searchParams.has("go") && !loopbackPort(req.headers.host)) {
          res.writeHead(302, { ...SECURITY_HEADERS, location: `/#/settings/connections?connect=google_workspace${account ? `&account=${encodeURIComponent(account)}` : ""}`, "cache-control": "no-store" }).end();
          return;
        }
        const { url: consent } = await opts.google.start(account, callback);
        log.info({ account: account ?? "(new)" }, "Google sign-in started");
        res.writeHead(302, { ...SECURITY_HEADERS, location: consent, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/google/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? undefined;
        // Google's own error goes to the service, which explains it in words (the person refused, the project doesn't allow them).
        const { email } = await opts.google.finish(state, code, code ? undefined : (url.searchParams.get("error") ?? "no_code").slice(0, 100));
        log.info({ account: email }, "Google account connected");
        connected("google");
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      log.warn({ err: String((err as Error).message ?? err).slice(0, 500) }, "Google sign-in failed");
      return signInFailed(res, "google", `Couldn't connect Google: ${err instanceof GoogleAuthFailed ? err.message : "google-workspace-mcp isn't answering"}`);
    }
    throw new HttpError(404, "not found");
  }

  /**
   * A module's sign-in (board.signins): /<id>/connect sends the browser to the service's sign-in, which sends it back to
   * the callback, and the proxy keeps the token. By default the redirect is loopback (SIGNIN_LOOPBACK plus the callback): the
   * owner pastes the address that tab ends on into Connect (POST /api/sign-ins/<id>/finish), or a tunnel lands it here.
   * `?oneclick=1` (and an `https_only` vendor) return to the board's https address instead, which a company may first have
   * to allow. The proxy registers its client for the redirect it is given (or the owner's hand-made client lists it: the
   * setup flow shows it). A vendor may permit only the bare /callback shape.
   */
  const signInFor = (path: string) => (opts.signIns ?? []).find((s) => s.connect === path || s.callback === path);
  /** The setup flow (board.setup_flows) whose sign-in this is: Connect starts there while its secrets are missing. */
  const flowOf = (s: SignIn) => opts.setupFlows?.flows.find((f) => f.signin === s.id);
  /** The connection's dialog on Settings, Connections: its Connect asks for values, offers scopes, or says what failed. */
  const dialogOf = (id: string, error?: string) => `/#/settings/connections?connect=${id}${error ? `&error=${encodeURIComponent(error)}` : ""}`;
  /**
   * Whether a Connect must open the flow first: it asks for secrets the vault hasn't got and the sign-in has never worked (a
   * Reconnect of an expired sign-in goes on: an upgraded instance can work with its values outside the vault).
   */
  async function needsSetup(req: IncomingMessage, s: SignIn): Promise<boolean> {
    const f = flowOf(s);
    const who = (f?.secrets?.length || f?.choose) && opts.accounts ? await opts.accounts.sessionOf(req) : null;
    if (!f || !who) return false;
    // A module with modes asks its choice first (setup-flows.ts); until it is made and live, Connect opens the flow.
    const chosen = store.meta(`setup_choice:${f.module}`);
    const unchosen = Boolean(f.choose) && (chosen == null || String(readSources(settingsFiles()).compiled?.settings?.[f.choose!.setting]?.value) !== chosen);
    const { secrets } = f.secrets?.length ? await opts.accounts!.call<{ secrets: Record<string, boolean> }>("setup_status", who, { module: f.module }) : { secrets: {} as Record<string, boolean> };
    return (unchosen || (f.secrets ?? []).some((x) => !secrets[x])) && (await s.auth.status())?.state === "missing";
  }

  async function handleSignIn(req: IncomingMessage, res: ServerResponse, url: URL, s: SignIn) {
    const { label: name, connect, callback, auth } = s;
    // A callback lands only where a redirect can: the loopback board (a tunnel) or its https name.
    const host = String(req.headers.host ?? "");
    const origin = url.pathname === connect ? redirectOrigin(s, host, url.searchParams.has("oneclick")) : vendorOrigin(host);
    if (!origin) return signInFailed(res, s.id, `Couldn't connect ${name}: ${httpsBoard ? `sign in from ${httpsBoard.origin}` : `sign in from ${TUNNEL}`}`);
    try {
      // A device sign-in has no redirect: its Connect dialog shows the code.
      if (url.pathname === connect && s.mode === "device") {
        res.writeHead(302, { ...SECURITY_HEADERS, location: dialogOf(s.id), "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === connect && (await needsSetup(req, s))) {
        res.writeHead(302, { ...SECURITY_HEADERS, location: `/#/setup/${flowOf(s)!.module}`, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === connect) {
        // The board's Connect asks for the sign-in's own values and offers its scopes before it comes here (owner, 2026-11-18);
        // a Connect from elsewhere (an old link) gets that dialog first: values missing, or a choice of scopes not yet made.
        const picked = url.searchParams.has("picked");
        if ((s.fields.length && asksValues(await auth.status(0))) || (!picked && (await auth.offers()))) {
          res.writeHead(302, { ...SECURITY_HEADERS, location: dialogOf(s.id), "cache-control": "no-store" }).end();
          return;
        }
        const { url: signIn } = await auth.start(`${origin}${callback}`, picked ? url.searchParams.getAll("scope") : undefined);
        log.info(`${name} sign-in started`);
        res.writeHead(302, { ...SECURITY_HEADERS, location: signIn, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === callback) {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code) throw new McpAuthFailed(`${name} didn't grant access: ${vendorWords(url.searchParams.get("error") ?? "no_code", url.searchParams.get("error_description"))}`);
        await auth.finish(state, code);
        log.info(`${name} connected`);
        // The tab that pressed Connect turns Connected now (events.ts); this one, opened for the sign-in, closes itself or shows it.
        connected(s.id);
        res.writeHead(302, { ...SECURITY_HEADERS, location: `/#/settings/connections?connected=${s.id}`, "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      log.warn({ err: String((err as Error).message ?? err).slice(0, 500) }, `${name} sign-in failed`);
      return signInFailed(res, s.id, `Couldn't connect ${name}: ${err instanceof McpAuthFailed ? err.message : `${name.toLowerCase()}-mcp isn't answering`}`);
    }
    throw new HttpError(404, "not found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    const rel = normalize(dec(path)).replace(/^(\.\.[/\\])+/, "");
    let file = join(opts.staticDir, rel);
    if (!file.startsWith(opts.staticDir)) throw new HttpError(404, "not found");
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    // A missing hashed asset is a 404, never the page: a tab from before a deploy then reloads itself (main.tsx).
    if (!isFile && rel.startsWith("/assets/")) throw new HttpError(404, "not found");
    if (!isFile) file = join(opts.staticDir, "index.html"); // client-side routes
    const data = await readFile(file).catch(() => undefined);
    if (!data) throw new HttpError(404, "not found");
    const immutable = rel.startsWith("/assets/");
    const once = (enc: "br" | "gzip") => {
      const key = `${enc}:${file}`;
      if (!staticCompressed.has(key)) staticCompressed.set(key, compress(data, enc));
      return staticCompressed.get(key)!;
    };
    await sendCompressed(req, res, 200, data, TYPES[extname(file)] ?? "application/octet-stream", immutable ? "public, max-age=31536000, immutable" : "no-cache", once);
  }

  /**
   * A board route run in process (the MCP's tools): the same table and the same request context `routeApi` installs, as the
   * MCP's session, so a write carries the account's byline exactly as a tap does. Never HTTP to itself.
   */
  async function callRoute(method: string, path: string, body: unknown, session: BoardSession, req: IncomingMessage, credential: SettingsCredential) {
    const url = new URL(path, "http://board");
    const route = routes.find((r) => r.method === method && r.path.test(url.pathname));
    if (!route) throw new HttpError(404, `no such route ${method} ${url.pathname}`);
    return perRequest.run({ session, via: "mcp", credential }, () => route.handle(url.pathname.match(route.path)!, body, url, req));
  }
  const mcpAuth = opts.accounts && opts.adminUrl ? createMcpAuth(opts.accounts, opts.adminUrl) : undefined;
  /** The same dispatch with the bearer's own session (checked per request), for the tools' `callRoute`. */
  const sessions = new WeakMap<IncomingMessage, { session: BoardSession; credential: SettingsCredential }>();
  const mcp = mcpAuth && createMcp({ callRoute: (m, p, b, req) => { const s = sessions.get(req)!; return callRoute(m, p, b, s.session, req, s.credential); }, decide: (t, r, c) => opts.accounts!.mcpDecide(t, r, c), update: (t, r, to) => opts.accounts!.mcpUpdate(t, r, to), flows: () => opts.setupFlows?.flows ?? [], setupStates: async () => (await setupFlows?.states()) ?? [] });

  /** /mcp and its discovery document: bearer only (never a cookie), before the board's own request checks. */
  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = mcpAuth!;
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!opts.allowedHosts.includes(host)) throw new HttpError(403, "unknown host");
    if (url.pathname === "/.well-known/oauth-protected-resource") return send(res, 200, JSON.stringify(auth.metadata()), "application/json");
    // A page in a browser (DNS rebinding, CSRF) carries an Origin that is not the board's own; a CLI carries none.
    const origin = req.headers.origin;
    if (origin && (origin === "null" || !URL.canParse(origin) || ![auth.board, new URL(auth.origin(req)).origin].includes(new URL(origin).origin))) throw new HttpError(403, "cross-origin");
    // Every 401 leaves one line (never the token): why, the kernel's own word if it gave one, and who asked.
    const unauthorized = (error?: string, why = "no bearer", code?: string) => {
      log.warn({ reason: why, ...(code ? { code } : {}), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 100) }, "/mcp answered 401");
      res.writeHead(401, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store", "www-authenticate": auth.challenge(error) }).end(JSON.stringify({ error: error ?? "sign in" }));
    };
    const token = auth.bearer(req);
    if (!token) return unauthorized();
    if (req.method !== "POST") {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
      return;
    }
    const body = await readJson(req, 1_000_000);
    const calls = (Array.isArray(body) ? body : [body]) as { method?: string; params?: { name?: string } }[];
    const writes = calls.some((m) => m?.method === "tools/call" && WRITE_TOOLS.has(String(m.params?.name)));
    let code: string | undefined;
    // The kernel restarts in every apply: a token it couldn't be asked about is not a token it refused. A 401 makes the client
    // sign the owner in again, a 503 makes it retry. Only the kernel being unavailable (no answer, a timeout, a 5xx) is a 503;
    // any other kernel answer is its verdict on this request.
    const checked = await auth.check(token, writes, (c) => (code = c)).then(
      (who) => ({ who }),
      (e: Error & { status?: number }) => {
        if (e.status !== undefined && e.status < 500) throw e;
        return { unavailable: String(e.message).slice(0, 100) };
      },
    );
    if ("unavailable" in checked) {
      log.warn({ err: checked.unavailable, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 100) }, "/mcp answered 503: kernel unavailable");
      res.writeHead(503, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store", "retry-after": "5" }).end(JSON.stringify({ error: "the kernel is restarting: retry" }));
      return;
    }
    const who = checked.who;
    if (!who) return unauthorized("invalid_token", "kernel refused", code);
    sessions.set(req, { session: who.session, credential: { mcp: { token, resource: auth.resource() } } });
    await mcp!(req, res, body, { token, resource: auth.resource(), origin: auth.board });
  }

  const server = createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://board");
    } catch {
      return send(res, 400, "bad request", "text/plain");
    }
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");
    if (mode === "internal") {
      try {
        // The monitoring module's routes (monitoring.ts): their own token, which opens nothing else.
        if (url.pathname === "/internal/metrics") {
          const token = monitoringToken();
          if (!token || !bearerMatches(req.headers.authorization, token)) throw new HttpError(401, "unauthorized");
          if (!String(req.headers.host ?? "") || !opts.allowedHosts.includes(String(req.headers.host).toLowerCase())) throw new HttpError(403, "unknown host");
          if (req.method !== "GET") throw new HttpError(405, "method not allowed");
          return send(res, 200, await metricsText(records), "text/plain; version=0.0.4; charset=utf-8");
        }
        // Only the board's internal token.
        const token = opts.internalToken;
        if (!token || !bearerMatches(req.headers.authorization, token)) throw new HttpError(401, "unauthorized");
        if (!String(req.headers.host ?? "") || !opts.allowedHosts.includes(String(req.headers.host).toLowerCase())) throw new HttpError(403, "unknown host");
        await handleInternal(req, res, url, internal);
      } catch (err) {
        const status = statusOf(err);
        if (status >= 500 || status === 401) log[status === 401 ? "warn" : "error"]({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "internal request failed");
        if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error" }), "application/json");
      }
      return;
    }
    // The owner's MCP: its own checks (host, origin, bearer), before the board's cookie-based ones.
    if (mcp && (url.pathname === "/mcp" || url.pathname === "/.well-known/oauth-protected-resource")) {
      try {
        await handleMcp(req, res, url);
      } catch (err) {
        const status = statusOf(err);
        if (status >= 500) log.error({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "request failed");
        if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error" }), "application/json");
      }
      return;
    }
    const rejected = checkRequest(req, opts.allowedHosts);
    if (rejected) {
      log.warn({ method: req.method, path: url.pathname, reason: rejected }, "request rejected");
      return send(res, 403, JSON.stringify({ error: rejected }), "application/json");
    }
    // Local mode (the kernel's sign-in is on localhost): a page opened at 127.0.0.1 moves to localhost first. Sign-in
    // crosses to the kernel's localhost origin and back, and a 127.0.0.1 board bookmarked before that dead-ends there.
    const host = String(req.headers.host ?? "").toLowerCase(), local = host.replace(/^127\.0\.0\.1/, "localhost");
    if (opts.mode === "lan" && (req.method === "GET" || req.method === "HEAD") && req.headers["sec-fetch-mode"] === "navigate" && local !== host && opts.allowedHosts.includes(local) && opts.adminUrl && new URL(opts.adminUrl).hostname === "localhost") {
      res.writeHead(308, { location: `http://${local}${req.url ?? "/"}`, "cache-control": "no-store" }).end();
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      // The kernel's handoff (kernel-auth.ts): the board's own session, on its own origin.
      else if (url.pathname === "/auth/start" && req.method === "GET" && opts.accounts) opts.accounts.start(req, res);
      else if (url.pathname === "/auth/handoff" && req.method === "GET" && opts.accounts) await opts.accounts.finish(req, res, url);
      else if (isConnect(url.pathname) && !(await adminSignedIn(req))) throw new HttpError(403, "sign in as an admin to connect accounts");
      else if (url.pathname.startsWith("/connect/") && req.method === "GET") connectLink(res, url.pathname.slice("/connect/".length));
      else if (url.pathname.startsWith("/google/") && req.method === "GET") await handleGoogle(req, res, url);
      else if (signInFor(url.pathname) && req.method === "GET") await handleSignIn(req, res, url, signInFor(url.pathname)!);
      else if (req.method === "GET" || req.method === "HEAD") await serveStatic(req, res, url.pathname);
      else throw new HttpError(405, "method not allowed");
    } catch (err) {
      const status = statusOf(err);
      if (status >= 500) log.error({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "request failed");
      if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error", ...(err instanceof HttpError && err.errors ? { errors: err.errors } : {}), ...(err instanceof ViewConflict ? { current: err.current } : {}) }), "application/json");
    }
  });
  return Object.assign(server, { sweep });
}

/** ops/setup.sh's welcome chat (the operator's key): written as the owner, and never an approver. */
const OPERATOR: BoardSession = { accountId: "operator", role: "admin" };

const statusOf = (err: unknown) => (err instanceof HttpError || err instanceof AccountError ? err.status : err instanceof BadRequest ? 400 : err instanceof PaperclipError ? (err.status === 404 ? 404 : 502) : 500);

/** A percent-decoded path part; a malformed escape is the caller's 400, not a thrown URIError. */
function dec(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, "bad request");
  }
}

function keyMatches(header: string | string[] | undefined, key: string): boolean {
  const given = Buffer.from(typeof header === "string" ? header : "");
  const want = Buffer.from(key);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The monitoring module's scrape and webhook token (modules/monitoring), read fresh; "" when the module is off. */
function monitoringToken(): string {
  try {
    return readFileSync(process.env.MONITORING_TOKEN_FILE ?? "/run/secrets/monitoring_token", "utf8").trim();
  } catch {
    return "";
  }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(String(header ?? ""))?.[1] ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

async function readJson(req: IncomingMessage, max = 256_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

/** A failed sign-in: back to its Connect dialog on Settings, Connections, which shows why and Try again (kept short: it rides in a header). */
function signInFailed(res: ServerResponse, id: string, message: string) {
  const why = message.length > 400 ? `${message.slice(0, 399)}…` : message;
  res.writeHead(302, { ...SECURITY_HEADERS, location: `/#/settings/connections?connect=${id}&error=${encodeURIComponent(why)}`, "cache-control": "no-store" }).end();
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store") {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache });
  res.end(body);
}

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);
/** The encoding the browser takes, for a body worth compressing (text over 1 KB). */
function encodingFor(req: IncomingMessage, type: string, size: number): "br" | "gzip" | null {
  if (size < 1024 || !/^(text\/|application\/(json|javascript|manifest))/.test(type)) return null;
  const accepts = String(req.headers["accept-encoding"] ?? "");
  return /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
}
/** Fast settings: API answers are compressed on every request; static files once each (staticCompressed). */
const compress = (body: Buffer, enc: "br" | "gzip") => (enc === "br" ? brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipped(body, { level: 6 }));

/** `send`, compressed when the browser takes it: the chat and task JSON shrink to about a fifth. */
async function sendCompressed(req: IncomingMessage, res: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store", encoded?: (enc: "br" | "gzip") => Promise<Buffer>) {
  const raw = typeof body === "string" ? Buffer.from(body) : body;
  const enc = encodingFor(req, type, raw.length);
  if (!enc) return send(res, status, raw, type, cache);
  const out = await (encoded ?? ((e) => compress(raw, e)))(enc);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache, "content-encoding": enc, vary: "accept-encoding" });
  res.end(out);
}

/** Each built file's compressed copies, made on first request (a deploy restarts the board, so they never go stale). */
const staticCompressed = new Map<string, Promise<Buffer>>();


const PR_URL = z.string().max(300).regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d{1,9}\/?$/, "a pull request link, like https://github.com/acme/payments/pull/42");
const OneOffSchema = z.object({ pr_url: PR_URL, combos: CombosSchema.min(1).optional(), focus: z.string().max(500).regex(/^[^\x00-\x1f\x7f]*$/).optional(), full: z.boolean().optional() }).strict();
const CatalogQuerySchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), commit: z.string().regex(/^[0-9a-f]{40}$/i).optional() }).strict();
const ReviewConfigSchema = z.object({ value: z.unknown() }).strict();
const DismissSchema = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().min(1), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), reason: z.string().trim().min(1).max(1000) }).strict();
