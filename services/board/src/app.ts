import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import type { Logger } from "pino";
import { z } from "zod";
import { liveActivity, type SessionSources } from "./live-activity.js";
import { makeRuns } from "./runs.js";
import { RunnerReportSchema, agentsView, roster, runTasks, workingOn, type RunContext, type RunnerReport, type TaskRef, type Working } from "./activity.js";
import { RecurringSchema, RunStateSchema, ScheduleSchema, changeRecurring, claimDue, recurringView, scheduleMove } from "./automation.js";
import { AddAgentSchema, BadRequest, CreateSchema, HandOverSchema, PassSchema, RUNNER_MARKER, hasMarker, UpdateSchema, assignees, buildBoard, commentView, displayText, executorOf, openrouterEngine, paperclipUpdate, replyTarget, toCard, type Assignee } from "./board.js";
import { FOR_OTHERS, RELAY_MARKER, crewOf, deliveredFrom, deliveredText, foldedChildren, fromMarker, handOverText, mentionedAgents, withHandle, partsToClose, summaryOf, waitsOnItsOwn, type DeliveredFrom } from "./crew.js";
import { AccountError, forwardedProto, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import { INLINE_TYPES, MAX_UPLOAD_BODY, UploadSchema, decode, fileType, fileViews, isPdf, pdfText, safeName } from "./files.js";
import { ControlSchema, CostsSchema, RelaySchema, Refused, holdsRole, appsApi, assertMeantTask, boundedFleetStatus, fleetControl, fleetCosts, fleetStatus, relayableWords, requireAgent, requireFleetRole } from "./fleet.js";
import { detectorState, kickDetector, staleSources, takeOwnerLines } from "./fleet-ops.js";
import { AlertsSchema, metricsText, receiveAlerts } from "./monitoring.js";
import { kernelRecords, type Approval, type Records } from "./records.js";
import { wakeCheck } from "./brake.js";
import { gatherFacts, scorecard, statusSummary } from "./fleet-stats.js";
import { coachDue, coachEvidence } from "./coach.js";
import { moduleStates } from "./modules.js";
import { connectionsView, probe, readSources, settingsView, type Probe } from "./settings.js";
import { ChangeRefused, ChangesSchema, SETTINGS_LABEL, changesOf, checkChange, stageOf, taskFor } from "./settings-change.js";
import { createGrading, gradePassed, type Grading } from "./grading.js";
import { UsageSchema, WINDOWS, costs, keyUsage, prices, type CostWindow } from "./costs.js";
import { ledgerRange, ledgerSummary, ledgerTop } from "./cost-ledger.js";
import { MergeSchema, mergedDescription } from "./merge.js";
import { McpAuthFailed, type McpAuth } from "./mcpauth.js";
import { GoogleAuthFailed, loopbackPort, type GoogleAuth } from "./google.js";
import { OPEN, Paperclip, PaperclipError, type Agent, type Comment, type Issue, type Label, type LiveRun } from "./paperclip.js";
import { accountSession, type BoardSession, type SessionOf } from "./session.js";
import { laneAgents, laneMessages, laneSend, type LaneOptions } from "./lane.js";
import { latest, successorOf } from "./rollover.js";
import { NOTICE_MARKER, chatAgent, chatAgentMarker, chatState, conversation, lastWord, needsYou, openAsk, pickAgent, shownState, type Message } from "./chats.js";
import { activityDays } from "./days.js";
import { addDays, nextWorkday, type Weekday } from "./recurrence.js";
import { BUCKETS, isBucket, localDate, type Store } from "./store.js";
import { AsideSchema, askGateway, asideMessages, holdsActive, lineageStatus, lineageTotal, modelOf, settleable, stillSettled, type LineageRow } from "./lineage.js";

/** One module sign-in (board.signins), with its proxy client. */
export interface SignIn { id: string; label: string; connect: string; callback: string; missing: string; stopped: string; auth: McpAuth }

export interface AppOptions {
  /** The board key's client: every read and every write (all admins write as the owner, 2026-11-12). */
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
   * kernel's admin listener, 3120). "internal": the tasks bridge, the runner and the kernel, with a bearer token, /internal/ only.
   */
  mode?: "lan" | "internal";
  /** The kernel's admin listener (AIDENHQ_ADMIN_URL): sign-in, and the approval page where every card is decided. */
  adminUrl?: string;
  /** googleConnect: Google's Connect from the board's https address `url` (a Web-app OAuth client, ops/setup.sh). */
  lan?: { url: string; googleConnect?: boolean };
  internalToken?: string;
  /** The fast chat lane (slack-live-mcp /lane); without it the lane routes answer empty. */
  lane?: LaneOptions;
  /** Shared by the listeners: the runner reports to the internal one, the board reads it on the others. */
  activity?: { runner?: RunnerReport };
  /** Where a Codex agent's session log is (see live-activity.ts): without it, a working agent shows no steps. */
  sessions?: SessionSources;
  /** Google sign-in state and re-consent; no banner and no reconnect without it. */
  google?: GoogleAuth;
  /** The modules' sign-ins through their MCP proxies (board.signins, config.ts): a banner and a Connect each. */
  signIns?: SignIn[];
  /** The grading module's client (grading.ts); default: built from GRADING_URL and GRADING_BOARD_KEY_FILE. */
  grading?: Grading;
  /** "internal" mode: the runner's key (secret reviewer_key): its routes (grades, usage, jobs), never agents'. */
  reviewerKey?: string;
  /**
   * "internal" mode: the kernel's key (secret gateway_board_key, x-gateway-key; held only by the kernel and the board): the model
   * gateway files raise_cap, and channels reach the owner's cards, decisions and notices only through the kernel (lean-core 2f).
   */
  gatewayKey?: string;
  /** The model gateway (every listener: a raise_cap is applied where it is tapped): an approved raise_cap sets the new cap there. */
  gateway?: { url: string; token: string };
  /** The kernel's records, read-only (records.ts): the cards every view shows. Without it, there are none. */
  records?: Records;
  /**
   * The operator's key (secret board_operator_key, x-operator-key), for ops/setup.sh only, on "internal": the owner's setup
   * link, the welcome chat and an account reset. Nothing else.
   */
  operatorKey?: string;
  /**
   * Board sign-in (kernel-auth.ts, docs/design/access.md): every route on "lan" needs a ready admin's board session, handed off
   * by the kernel. Required there (or the `session` stub).
   */
  accounts?: KernelAuth;
}

/** What the board and agents see of a card; the executor's args stay in the kernel. */
const approvalView = (approval: Approval) => {
  const { args: _args, ...a } = approval;
  return a;
};

const REF = /^(?:[0-9a-f-]{36}|[A-Z][A-Z0-9]{1,9}-\d{1,7})$/;
const RECENT_MS = 48 * 3_600_000;
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
  constructor(readonly status: number, message: string) {
    super(message);
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

export function createApp(opts: AppOptions): Server {
  const { paperclip: boardPc, store, log } = opts;
  const mode = opts.mode ?? "lan";
  if (mode !== "internal" && !opts.accounts && !opts.session) throw new Error(`the ${mode} listener needs board accounts`);
  const grading = opts.grading ?? createGrading();
  /** The grades of these tasks; the grading module unreachable: undefined, so the caller leaves its graded closes undone. */
  const gradesOf = (ids: string[]) => grading.grades(ids).catch((err) => (log.warn({ err: String(err) }, "grading module unreachable; not closing graded parts as done"), undefined));

  /**
   * Every admin writes as the owner (the board key: agents act on their words, owner decision 2026-11-12). Which account
   * wrote a task or comment is recorded (`authored`) from the request's session, for the board's "by <name>" label; never
   * in the text. Outside a session (the internal listener, timers, the board's own notices) nothing is recorded.
   */
  const perRequest = new AsyncLocalStorage<{ session: BoardSession | null }>();
  const pc = new Proxy(boardPc, {
    get(client, prop) {
      const value = Reflect.get(client, prop, client);
      if (typeof value !== "function") return value;
      const s = perRequest.getStore()?.session;
      const account = s && s !== OPERATOR ? s.accountId : undefined;
      // What the board posts or opens is announced to open boards (events.ts): the task's id only.
      if (prop === "addComment" || prop === "createIssue")
        return async (...args: unknown[]) => {
          const made = await value.apply(client, args);
          if (account) store.setAuthored(made.id, account);
          store.events.emit("chat", prop === "addComment" ? String(args[0]) : made?.id);
          return made;
        };
      return value.bind(client);
    },
  }) as Paperclip;

  /** Display names of the accounts other than the owner: what they wrote or decided carries a "by <name>" label. */
  async function bylines(): Promise<Map<string, string>> {
    if (!opts.accounts) return new Map();
    return new Map((await opts.accounts.names()).filter((a) => !a.owner).map((a) => [a.id, a.name || a.email]));
  }
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
  const identifiers = new Map<string, string>();
  async function named<T extends Approval>(a: T): Promise<T> {
    if (a.identifier !== a.issueId) return a;
    const id = identifiers.get(a.issueId) ?? (await pc.issue(a.issueId).then((i) => i.identifier, () => undefined));
    if (id) identifiers.set(a.issueId, id);
    return id ? { ...a, identifier: id } : a;
  }
  const cardsOf = async (state: Parameters<Records["list"]>[0], opt?: Parameters<Records["list"]>[1]) => Promise.all((await records.list(state, opt)).map(named));

  const sessionOf = liveActivity(opts.sessions);
  const runOf = makeRuns({ pc, store, sessionsDir: opts.sessions?.dir, grantsFile: process.env.AIDENHQ_GRANTS_FILE });
  /** The newest runs on a task, for the links to their run pages. */
  const runLinks = (past: { id: string; agentId: string; status: string; issueId: string | null; startedAt: string | null }[], issueId: string, agents: Agent[]) =>
    past.filter((r) => r.issueId === issueId).slice(0, 6).map((r) => ({ id: r.id, agent: agents.find((a) => a.id === r.agentId)?.name ?? "Agent", status: r.status, at: r.startedAt }));
  /** A run's page data with the names of its agent and task. */
  async function runView(id: string) {
    const run = await runOf(id);
    if (!run) throw new HttpError(404, "Paperclip no longer has this run (pruned), or it isn't this company's");
    const [agents, issue] = await Promise.all([pc.agents(), run.issueId ? pc.issueSummary(run.issueId).catch(() => undefined) : undefined]);
    return { ...run, agent: agents.find((a) => a.id === run.agentId)?.name ?? "Agent", issue: issue ? { identifier: issue.identifier, title: issue.title } : null };
  }
  /** A Paperclip-run Codex agent's live words, plan and steps from its session log, on top of what Paperclip says. Runner jobs report their own. */
  async function withSession(w: Working | null | undefined, live: LiveRun[], issueId: string, full: boolean): Promise<Working | null> {
    const run = w && !w.queued && !w.plan ? live.find((r) => r.issueId === issueId && r.status === "running") : undefined;
    const a = run && (await sessionOf(run.agentId, run.startedAt ?? run.createdAt));
    if (!w || !a) return w ?? null;
    return { ...w, ...(a.said ? { said: a.said, saidAt: a.saidAt } : {}), ...(full ? { ...(a.plan ? { plan: a.plan } : {}), ...(a.steps.length ? { steps: a.steps } : {}) } : {}) };
  }

  async function context() {
    const [me, agents, labels, company] = await Promise.all([pc.me(), pc.agents(), pc.labels(), pc.company()]);
    return { me, agents, labels, assignees: assignees(agents), prefix: company.issuePrefix ?? "" };
  }

  /** The tasks the board shows: assigned to the user, the Researcher or an Engineer. */
  const mine = (issues: Issue[], ctx: { me: string; assignees: Assignee[] }) =>
    issues.filter((i) => (i.assigneeAgentId ? ctx.assignees.some((a) => a.key === i.assigneeAgentId) : i.assigneeUserId === ctx.me));

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

  /**
   * The runner's own key (secret reviewer_key: held only by the runner and the board, never by agents, which can reach the
   * internal token): its routes (grades, usage, jobs).
   */
  const runnerKeyed = (req: IncomingMessage) => Boolean(opts.reviewerKey && keyMatches(req.headers["x-reviewer-key"], opts.reviewerKey));
  /** The internal token alone opens nothing: every route also names its caller (agents can read the token in their shell). */
  function requireRunner(req: IncomingMessage, what: string) {
    if (!runnerKeyed(req)) throw new HttpError(403, `only the runner ${what}`);
  }
  /** The operator's key (ops/setup.sh), on the internal listener only; it never decides or opens a session. */
  function requireOperator(req: IncomingMessage, what: string) {
    if (!opts.operatorKey || !keyMatches(req.headers["x-operator-key"], opts.operatorKey)) throw new HttpError(403, `only the operator ${what}`);
  }
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

  // Agent activity (Paperclip runs and the runner's jobs). The runner reports through the internal API.
  const shared = opts.activity ?? {};

  /** The task a run is attached to, and the user's tasks it works on. */
  async function runContext(issueId: string | null, prefix: string): Promise<RunContext> {
    if (!issueId) return { run: null, tasks: [] };
    const issue = await pc.issueSummary(issueId).catch(() => undefined);
    if (!issue) return { run: null, tasks: [] };
    const tasks = runTasks(issue, prefix);
    await titled(tasks);
    return { run: { identifier: issue.identifier, title: issue.title }, tasks, assigneeAgentId: issue.assigneeAgentId };
  }

  /** Names the tasks that carry only an identifier, looked up at once. */
  const titled = (tasks: TaskRef[]) => Promise.all(tasks.filter((t) => t.title == null).map(async (t) => (t.title = (await refCache(t.identifier).catch(() => null))?.title)));

  async function activity(ctx: { agents: Awaited<ReturnType<typeof pc.agents>>; prefix: string }, withPast: boolean) {
    // The roster never fails the page: without routines or run history, cards just show less. Started alongside the runs.
    const rosterParts = withPast ? Promise.all([pc.routines().catch(() => []), pc.lastRuns().catch(() => new Map())]) : undefined;
    const [live, past] = await Promise.all([pc.liveRuns(), withPast ? pc.recentRuns(30) : Promise.resolve([])]);
    const view = await agentsView({ live, past, runner: shared.runner, agents: ctx.agents, resolve: (id) => runContext(id, ctx.prefix) });
    // Runner jobs report only their identifier; the Crew view names the task.
    if (!rosterParts) return view;
    await titled([...view.sessions, ...view.finished].flatMap((x) => x.tasks));
    const [routines, last] = await rosterParts;
    return { ...view, roster: roster(ctx.agents, routines, last) };
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
      await pc.addComment(existing.id, text);
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

  /**
   * Paperclip wakes a task's agent on the owner's comment, except while the task carries a recovery hold: then the wake
   * is parked until the hold clears, and some never do (a run it cancels before starting leaves no stop record, so every
   * later message waits forever). A held task's agent is woken without the task (a task-scoped wake is parked too); it
   * finds the message among its open tasks.
   */
  async function wakeIfHeld(issueId: string, commentId: string) {
    const now = await pc.issue(issueId).catch(() => undefined);
    if (!now?.assigneeAgentId || !now.executionBlocker) return;
    const reason = `The owner wrote on ${now.identifier}, and Paperclip is holding that task's own wake (${now.executionBlocker.cause}). Read the newest comments on ${now.identifier} and reply there.`;
    await pc.wakeAgent(now.assigneeAgentId, reason, `board-held-comment:${commentId}`).then(
      () => log.warn({ issue: now.identifier, cause: now.executionBlocker!.cause }, "task wake held by Paperclip; woke its agent directly"),
      (err) => log.warn({ issue: now.identifier, err: String(err) }, "couldn't wake the agent of a held task"),
    );
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
    const [comments, busy, files, parent, kids, names, past] = await Promise.all([
      pc.comments(issue.id),
      working(ctx),
      pc.attachments(issue.id).catch(() => []),
      issue.parentId ? pc.issueSummary(issue.parentId).catch(() => undefined) : undefined,
      // The crew works in sub-tasks of the user's task.
      issue.assigneeUserId === ctx.me ? pc.children(issue.id).catch(() => []) : Promise.resolve([] as Issue[]),
      bylines(),
      pc.recentRuns(100).catch(() => []),
    ]);
    const crew = crewOf(issue, kids, { assignees: ctx.assignees, seen: (id) => store.seenAt(id), working: busy.map, jobs: latestJobs(shared.runner) });
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
    const placement = store.placements().get(issue.id);
    const rec = store.recurring(issue.id);
    return {
      ...toCard(issue, ctx.assignees, new Date().toISOString()),
      ...byOf(names, issue.id),
      description: displayText(issue.description),
      bucket: placement?.bucket ?? null,
      editable: assigned,
      settled: store.settledAt().has(issue.id),
      labelIds: issue.labelIds ?? (issue.labels ?? []).map((l) => l.id),
      executor: executorOf(issue, ctx.assignees),
      replyTarget: replyTarget(issue, ctx.assignees),
      scheduled: store.schedules().get(issue.id) ?? null,
      recurring: rec ? recurringView(rec, opts.timezone) : null,
      working: busy.map.get(issue.identifier) ?? null,
      comments: comments.map((c) => ({ ...commentView(c, ctx.me, ctx.agents), ...byOf(names, c.id) })),
      files: fileViews(files, ctx.me),
      // An agent's sub-task links back to the task it works on.
      parent: parent ? { identifier: parent.identifier, title: parent.title } : null,
      crew: crew.map((m) => ({ ...m, said: said[m.agent] ?? null })),
      runs: runLinks(past, issue.id, ctx.agents),
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
    const chatEngineer = ctx.agents.find((a) => a.id === chatAgent(full) && a.metadata?.runnerEngine);
    const messages = conversation(full, comments ?? (await pc.comments(issue.id)), ctx.me, name, isChat(issue, ctx), chatEngineer?.name);
    conversations.set(issue.id, { stamp, messages });
    return messages;
  }

  /**
   * One chat, as the conversation view shows it: messages, the live run, files, approvals, and the work handed out from it.
   * `peek` (a prefetch from a hovered row) leaves it unread.
   */
  async function chatView(ref: string, peek = false) {
    const { ctx, issue } = await editableIssue(ref, "this chat isn't yours");
    const [comments, files, busy, live, runs, kids, parent, names] = await Promise.all([
      pc.comments(issue.id),
      pc.attachments(issue.id).catch(() => []),
      working(ctx),
      pc.liveRuns(),
      pc.recentRuns(100),
      pc.children(issue.id).catch(() => [] as Issue[]),
      issue.parentId ? pc.issueSummary(issue.parentId).catch(() => undefined) : undefined,
      bylines(),
    ]);
    // Questions an agent this chat handed work to is asking the owner: shown here, answered on that agent's task.
    const [messages, asks] = await Promise.all([chatMessages(issue, ctx, comments), askingKids(issue, kids, ctx.me)]);
    const awaiting = await records.awaiting();
    const lastRun = (id: string) => runs.find((r) => r.issueId === id && r.finishedAt);
    const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
    const base = shownState(chatState(issue, live, lastRun(issue.id), ctx.me, awaiting), messages, lastRun(issue.id));
    const state = base.state === "idle" && asks.length ? { state: "waiting for you" as const } : base;
    const ids = new Set([issue.id, ...kids.map((k) => k.id)]);
    const agent = agentOf(chatAgent(issue));
    if (!peek) store.markSeen(issue.id);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      open: !["done", "cancelled"].includes(issue.status),
      agent: agent ? { key: agent.id, name: agent.name } : { key: "", name: "You" },
      ...state,
      // The owner's side of the chat: an admin other than the owner wrote it gets their name on it (the opening is the task's).
      messages: messages.map((m) => (m.kind === "owner" ? { ...m, ...byOf(names, m.id === `${issue.id}:opening` ? issue.id : m.id) } : m)),
      working: await withSession(busy.map.get(issue.identifier), live, issue.id, true),
      files: fileViews(files, ctx.me),
      approvals: (await cardsOf("recent", { limit: 50 })).filter((a) => ids.has(a.issueId)).map((a) => shownApproval(names, a)),
      // Work handed out from this chat (Aiden's delegations are children of the chat).
      handedOut: await Promise.all(
        kids
          .filter((k) => k.status !== "cancelled")
          .map(async (k) => {
            const st = chatState(k, live, lastRun(k.id), ctx.me, awaiting);
            // An agent's question to the owner (askingKids) makes the task wait on him, whatever else it is doing.
            const asking = (st.state === "idle" || st.state === "in review") && asks.some((a) => a.task.id === k.id);
            return { identifier: k.identifier, title: k.title, agent: agentOf(k.assigneeAgentId)?.name ?? "You", ...(asking ? { state: "waiting for you" as const } : st), updatedAt: k.lastActivityAt ?? k.updatedAt, working: await withSession(busy.map.get(k.identifier), live, k.id, false) };
          }),
      ),
      parent: parent ? { identifier: parent.identifier, title: parent.title } : null,
      runs: runLinks(runs, issue.id, ctx.agents),
      asks: asks.map(({ task, ask }) => ({ ...ask, identifier: task.identifier, agent: agentOf(task.assigneeAgentId)?.name ?? "Agent" })),
    };
  }

  /**
   * The open tasks handed out from a chat whose agent is waiting on the owner's answer (openAsk). Only work the chat's own
   * agent or the owner put under it counts: another agent can't hang a task under his chat to collect his words.
   */
  /** A sub-task of the chat that its own agent or the owner created. */
  const asks = new Map<string, { stamp: string; ask: ReturnType<typeof openAsk> }>();
  const handedOutBy = (chat: Issue, k: Issue, me: string) =>
    k.parentId === chat.id && (k.createdByAgentId ? k.createdByAgentId === chatAgent(chat) : k.createdByUserId === me);

  async function askingKids(chat: Issue, kids: Issue[], me: string) {
    const open = kids.filter((k) => k.assigneeAgentId && !["done", "cancelled"].includes(k.status) && handedOutBy(chat, k, me));
    // A task's comments are read again only when it has changed (every open chat refresh asks).
    const askOf = async (task: Issue) => {
      const stamp = `${task.lastActivityAt ?? task.updatedAt}|${task.assigneeAgentId}`;
      const hit = asks.get(task.id);
      if (hit?.stamp === stamp) return hit.ask;
      const comments = await pc.comments(task.id).catch(() => undefined);
      const ask = openAsk(comments ?? [], task.assigneeAgentId, me);
      if (comments) asks.set(task.id, { stamp, ask });
      return ask;
    };
    const found = await Promise.all(open.map(async (task) => ({ task, ask: await askOf(task) })));
    return found.filter((x): x is { task: Issue; ask: NonNullable<typeof x.ask> } => Boolean(x.ask));
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
    const [live, runs, busy, names] = await Promise.all([pc.liveRuns(), pc.recentRuns(100), working(ctx), bylines()]);
    const awaiting = await records.awaiting();
    const usage = store.usageByIssue(all.flatMap((i) => [i.id, i.identifier]));
    const pending = await cardsOf("pending");
    const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
    const row = async (k: Issue, children: LineageRow[]): Promise<LineageRow & { approvals: ReturnType<typeof shownApproval>[] }> => {
      const st = chatState(k, live, runs.find((r) => r.issueId === k.id && r.finishedAt), ctx.me, awaiting);
      const w = busy.map.get(k.identifier);
      const c = w?.said ? undefined : await pc.latestComment(k.id).catch(() => undefined);
      const u = usage.get(k.id) ?? usage.get(k.identifier);
      return {
        identifier: k.identifier,
        title: k.title,
        agent: agentOf(k.assigneeAgentId)?.name ?? "You",
        model: modelOf(k, agentOf(k.assigneeAgentId)),
        status: lineageStatus(st.state, k),
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
    const [live, runs, kids] = await Promise.all([pc.liveRuns(), pc.recentRuns(100), pc.children(issue.id).catch(() => [] as Issue[])]);
    const chat = isChat(issue, ctx);
    const awaiting = await records.awaiting();
    const stateOf = (i: Issue) => chatState(i, live, runs.find((r) => r.issueId === i.id && r.finishedAt), ctx.me, awaiting).state;
    if (!settleable(stateOf(issue), issue, chat)) throw new HttpError(409, chat ? "this chat isn't finished: its agent is working or waiting on you" : "only a finished task can be settled");
    if (kids.some((k) => holdsActive(stateOf(k)))) throw new HttpError(409, "work handed out from here is still running or waiting on you");
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
    const model = String(front?.adapterConfig?.model ?? "~deepseek/deepseek-flash-latest").replace(/^openrouter\//, "");
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

  /** Attach a file to a task; a PDF also gets its text as `<name>.txt`, for the agents. */
  async function attach(ref: string, body: unknown) {
    const { issue } = await editableIssue(ref);
    const input = parse(UploadSchema, body);
    const data = decode(input.data);
    if (typeof data === "string") throw new BadRequest(data);
    const name = safeName(input.name);
    const type = fileType(input.type, name);
    await pc.addAttachment(issue.id, name, type, data);
    log.info({ issue: issue.identifier, type, bytes: data.length }, "file attached");
    if (isPdf(type, name)) {
      const text = await pdfText(data);
      if (!text) {
        // Nothing ends silently: the person hears the file can't be read, instead of the agent skipping it.
        log.warn({ issue: issue.identifier }, "no text in an attached PDF");
        await pc.addComment(issue.id, `I couldn't read ${name} (it looks scanned or protected). Send it as a picture or another format.\n\n${NOTICE_MARKER}`);
        return { ...(await issueView(issue.id)), readable: false };
      } else
        await pc
          .addAttachment(issue.id, `${name}.txt`, "text/plain", Buffer.from(text, "utf8"))
          .catch((err) => log.warn({ err: String(err.message ?? err).slice(0, 300), issue: issue.identifier }, "couldn't attach a PDF's text"));
    }
    return issueView(issue.id);
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
      const names = engineers.map((k) => ctx.assignees.find((a) => a.key === k.assigneeAgentId)).map((a) => a?.persona?.name ?? a?.name ?? "an Engineer");
      throw new HttpError(409, `${source.identifier} has ${[...new Set(names)].join(" and ")}'s work on it, which can't move: merge ${target.identifier} into it instead, or dismiss the Engineer first`);
    }
    // Lists truncate descriptions; these come from single reads, so they're whole.
    const files = await pc.attachments(source.id).catch(() => []);
    for (const f of files) await pc.addAttachment(target.id, f.originalFilename ?? "file", f.contentType, await pc.attachmentContent(f.id));
    await pc.updateIssue(target.id, { description: mergedDescription(target, source) });
    for (const k of kids) if (k.assigneeUserId === ctx.me && !k.assigneeAgentId) await pc.updateIssue(k.id, { parentId: target.id });
    // The crew's parts close with the task, except one an agent is busy with (the board closes it later).
    const busy = (await working(ctx)).map;
    for (const k of kids) if (kind(k) && !closed(k) && !busy.has(k.identifier)) await pc.updateIssue(k.id, { status: "cancelled" });
    store.unschedule(source.id);
    // Cancelled first: a comment on a closed task wakes nobody, and the runner's marker keeps it from the Researcher.
    await pc.updateIssue(source.id, { status: "cancelled" });
    await pc.addComment(source.id, `Merged into ${target.identifier}.\n\n${RUNNER_MARKER}`);
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
    const recurring = await changeRecurring(pc, store, ctx, issue, parse(RecurringSchema, body), opts.timezone, log);
    return { identifier: issue.identifier, recurring };
  }

  // The tasks bridge (agents' tools, with the agent's own credential) and the runner (its key), behind the internal token.
  const internal: typeof routes = [
    // Fleet tools of the Chief of Staff: the kernel's caller assertion names the caller, who must be the CoS.
    // The status read also takes fleet-read (Fleet Ops), with the detector's open and recovered incidents.
    { method: "POST", path: /^\/internal\/fleet\/status$/, handle: async (_m, body, _u, req) => fleetCall(req, async (pc) => {
      // The summary is extra: a failed read there never fails fleet_status (summary: null). After the status reads, not beside
      // them (Paperclip limits concurrent list requests per client).
      const window = (body as { window?: string } | null)?.window === "7d" ? "7d" : "24h";
      const status = await fleetStatus(pc, records);
      const summary = await statusSummary(pc, store, records, grading, window).catch((err) => (log.warn({ err: String(err) }, "fleet summary failed"), null));
      // `detector` first and a bounded reply: the lists are what get long, and a cut-off payload leaves its open and
      // recovered keys (the block Fleet Ops acts on) unreadable.
      return boundedFleetStatus({ detector: detectorState(store), ...status, summary });
    }, ["fleet-admin", "fleet-read"]) },
    // The Agent Coach's reads (coach.ts), for the fleet-audit role: who is due a review (never the caller) and one agent's bounded evidence.
    { method: "POST", path: /^\/internal\/coach\/due$/, handle: async (_m, _b, _u, req) => fleetCall(req, (pc, caller) => coachDue(pc, store, caller), ["fleet-audit"]) },
    { method: "POST", path: /^\/internal\/coach\/evidence$/, handle: async (_m, body, _u, req) => fleetCall(req, (pc, caller) => coachEvidence(pc, store, records, grading, runOf, parse(z.object({ agent_key: z.string().trim().min(1).max(64) }).strict(), body).agent_key, caller), ["fleet-audit"]) },
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
          // relayed words there as go-aheads): handed out by the chat's own agent or the owner, and written after it asked.
          const asking = await askingKids(source.chat, await pc.children(source.chat.id), ctx.me);
          const ask = agent.kind === "engineer" ? undefined : asking.find((x) => x.task.id === dest.id)?.ask;
          if (ask && source.comment.createdAt <= ask.at) throw new Refused("refused: that message was written before the agent asked; ask the owner again");
          if (!ask && !["engineer", "assistant"].includes(agent.kind)) throw new Refused("refused: target must be an engineer's task, or a task handed out from this chat whose agent is asking the owner");
          // One set of tasks that could take the owner's words: whenever more than one could, the words must name the target.
          const inReview = (await pc.openIssues()).filter((i) => i.status === "in_review" && ctx.assignees.some((a) => a.key === i.assigneeAgentId && a.kind === "engineer")).map((i) => i.identifier);
          const waiting = [...new Set([...inReview, ...asking.filter((x) => ctx.assignees.find((a) => a.key === x.task.assigneeAgentId)?.kind !== "engineer").map((x) => x.task.identifier)])];
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
          await wakeIfHeld(dest.id, posted.id);
          log.info({ chat: source.chat.identifier, task: dest.identifier }, "chat message relayed");
          return { relayed: true, task: dest.identifier, to: agent.persona?.name ?? agent.name, comment_id: posted.id };
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
      // Where a message to a task the board moved to a successor goes (rollover.ts): read-only, from the board's own record.
      // Only the kernel asks, before it delivers a channel's message to the owner's chat.
      method: "GET",
      path: /^\/internal\/successor\/([A-Za-z0-9_-]+)$/,
      handle: async (m, _b, _u, req) => {
        if (!kernelKeyed(req)) throw new HttpError(403, "only the kernel asks where a chat continues");
        return { id: successorOf(store, m[1]!) ?? null };
      },
    },
    {
      // Every card on one task, any state, read from the kernel's records (an agent's task_approvals through the tasks bridge; no args).
      method: "GET",
      path: /^\/internal\/approvals$/,
      handle: async (_m, _b, url, req) => {
        const issue = url.searchParams.get("issue");
        if (!issue) throw new HttpError(400, "issue=<task>");
        await requireAgentTool(req, "task_approvals");
        const task = await pc.issue(issue).then((i) => i.id, () => undefined);
        return { approvals: task ? (await cardsOf("recent", { task, limit: 50 })).map(approvalView) : [] };
      },
    },
    {
      // An app deliverable's evidence for the runner's grader: apps-mcp's status of that app (deployed SHA, health, incident).
      method: "GET",
      path: /^\/internal\/grades\/app\/([a-z0-9-]{1,63})$/,
      handle: async (m, _b, _u, req) => {
        requireRunner(req, "reads app evidence");
        const apps = await appsApi<{ name: string }[]>("/internal/status");
        return { app: apps.find((a) => a.name === m[1]) ?? null };
      },
    },
    {
      // A pr deliverable on an app's repo: that app's status too, so the grader can check "deployed at the merged commit".
      method: "GET",
      path: /^\/internal\/grades\/app-of\/([\w.-]+\/[\w.-]+)$/,
      handle: async (m, _b, _u, req) => {
        requireRunner(req, "reads app evidence");
        const apps = await appsApi<{ name: string; repo?: string }[]>("/internal/status");
        const same = apps.filter((a) => a.repo?.toLowerCase() === decodeURIComponent(m[1]!).toLowerCase());
        return { app: same.length === 1 ? same[0]! : null }; // several apps in one repo: no single app to vouch for the PR
      },
    },
    {
      // Every deploy of one exact commit over the app's whole deploy table, for the grader's "deployed at the merged commit":
      // the status row's list is bounded, so a commit it has moved past is looked up here instead of read as undeployed.
      method: "GET",
      path: /^\/internal\/grades\/deploys\/([a-z0-9-]{1,63})\/([0-9a-f]{40})$/,
      handle: async (m, _b, _u, req) => {
        requireRunner(req, "reads app deploy history");
        return appsApi<{ deploys?: unknown[] }>(`/internal/deploys/${m[1]}/${m[2]}`, undefined, { auth: true }).then((r) => ({ deploys: r.deploys ?? [] }));
      },
    },
    {
      // The grader's live view of one page of a deployed app (apps-mcp graderView): rendered text plus the running commit
      // before and after. A POST for the long timeout: one render can take up to 45 s.
      method: "POST",
      path: /^\/internal\/grades\/view$/,
      handle: async (_m, body, _u, req) => {
        requireRunner(req, "captures live app views");
        const v = parse(z.object({ name: z.string().regex(/^[a-z0-9-]{1,63}$/), path: z.string().max(500) }).strict(), body);
        return appsApi("/internal/view", v, { timeoutMs: 55_000 });
      },
    },
    {
      // The owner's one-line notices (critical monitoring alerts, a paused routine, Fleet Ops unreachable), each handed over
      // once (to a channel, through the kernel). Escalated grades are not here: they go to the task's delegator (wake.ts).
      method: "GET",
      path: /^\/internal\/owner\/grades$/,
      handle: async (_m, _b, _u, req) => {
        if (!kernelKeyed(req)) throw new HttpError(403, "only the kernel collects owner notices");
        return { lines: takeOwnerLines(store) };
      },
    },
    {
      // ops/setup.sh's welcome chat (operator key): a new chat, written as the owner.
      method: "POST",
      path: /^\/internal\/owner\/welcome$/,
      handle: async (m, body, u, req) => {
        requireOperator(req, "posts the welcome chat");
        const chats = routes.find((r) => r.method === "POST" && r.path.test("/api/chats"))!;
        return perRequest.run({ session: OPERATOR }, () => chats.handle(m, body, u, req));
      },
    },
    // Board changes are the Researcher's (board-writer), through the tasks bridge with its own credential.
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/schedule$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_schedule", "board-writer"), await refuseMemoryInbox(decodeURIComponent(m[1]!)), schedule(decodeURIComponent(m[1]!), body)) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/recurring$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_recurring", "board-writer"), await refuseMemoryInbox(decodeURIComponent(m[1]!)), recurringChange(decodeURIComponent(m[1]!), body)) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/merge$/, handle: async (m, body, _u, req) => (await requireAgentTool(req, "task_merge", "board-writer"), await refuseMemoryInbox(decodeURIComponent(m[1]!), parse(MergeSchema, body).into), merge(decodeURIComponent(m[1]!), body)) },
    {
      method: "POST",
      path: /^\/internal\/recurring\/claim$/,
      handle: async (_m, _b, _u, req) => {
        requireRunner(req, "claims recurring runs");
        const ctx = await context();
        // Each run is created by the client of the account that set the task recurring (null: the owner).
        return { runs: await claimDue(pc, store, ctx, opts.timezone, log) };
      },
    },
    {
      method: "POST",
      path: /^\/internal\/recurring\/runs\/([0-9a-f-]{36})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/,
      handle: async (m, body, _u, req) => {
        requireRunner(req, "reports recurring runs");
        const { state } = parse(RunStateSchema, body);
        if (!store.setRunState(m[1]!, m[2]!, state)) throw new HttpError(404, "no such run");
        log.info({ definition: m[1], occurrence: m[2], state }, "recurring run updated");
        return { ok: true };
      },
    },
    {
      // An agent passes one of the user's messages on to another agent on the same task. Only the
      // user's own comment travels, word for word: the agent picks which one and for whom, never the words.
      method: "POST",
      path: /^\/internal\/issues\/([^/]+)\/pass$/,
      // The runner (an Engineer's `aidenhq pass`) or the Researcher through the tasks bridge.
      handle: async (m, body, _u, req) => {
        if (!runnerKeyed(req)) await requireAgentTool(req, "task_pass_on", "board-writer");
        await refuseMemoryInbox(decodeURIComponent(m[1]!));
        const { comment, to, by } = parse(PassSchema, body);
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        const task = await userTaskOf(issue, ctx);
        if (!task) throw new HttpError(400, "only on the user's tasks and their agents' parts");
        const c = (await pc.comments(issue.id)).find((x) => x.id === comment && !x.deletedAt);
        if (!c || c.authorType !== "user" || c.authorUserId !== ctx.me || hasMarker(c.body, RUNNER_MARKER)) throw new HttpError(400, "pass on a comment the user wrote on this task");
        const named = ctx.assignees.find((a) => a.kind !== "me" && a.key === to);
        const byName = withHandle(ctx.assignees, to);
        const agent = named ?? (byName.length === 1 ? byName[0] : undefined);
        if (!agent) throw new HttpError(400, `${byName.length > 1 ? "more than one agent answers to" : "no agent is called"} ${to}: ${ctx.assignees.flatMap((a) => (a.kind === "me" ? [] : [a.persona?.name ?? a.name])).join(", ")}`);
        // An agent may pass only to the Researcher, an Engineer, or an agent already on this task; never the Chief of Staff.
        const chief = holdsRole(agent.key, "fleet-admin");
        const onTask = (await pc.children(task.id)).some((k) => k.assigneeAgentId === agent.key);
        if (chief || (agent.kind === "agent" && !onTask)) throw new HttpError(403, `${agent.persona?.name ?? agent.name} can't be passed to from here`);
        if (agent.key === issue.assigneeAgentId) throw new HttpError(400, `this is ${agent.persona?.name ?? agent.name}'s own chat`);
        const key = `passed:${c.id}:${agent.key}`;
        if (store.meta(key)) return { passed: false, reason: `already passed on to ${agent.persona?.name ?? agent.name}` };
        // A message already delivered here keeps pointing at the chat it was written in.
        const origin = deliveredFrom(c.body) ?? { identifier: issue.identifier, commentId: c.id };
        const sender = by ? withHandle(ctx.assignees, by)[0] : undefined;
        const part = await deliver(ctx, task, agent, displayText(c.body).replace(/\n\n_(Written in|Passed on by) [^\n]*_$/, ""), { ...origin, note: `Passed on by ${(sender?.persona?.name ?? sender?.name) ?? "an agent"} from ${issue.identifier}.` });
        store.setMeta(key, new Date().toISOString());
        return { passed: true, to: agent.persona?.name ?? agent.name, part: part.identifier };
      },
    },
    {
      // Model usage Paperclip doesn't see (the runner's Engineer jobs and AI reviewer): one record per job or call, deduped by key.
      method: "POST",
      path: /^\/internal\/usage$/,
      handle: async (_m, body, _u, req) => {
        // Only the runner (its reviewer key; agents reach the internal token, never this key), stamped with the board's time.
        requireRunner(req, "reports usage");
        const u = parse(UsageSchema, body);
        store.addUsage({ ...u, at: new Date().toISOString() });
        return { ok: true };
      },
    },
    {
      // The loop brake (brake.ts): the runner or an agent reports a comment it posted; past its daily limit the wake is cancelled.
      method: "POST",
      path: /^\/internal\/wake-check$/,
      handle: async (_m, body, _u, req) => {
        const b = parse(z.object({ issue: z.string().min(1).max(100), comment: z.string().min(1).max(100) }), body);
        let caller = "runner";
        if (!runnerKeyed(req)) {
          const me = await requireAgent(pc, req, () => true, "only the runner or an agent reports its comments here").catch((err) => {
            throw err instanceof Refused ? new HttpError(403, err.message) : err;
          });
          caller = me.id;
        }
        return wakeCheck(pc, store, b.issue, b.comment, caller, opts.log).catch((err: Error) => {
          throw /not your comment/.test(err.message) ? new HttpError(403, err.message) : err;
        });
      },
    },
    {
      // The runner's Engineer jobs: running, queued and recently finished (kept in memory only).
      method: "POST",
      path: /^\/internal\/runner\/activity$/,
      handle: async (_m, body, _u, req) => {
        requireRunner(req, "reports its jobs");
        shared.runner = { ...parse(RunnerReportSchema, body), at: new Date().toISOString() };
        return { ok: true };
      },
    },
  ];

  // Where OAuth sign-ins must start: the loopback board, reached from a laptop through an SSH tunnel (docs/setup.md).
  const TUNNEL = "http://127.0.0.1:3121 through ssh -N -L 3121:127.0.0.1:3121 <you>@<host> from your laptop";
  const googleViaBoard = mode === "lan" && !!opts.lan?.googleConnect && !!opts.lan.url.startsWith("https://");

  // ------------------------------------------------------------------ Settings (settings.ts)

  const settingsFiles = () => ({ compiled: process.env.BOARD_PAPERCLIP_CONFIG ?? "/config/paperclip.yaml", catalog: process.env.BOARD_MODULES_FILE ?? "/config/modules.json", grants: process.env.AIDENHQ_GRANTS_FILE });

  async function settingsData() {
    const pending = await records.list("owner");
    return settingsView({
      ...readSources(settingsFiles()),
      autopause: process.env.FLEET_OPS_AUTOPAUSE || undefined,
      boardTimezone: opts.timezone,
      pendingRaises: pending.filter((a) => a.action === "raise_cap").length,
      pendingApprovals: pending.length,
    });
  }

  // Each HTTP connection's /healthz, asked at most every 20 s (the page polls); when it last answered ok, since the board started.
  let probed: { at: number; probes: Record<string, Probe> } | null = null;
  const lastOk = new Map<string, string>();
  async function connectionsData(fresh: boolean) {
    const { compiled, catalog } = readSources(settingsFiles());
    if (fresh || !probed || Date.now() - probed.at > 20_000) {
      const targets = Object.entries(compiled?.mcp_servers ?? {}).filter(([, c]) => c.url);
      const results = await Promise.all(targets.map(async ([n, c]) => [n, await probe(c.url!)] as const));
      for (const [n, p] of results) if (p.ok) lastOk.set(n, p.checkedAt);
      probed = { at: Date.now(), probes: Object.fromEntries(results.map(([n, p]) => [n, { ...p, ...(lastOk.has(n) ? { lastOkAt: lastOk.get(n) } : {}) }])) };
    }
    const [google, states, sources] = await Promise.all([
      opts.google?.status(),
      signInStates(),
      appsApi<{ sources?: { source: string; last_ok: string | null; failing: boolean }[] }>("/internal/sources", undefined, { auth: true, timeoutMs: 5000 }).then(
        (r) => r.sources ?? [],
        () => null,
      ),
    ]);
    const signIns = Object.fromEntries(states.map((s) => [s.id, s.status]));
    return connectionsView({ compiled, catalog, probes: probed.probes, signIns, google, sources, staleSources: new Set(staleSources(sources ?? [], Date.now()).map((s) => s.key)) });
  }

  /** Each module sign-in's state (McpAuth caches it for a minute); undefined where the proxy can't be asked. */
  const signInStates = () => Promise.all((opts.signIns ?? []).map(async (x) => ({ ...x, status: await x.auth.status() })));

  const routes: { method: string; path: RegExp; maxBody?: number; handle: (m: RegExpMatchArray, body: unknown, url: URL, req: IncomingMessage) => Promise<unknown> }[] = [
    {
      method: "GET",
      path: /^\/api\/board$/,
      handle: async () => {
        const ctx = await context();
        const since = new Date(Date.now() - RECENT_MS).toISOString();
        // Who is working and the connections' states don't depend on the tasks: started with them, not after.
        const extras = Promise.all([working(ctx), opts.google?.status(), signInStates(), bylines()]);
        extras.catch(() => {}); // awaited below; this only keeps a failure there from going unhandled meanwhile
        const settledAt = store.settledAt();
        // A settled task stays off the board until something happens on it.
        const unsettled = (i: Issue) => {
          if (!settledAt.has(i.id)) return true;
          if (stillSettled(settledAt.get(i.id), i, "done")) return false;
          store.unsettle(i.id);
          return true;
        };
        const [all, closed] = await Promise.all([pc.openIssues().then((l) => mine(l, ctx)), pc.closedSince(since).then((l) => mine(l, ctx).filter(unsettled))]);
        const open = await closeLeftoverParts(all, closed, ctx);
        // Agents' sub-tasks are part of their parent's card: they never get a place of their own.
        const folded = foldedChildren([...open, ...closed], ctx.assignees);
        store.placeNew(open.filter((i) => !folded.has(i.id)).map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status })));
        const recurring = new Map([...store.allRecurring()].map(([id, r]) => [id, { summary: recurringView(r, opts.timezone).summary, nextRun: r.nextRun, paused: r.paused }]));
        const [busy, google, signIns, names] = await extras;
        const board = buildBoard({ open, closed, placements: store.placements(), seen: store.allSeen(), schedules: store.schedules(), recurring, installedAt: store.meta("installed_at")!, assignees: ctx.assignees, crew: { working: busy.map, jobs: latestJobs(shared.runner) } });
        for (const card of [...Object.values(board.buckets).flat(), ...board.recurring]) {
          const w = busy.map.get(card.identifier);
          if (w) card.working = w;
          Object.assign(card, byOf(names, card.id));
        }
        // Lists truncate long descriptions; the brief is read in full.
        const brief = open.find((i) => i.id === board.brief?.id);
        if (board.brief && brief?.descriptionTruncated) board.brief.description = displayText((await pc.issue(brief.id)).description);
        // When Tomorrow next rolls into Today: the next calendar day, except before days off.
        const today = localDate(opts.timezone);
        const rollsOn = nextWorkday(today, opts.workdays ?? WORKWEEK);
        return { ...board, assignees: ctx.assignees, labels: ctx.labels, prefix: ctx.prefix, timezone: opts.timezone, slackTeams: opts.slackTeams ?? {}, rollsOn, rollsTomorrow: rollsOn === addDays(today, 1), buckets: board.buckets, agentsActive: busy.active, google: google ?? null, signIns: signIns.map(({ id, label, missing, stopped, status }) => ({ id, label, missing, stopped, status: status ?? null })) };
      },
    },
    { method: "GET", path: /^\/api\/issues\/([^/]+)$/, handle: async (m) => issueView(decodeURIComponent(m[1]!)) },
    { method: "GET", path: /^\/api\/runs\/([0-9a-f-]{36})$/, handle: async (m) => runView(m[1]!) },
    { method: "GET", path: /^\/api\/chats\/([^/]+)$/, handle: async (m, _b, url) => chatView(decodeURIComponent(m[1]!), url.searchParams.has("peek")) },
    { method: "GET", path: /^\/api\/agents$/, handle: async () => activity(await context(), true) },
    // The Agents page's first paint: who is in the fleet, where each sits and its schedules (no run history; /api/agents
    // brings that, with each agent's last run, after).
    { method: "GET", path: /^\/api\/agents\/roster$/, handle: async () => {
        const [agents, routines] = await Promise.all([pc.agents(), pc.routines().catch(() => [])]);
        return { roster: roster(agents, routines, new Map()) };
      },
    },
    { method: "GET", path: /^\/api\/agents\/([0-9a-f-]{36})\/scorecard$/, handle: async (m) => scorecard(await gatherFacts(pc, store, records, grading), m[1]!) },
    {
      // Chats: open ones first, then the 20 newest finished ones; each with its agent and state.
      method: "GET",
      path: /^\/api\/chats$/,
      handle: async () => {
        const ctx = await context();
        const label = await labelNamed(ctx, "chat", "#0ea5e9");
        // Every open task too (for the work handed out from open chats), in the same round trip rather than after.
        const [open, closed, live, runs, openTasks] = await Promise.all([pc.labelled(label.id, OPEN), pc.labelled(label.id, "done,cancelled", "20"), pc.liveRuns(), pc.recentRuns(100), pc.openIssues()]);
        const newest = (a: Issue, b: Issue) => (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt);
        const all = [...open.sort(newest), ...closed.sort(newest)];
        const awaiting = await records.awaiting();
        const lastRun = (id: string) => runs.find((r) => r.issueId === id && r.finishedAt);
        const agentOf = (id: string | null | undefined) => ctx.agents.find((a) => a.id === id);
        const row = (i: Issue, agent: ReturnType<typeof agentOf>) => ({
          identifier: i.identifier,
          title: i.title,
          open: !["done", "cancelled"].includes(i.status),
          agent: agent ? { key: agent.id, name: agent.name } : { key: "", name: "You" },
          ...chatState(i, live, lastRun(i.id), ctx.me, awaiting),
          updatedAt: i.lastActivityAt ?? i.updatedAt,
        });
        const settledAt = store.settledAt();
        const chats = await Promise.all(
          all.map(async (i) => {
            const messages = await chatMessages(i, ctx).catch(() => [] as Message[]);
            const r = row(i, agentOf(chatAgent(i)));
            const shown = shownState({ state: r.state, ...(r.reason ? { reason: r.reason } : {}) }, messages, lastRun(i.id));
            Object.assign(r, shown);
            const said = lastWord(messages);
            // Settled: out of the active list until something happens on it (then it comes back on its own).
            const settled = stillSettled(settledAt.get(i.id), i, r.state);
            if (!settled && settledAt.has(i.id)) store.unsettle(i.id);
            // Unread: the agent spoke after the owner last opened the chat.
            return { ...r, ...(said ? { preview: said } : {}), unread: said?.from === "agent" && said.at > store.seenAt(i.id), ...(settled ? { settled } : {}) };
          }),
        );
        // Work an agent handed out from an open chat (a child task of it): listed under that chat's agent.
        const chatIds = new Map(open.map((i) => [i.id, i.identifier]));
        const handedOut = chatIds.size
          ? await Promise.all(
              openTasks
                .filter((i) => i.parentId && chatIds.has(i.parentId) && !all.some((c) => c.id === i.id))
                .map(async (i) => {
                  // Same state as its own chat: waiting for you only when it asks the owner something.
                  const r = row(i, agentOf(i.assigneeAgentId));
                  const messages = await chatMessages(i, ctx).catch(() => [] as Message[]);
                  return { ...r, ...shownState({ state: r.state, ...(r.reason ? { reason: r.reason } : {}) }, messages, lastRun(i.id)), from: chatIds.get(i.parentId!)!, unread: false };
                }),
            )
          : [];
        const agents = ctx.agents
          .filter((a) => a.status !== "paused" && a.status !== "terminated")
          .map((a) => ({ key: a.id, name: a.name, front: a.metadata?.setupKey === "aidenhq:chief-of-staff" }));
        // A settled chat whose handed-out work runs or waits on the owner is active again.
        for (const c of chats) {
          if (!c.settled || !handedOut.some((h) => h.from === c.identifier && holdsActive(h.state))) continue;
          delete (c as { settled?: boolean }).settled;
          store.unsettle(all.find((i) => i.identifier === c.identifier)!.id);
        }
        return { chats: [...chats, ...handedOut], agents };
      },
    },
    {
      // Activity: what each agent did, by the owner's local day (finished tasks and failed runs).
      method: "GET",
      path: /^\/api\/activity$/,
      handle: async (_m, _b, url) => {
        const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
        const ctx = await context();
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const [closed, runs] = await Promise.all([pc.closedSince(since), pc.recentRuns(200)]);
        const failed = runs.filter((r) => (r.status === "failed" || r.status === "timed_out") && r.finishedAt && r.finishedAt >= since);
        const titles = new Map<string, { identifier: string; title: string }>();
        for (const id of new Set(failed.map((r) => r.issueId).filter((x): x is string => !!x && !closed.some((c) => c.id === x)))) {
          const i = await pc.issueSummary(id).catch(() => undefined);
          if (i) titles.set(id, { identifier: i.identifier, title: i.title });
        }
        return { days: activityDays(closed.filter((i) => !i.originKind), failed, ctx.agents, opts.timezone, titles) };
      },
    },
    {
      // What needs the owner: chats and tasks waiting for them, waiting for approval, or failed; and the open approval cards.
      method: "GET",
      path: /^\/api\/needs-you$/,
      handle: async () => {
        const ctx = await context();
        const [open, live, runs] = await Promise.all([pc.openIssues(), pc.liveRuns(), pc.recentRuns(100)]);
        const awaiting = await records.awaiting();
        const base = needsYou(open, live, runs, ctx.me, awaiting);
        // Chats also need the owner when their messages say so (a reply asking him, a run that ended without a reply):
        // the same state the chat list and the conversation show.
        const lastRun = (id: string) => runs.find((r) => r.issueId === id && r.finishedAt);
        const chats = open.filter((i) => isChat(i, ctx) && !base.some((b) => b.id === i.id));
        const more = (
          await Promise.all(
            chats.map(async (i) => {
              const base = chatState(i, live, lastRun(i.id), ctx.me, awaiting);
              if (base.state !== "idle" && base.state !== "in review") return undefined;
              const shown = shownState(base, await chatMessages(i, ctx).catch(() => [] as Message[]), lastRun(i.id));
              return shown.state === "idle" || shown.state === "in review" ? undefined : { ...i, ...shown };
            }),
          )
        ).filter((x) => x !== undefined);
        const agentName = (i: Issue) => ctx.agents.find((a) => a.id === (i.assigneeAgentId ?? chatAgent(i)))?.name ?? "You";
        const items = [...base, ...more].map((i) => ({ identifier: i.identifier, title: i.title, agent: agentName(i), state: i.state, ...(i.reason ? { reason: i.reason } : {}) }));
        // approvals: the Tier 2 cards the owner decides in Approvals (its badge); items: everything else that waits on him too.
        return { count: items.length, items, approvals: (await records.list("owner")).length };
      },
    },
    // Approvals: the cards, open ones first, then the newest decided ones with their outcome. Read-only: every card is decided on
    // the kernel's approval page (or in a channel).
    { method: "GET", path: /^\/api\/approvals$/, handle: async () => { const names = await bylines(); return { approvals: (await cardsOf("recent", { limit: 100 })).map((a) => shownApproval(names, a)) }; } },
    {
      // A new chat: with the agent named (body.agent or a leading @name), else Aiden.
      method: "POST",
      path: /^\/api\/chats$/,
      handle: async (_m, body, _u, req) => {
        const ctx = await context();
        const input = parse(z.object({ text: z.string().trim().min(1).max(8000), agent: z.string().max(200).optional() }).strict(), body);
        const crew = ctx.agents;
        const named = input.agent ? crew.find((a) => a.id === input.agent || a.metadata?.setupKey === `aidenhq:${input.agent}` || a.name.toLowerCase() === input.agent!.toLowerCase()) : undefined;
        const { agent, note } = named && named.status !== "paused" ? { agent: named, note: undefined } : pickAgent(input.text, crew);
        // A fast-lane agent answers in the lane, not in a task: the board opens its lane chat (`lane:<key>`).
        const lane = (await laneAgents(opts.lane)).find((l) => l.id === agent.id);
        if (lane) {
          await laneSend(opts.lane, lane.key, input.text, await laneByline(req));
          return { identifier: `lane:${lane.key}` };
        }
        const label = await labelNamed(ctx, "chat", "#0ea5e9");
        const title = input.text.split("\n")[0]!.replace(/^@\S+\s*/, "").slice(0, 80) || "New chat";
        const issue = await pc.createIssue({ title, description: `${note ? `${input.text}\n\n${note}` : input.text}\n\n${chatAgentMarker(agent.id)}`, status: "todo", assigneeAgentId: agent.id, labelIds: [label.id], executionWorkspacePreference: "agent_default", executionWorkspaceSettings: { mode: "agent_default" } });
        log.info({ issue: issue.identifier, agent: agent.name }, "chat started");
        return { identifier: issue.identifier };
      },
    },
    // The fast chat lane's agents and conversations (lane.ts): proxied with the internal token.
    { method: "GET", path: /^\/api\/lane$/, handle: async () => ({ agents: await laneAgents(opts.lane) }) },
    { method: "GET", path: /^\/api\/lane\/([^/]+)\/messages$/, handle: async (m, _b, url) => laneMessages(opts.lane, decodeURIComponent(m[1]!), url.searchParams.get("after") ?? "") },
    {
      method: "POST",
      path: /^\/api\/lane\/([^/]+)\/messages$/,
      handle: async (m, body, _u, req) => {
        const { text } = parse(z.object({ text: z.string().trim().min(1).max(8000) }).strict(), body);
        await laneSend(opts.lane, decodeURIComponent(m[1]!), text, await laneByline(req));
        return { ok: true };
      },
    },
    {
      // Stop: ends the chat's run and clears its queue.
      method: "POST",
      path: /^\/api\/chats\/([^/]+)\/stop$/,
      handle: async (m) => {
        const { issue } = await editableIssue(decodeURIComponent(m[1]!), "this chat isn't yours");
        const runs = (await pc.liveRuns()).filter((r) => r.issueId === issue.id);
        for (const r of runs) await pc.cancelRun(r.id);
        log.info({ issue: issue.identifier, stopped: runs.length }, "chat stopped");
        return { stopped: runs.length };
      },
    },
    {
      // Not right: one line from the person, recorded as a correction; the chat reopens.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/not-right$/,
      handle: async (m, body) => {
        const own = await editableIssue(decodeURIComponent(m[1]!), "this task isn't yours");
        const { ctx } = own;
        const issue = await latest(pc, store, own.issue); // a moved task's correction goes to its successor
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
    // What each agent and system component spent on models (the Costs tab).
    {
      method: "GET",
      path: /^\/api\/costs$/,
      handle: async (_m, _b, url) => {
        const w = url.searchParams.get("window") ?? "7d";
        if (!(WINDOWS as readonly string[]).includes(w)) throw new HttpError(400, `window is one of ${WINDOWS.join(", ")}`);
        return costs(pc, store, w as CostWindow);
      },
    },
    // The Costs tab's ledger views (cost-ledger.ts): aggregates over ?from&to&bucket, and one agent's or model's top runs and tasks.
    {
      method: "GET",
      path: /^\/api\/costs\/ledger$/,
      handle: async (_m, _b, url) => ledgerSummary({ store, agents: () => pc.agents(), key: keyUsage, issue: (id) => pc.issueSummary(id), prices, grantsFile: process.env.AIDENHQ_GRANTS_FILE }, ledgerRange(url.searchParams)),
    },
    {
      method: "GET",
      path: /^\/api\/costs\/top$/,
      handle: async (_m, _b, url) =>
        ledgerTop({ store, agents: () => pc.agents(), issue: (id) => pc.issueSummary(id) }, ledgerRange(url.searchParams), { agentId: url.searchParams.get("agent") ?? undefined, model: url.searchParams.get("model") ?? undefined }),
    },
    // Read-only module catalog (compiled config/modules.json), for Settings > Modules.
    { method: "GET", path: /^\/api\/modules$/, handle: async () => ({ modules: moduleStates(readFileSync(process.env.BOARD_MODULES_FILE ?? "/config/modules.json", "utf8")), advisories: await records.advisories().catch(() => []) }) },
    // Settings (web/src/Settings.tsx): the compiled config, read-only, with what the board can see live. Edits go through git.
    { method: "GET", path: /^\/api\/settings$/, handle: async () => settingsData() },
    { method: "GET", path: /^\/api\/settings\/connections$/, handle: async (_m, _b, url) => connectionsData(url.searchParams.has("fresh")) },
    {
      // A settings change (a connection's URL, a switch, an agent's model, effort or heartbeat): checked here, then filed as
      // the owner's task for the Platform Engineer, whose commit becomes the tiered apply card (docs/design/settings-changes.md).
      method: "POST",
      path: /^\/api\/settings\/change$/,
      handle: async (_m, body) => {
        const { changes } = parse(ChangesSchema, body);
        const { compiled, catalog } = readSources(settingsFiles());
        try {
          for (const ch of changes) checkChange(ch, compiled, catalog);
        } catch (e) {
          if (e instanceof ChangeRefused) throw new HttpError(400, e.message);
          throw e;
        }
        const ctx = await context();
        const engineer = ctx.agents.find((a) => holdsRole(a.id, "platform-engineer") && a.status !== "terminated");
        if (!engineer) throw new HttpError(409, "there is no Platform Engineer to make the change");
        const label = await labelNamed(ctx, SETTINGS_LABEL, "#7048e8");
        const { title, description } = taskFor(changes, compiled, catalog.filter((m) => m.chosen).map((m) => m.name));
        const issue = await pc.createIssue({ title, description, status: "todo", priority: "medium", assigneeAgentId: engineer.id, labelIds: [label.id] });
        log.info({ issue: issue.identifier, changes: changes.map((c) => (c.kind === "setting" ? c.key : c.kind === "module" ? `module ${c.name}` : c.kind === "caps" ? `${c.agent}.caps` : `${c.agent}.${c.field}`)) }, "settings change filed");
        return { identifier: issue.identifier };
      },
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
              const items = changesOf(i.description);
              return items ? [{ identifier: i.identifier, title: i.title, createdAt: i.createdAt, items, ...stageOf(i.status, await records.list("recent", { task: i.identifier, limit: 50 })) }] : [];
            }),
          )
        ).flat();
        return { changes: changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
      },
    },
    // Read-only view of the apps platform (apps-mcp's status), for the Apps tab.
    { method: "GET", path: /^\/api\/apps$/, handle: async () => appsApi("/internal/status").then((apps) => ({ apps }), (e: Error) => ({ apps: [], error: e.message })) },
    {
      method: "PATCH",
      path: /^\/api\/issues\/([^/]+)$/,
      handle: async (m, body) => {
        const { ctx, issue } = await editableIssue(decodeURIComponent(m[1]!));
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
        const { ctx, issue: asked } = await editableIssue(decodeURIComponent(m[1]!));
        // A task moved to a successor (rollover.ts): the message goes there, and the board opens it.
        const issue = await latest(pc, store, asked);
        const moved = issue.id !== asked.id ? { movedTo: issue.identifier } : {};
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
        if (!others.length || named.length > others.length) posted = await pc.addComment(issue.id, displayText(text));
        // On the user's own task the message stays in the team chat; the Researcher leaves it to the others.
        else if (issue.id === task!.id) posted = await pc.addComment(issue.id, `${displayText(text)}\n\n${FOR_OTHERS}`);
        log.info({ issue: issue.identifier, mentions: named.map((a) => a.name) }, "comment added");
        // A message to a finished chat reopens it.
        // A chat keeps its agent: a message to a chat the agent handed back goes to that agent again.
        if (isChat(issue, ctx) && (!issue.assigneeAgentId || issue.status === "done" || issue.status === "cancelled")) {
          const agentId = chatAgent(issue);
          await pc.updateIssue(issue.id, { status: "todo", ...(agentId && !issue.assigneeAgentId ? { assigneeAgentId: agentId, assigneeUserId: null } : {}) });
        }
        if (posted) await wakeIfHeld(issue.id, posted.id);
        const where = issue.id === task?.id ? "the team chat" : `${ctx.assignees.find((a) => a.key === issue.assigneeAgentId)?.persona?.name ?? "another agent"}'s chat`;
        const parts = [];
        for (const a of others) parts.push(await deliver(ctx, task!, a, text, { identifier: issue.identifier, commentId: posted?.id, note: `Written in ${where} on ${issue.identifier}.` }));
        // A message that left this chat for another agent's: the board opens that one.
        return { ...(await view()), ...moved, ...(!posted && parts[0] ? { movedTo: parts[0].identifier } : {}) };
      },
    },
    {
      // Bring an agent onto one of your tasks: a sub-task assigned to it, with your instructions.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/agents$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
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
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
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
        await addToCrew(ctx, issue, agent, handOverText(displayText(part.description), fromAgent.persona?.name ?? fromAgent.name), {});
        // A status change wakes nobody: a comment here would read as an instruction to the runner.
        await pc.updateIssue(part.id, { status: "cancelled" });
        log.info({ issue: issue.identifier, from: part.identifier, to: agent.name }, "handed over");
        return issueView(issue.id);
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/files$/, maxBody: MAX_UPLOAD_BODY + 1024, handle: async (m, body) => attach(decodeURIComponent(m[1]!), body) },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/move$/,
      handle: async (m, body) => {
        const { issue } = await editableIssue(decodeURIComponent(m[1]!));
        const { bucket, position } = parse(z.object({ bucket: z.enum(BUCKETS), position: z.enum(["top", "bottom"]).default("top") }).strict(), body);
        store.move(issue.id, bucket, position);
        return { ok: true };
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/schedule$/, handle: async (m, body) => schedule(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/recurring$/, handle: async (m, body) => recurringChange(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/merge$/, handle: async (m, body) => merge(decodeURIComponent(m[1]!), body) },
    { method: "GET", path: /^\/api\/issues\/([^/]+)\/lineage$/, handle: async (m) => lineage(decodeURIComponent(m[1]!)) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/settle$/, handle: async (m, body) => settle(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/aside$/, maxBody: 100_000, handle: async (m, body) => aside(decodeURIComponent(m[1]!), body) },
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
      // Status and title of tasks referenced in text ("PEN-12"), so links show whether they're done.
      method: "GET",
      path: /^\/api\/refs$/,
      handle: async (_m, _body, url) => {
        const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim().toUpperCase()))].filter((s) => /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(s)).slice(0, 100);
        const out: Record<string, { status: string; title: string }> = {};
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
        if (!a?.adapterType) throw new HttpError(404, "not an Engineer");
        let listed = (await pc.models(a.adapterType).catch(() => [])).map((x) => x.id);
        if (openrouterEngine(a.engine)) listed = listed.filter((x) => x.startsWith("openrouter/"));
        const models = [...new Set([...(a.defaultModel ? [a.defaultModel] : []), ...(a.models ?? []), ...listed])];
        return { default: a.defaultModel ?? null, models, efforts: a.efforts ?? [] };
      },
    },
  ];

  // Referenced tasks change rarely; a short cache keeps the brief cheap to render.
  const refs = new Map<string, { at: number; value: { status: string; title: string } | null }>();
  async function refCache(id: string) {
    const hit = refs.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = await pc.issue(id).then(
      (i) => ({ status: i.status, title: i.title }),
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
    const body = await readJson(req);
    send(res, 200, JSON.stringify(await route.handle(url.pathname.match(route.path)!, body, url, req)), "application/json");
  }

  /** Account administration on the board: any admin, and never the owner's account. The kernel acts as that admin's session. */
  const RoleSchema = z.enum(["admin", "user"]);
  const accountRoutes: { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, who: AccountSession) => Promise<unknown> }[] = [
    { method: "GET", path: /^\/api\/accounts$/, handle: async (_m, _b, who) => opts.accounts!.call("list", who) },
    // Your own signed-in browsers.
    { method: "GET", path: /^\/api\/accounts\/sessions$/, handle: async (_m, _b, who) => opts.accounts!.call("sessions", who) },
    { method: "POST", path: /^\/api\/accounts\/sessions\/([\w-]{1,64})\/revoke$/, handle: async (m, _b, who) => opts.accounts!.call("revoke_session", who, { id: m[1]! }) },
    {
      method: "POST",
      path: /^\/api\/accounts$/,
      handle: async (_m, body, who) => opts.accounts!.call("invite", who, parse(z.object({ email: z.string().email().max(200), name: z.string().max(100).default(""), role: RoleSchema }).strict(), body)),
    },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/role$/, handle: async (m, body, who) => opts.accounts!.call("role", who, { id: m[1]!, role: parse(z.object({ role: RoleSchema }).strict(), body).role }) },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/(disable|enable)$/, handle: async (m, _b, who) => opts.accounts!.call(m[2]!, who, { id: m[1]! }) },
    { method: "POST", path: /^\/api\/accounts\/([\w-]{1,64})\/link$/, handle: async (m, _b, who) => opts.accounts!.call("link", who, { id: m[1]! }) },
    // App admins (docs/design/access.md, Per-app roles): every shared app, its admins and default; name or remove one.
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
      send(res, 200, JSON.stringify({ mode, account, googleConnect: googleViaBoard, adminUrl: opts.adminUrl ?? null }), "application/json");
      return true;
    }
    if (!who) throw new HttpError(401, "sign in");
    const a = accountRoutes.find((r) => r.method === req.method && r.path.test(path));
    if (a) {
      const body = req.method === "GET" ? undefined : await readJson(req);
      send(res, 200, JSON.stringify(await a.handle(path.match(a.path)!, body, who)), "application/json");
      return true;
    }
    // A ready admin: writes as the owner (the board key); `authored` records which account it was.
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
    return perRequest.run({ session }, async () => {
      const file = req.method === "GET" ? /^\/api\/issues\/([^/]+)\/files\/([0-9a-f-]{36})$/.exec(path) : null;
      if (file) return download(res, decodeURIComponent(file[1]!), file[2]!);
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
  const isConnect = (path: string) => path === "/google/connect" || (opts.signIns ?? []).some((s) => s.connect === path);

  /**
   * Connect a Google account, or reconnect an expired one: /google/connect sends the browser to Google's
   * consent screen, Google sends it back to /google/callback, and google-workspace-mcp stores the token. On the
   * laptop's loopback address (a Desktop-app client), or at the board's https address (BOARD_LAN_URL, registered as a
   * redirect on a Web-app client: the company OAuth app, ops/setup.sh). The callback needs no session (a cookie isn't sent
   * on Google's cross-site redirect): its single-use state, minted for the owner's session, is the proof.
   */
  async function handleGoogle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!opts.google) throw new HttpError(404, "Google sign-in isn't set up on the board (no google_auth_token)");
    if (!googleViaBoard && !loopbackPort(req.headers.host)) throw new HttpError(403, `connect Google from ${TUNNEL}`);
    const callback = googleViaBoard ? `${opts.lan!.url}/google/callback` : `http://${String(req.headers.host).toLowerCase()}/google/callback`;
    try {
      if (url.pathname === "/google/connect") {
        const account = url.searchParams.get("account") || undefined;
        const { url: consent } = await opts.google.start(account, callback);
        log.info({ account: account ?? "(new)" }, "Google sign-in started");
        res.writeHead(302, { ...SECURITY_HEADERS, location: consent, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/google/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code) throw new GoogleAuthFailed(`Google didn't grant access (${url.searchParams.get("error") ?? "no code"})`);
        const { email } = await opts.google.finish(state, code);
        log.info({ account: email }, "Google account connected");
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      if (!(err instanceof GoogleAuthFailed)) throw err;
      log.warn({ err: err.message }, "Google sign-in failed");
      return send(res, 400, page(`Couldn't connect Google: ${err.message}`), "text/html; charset=utf-8");
    }
    throw new HttpError(404, "not found");
  }

  /**
   * A module's sign-in (board.signins): /<id>/connect sends the browser to the service's sign-in, which sends it back to
   * the callback, and the proxy keeps the token. On the laptop's loopback address only, like Google's Reconnect: the
   * sign-in client is registered for that redirect (a vendor may permit only the bare /callback shape).
   */
  const signInFor = (path: string) => (opts.signIns ?? []).find((s) => s.connect === path || s.callback === path);

  async function handleSignIn(req: IncomingMessage, res: ServerResponse, url: URL, s: SignIn) {
    const { label: name, connect, callback, auth } = s;
    const port = loopbackPort(req.headers.host);
    if (!port) throw new HttpError(403, `sign in to ${name} from ${TUNNEL}`);
    const host = String(req.headers.host).toLowerCase();
    try {
      if (url.pathname === connect) {
        const { url: signIn } = await auth.start(`http://${host}${callback}`);
        log.info(`${name} sign-in started`);
        res.writeHead(302, { ...SECURITY_HEADERS, location: signIn, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === callback) {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code) throw new McpAuthFailed(`${name} didn't grant access (${url.searchParams.get("error") ?? "no code"})`);
        await auth.finish(state, code);
        log.info(`${name} connected`);
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      if (!(err instanceof McpAuthFailed)) throw err;
      log.warn({ err: err.message }, `${name} sign-in failed`);
      return send(res, 400, page(`Couldn't connect ${name}: ${err.message}`), "text/html; charset=utf-8");
    }
    throw new HttpError(404, "not found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
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

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://board");
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");
    if (mode === "internal") {
      try {
        // The monitoring module's routes (monitoring.ts): their own token, which opens nothing else.
        if (url.pathname === "/internal/metrics" || url.pathname === "/internal/alerts") {
          const token = monitoringToken();
          if (!token || !bearerMatches(req.headers.authorization, token)) throw new HttpError(401, "unauthorized");
          if (!String(req.headers.host ?? "") || !opts.allowedHosts.includes(String(req.headers.host).toLowerCase())) throw new HttpError(403, "unknown host");
          if (req.method === "GET" && url.pathname === "/internal/metrics") return send(res, 200, await metricsText(store, records), "text/plain; version=0.0.4; charset=utf-8");
          if (req.method !== "POST" || url.pathname !== "/internal/alerts") throw new HttpError(405, "method not allowed");
          const r = receiveAlerts(store, parse(AlertsSchema, await readJson(req, 2_000_000)));
          kickDetector();
          return send(res, 200, JSON.stringify(r), "application/json");
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
    const rejected = checkRequest(req, opts.allowedHosts);
    if (rejected) {
      log.warn({ method: req.method, path: url.pathname, reason: rejected }, "request rejected");
      return send(res, 403, JSON.stringify({ error: rejected }), "application/json");
    }
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      // The kernel's handoff (kernel-auth.ts): the board's own session, on its own origin.
      else if (url.pathname === "/auth/start" && req.method === "GET" && opts.accounts) opts.accounts.start(req, res);
      else if (url.pathname === "/auth/handoff" && req.method === "GET" && opts.accounts) await opts.accounts.finish(req, res, url);
      else if (isConnect(url.pathname) && !(await adminSignedIn(req))) throw new HttpError(403, "sign in as an admin to connect accounts");
      else if (url.pathname.startsWith("/google/") && req.method === "GET") await handleGoogle(req, res, url);
      else if (signInFor(url.pathname) && req.method === "GET") await handleSignIn(req, res, url, signInFor(url.pathname)!);
      else if (req.method === "GET" || req.method === "HEAD") await serveStatic(req, res, url.pathname);
      else throw new HttpError(405, "method not allowed");
    } catch (err) {
      const status = statusOf(err);
      if (status >= 500) log.error({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "request failed");
      if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error" }), "application/json");
    }
  });
}

/** ops/setup.sh's welcome chat (the operator's key): written as the owner, and never an approver. */
const OPERATOR: BoardSession = { accountId: "operator", role: "admin" };

const statusOf = (err: unknown) => (err instanceof HttpError || err instanceof AccountError ? err.status : err instanceof BadRequest ? 400 : err instanceof PaperclipError ? (err.status === 404 ? 404 : 502) : 500);

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

/** A bare page for the sign-in outcome (the CSP allows no inline style or script). */
function page(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AidenHQ</title><p>${esc}</p><p><a href="/">Back to the board</a></p>`;
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

/** The runner's latest job result per task (a failed run shows on the agent's portrait). */
function latestJobs(report: { recent: { identifier: string; status?: string }[]; latest?: { identifier: string; status: string }[] } | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const j of [...(report?.recent ?? []), ...(report?.latest ?? [])]) if (j.status && !out.has(j.identifier)) out.set(j.identifier, j.status);
  return out;
}

