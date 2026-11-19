// The kernel's backplane listener (10.231.0.1:3130): the tool proxy, caller identity, the keys modules check assertions
// with, the agent directory modules read, and the control plane as the calling agent.
//   GET  /healthz              ok
//   GET  /v1/jwks              the caller-assertion keys
//   GET  /v1/whoami            (a kernel job's or a module's token) who the bearer is and its granted tools
//   GET  /v1/agents            (module token) every agent's key, roles, profile and the fields setup records for it, never its tools
//   POST /c/<connection>/mcp   (run or module token) the tool proxy (proxy.ts)
//   ANY  /v1/cp/agent/<path>   (module token + caller assertion) cp.ts; a status change to done passes the finish gate
//   POST /v1/checks/:task      (a check's module) release its label on a task, or resolve a hold it placed (checks.ts)
//   POST /v1/writes            (run, module, or job token naming the kind) request a write (writes.ts); GET /v1/writes/:id its
//                              record (own only; the board: any)
//   POST /v1/writes/:id/outcome (the kind's executor module) the outcome of an execute
//   GET  /v1/writes            (the board's key) records by state or task (`tier0=1`: Tier 0 runs too)
//   GET  /v1/channel/cards, POST /v1/channel/{decide,owner-message,stop,thread}  (a speaks-as-owner channel's token) cards
//                              with decision tokens, a token spent, the owner's words (channels.ts)
//   GET  /v1/cp/read/<path>    (a channel, or a module with role kernel.cp-read) the control plane's read routes, as the owner;
//                              with the board's key, the board's reads (cp.ts createBoardCp)
//   ANY  /v1/cp/owner/<path>   (the board's key) the owner's writes the board makes, X-AidenHQ-Account the admin's (cp.ts)
//   POST /v1/brake/notify      (the owner's router) may an agent message the owner about a task again (brake.ts)
//   POST /v1/channel/exchange  (a module with role kernel.lane) a fast-lane turn written to its agent's chat task (lane.ts)
//   POST /v1/notify            (the board's key, or a module with role kernel.owner-notice) a message for the owner,
//                              queued for the owner's router (notify.ts)
//   GET  /v1/notify/take, POST /v1/notify/send  (the module with role kernel.notify) the queued owner messages, each once; one
//                              message to a channel's transport
//   POST /v1/wakes/events      (the paperclip-events plugin's key) a Paperclip event's ids: its task is scanned (wakes.ts)
//   POST /v1/wakes             (a module with role kernel.wake) a scheduled wake {task, agent?, at?, cause?, id?}; with
//                              {task, text}: a labelled wake notice on the task now, which wakes its agent (no scheduled row)
//   POST /v1/wakes/claim, POST /v1/wakes/:key/drop  (a module with role kernel.jobs) claim inbox rows; give one up
//   POST /v1/routines/cancel   (a module with role kernel.jobs) {task, why: coalesced|stale, body}: an open or blocked routine run of an
//                              agent it dispatches, cancelled as that agent (wakes.ts)
//   POST /v1/wakes/:key/note   (the module that claimed it) {body}: a note on its task as its agent, once (no job answers it)
//   POST /v1/tasks             (a module with role kernel.tasks) {title, description, role | agent, source, parent?}: a task of the module's
//                              fixed text for the agent holding `role` (or `agent`, by id), once per source (modtasks.ts); POST /v1/tasks/:task/close
//                              {status: done|cancelled, body}: one it filed
//   POST /v1/reviews           (the runner's reviewer key) a check before filing: one review by the bound reviewer module → its verdict
//   POST /v1/reviews/:review   (that review's token, once) the reviewer module's verdict
//   POST /v1/jobs {wake, prompt, session?}, GET/DELETE /v1/jobs/:job, POST /v1/jobs/:job/input  (a module with role kernel.jobs)
//                              a job on a wake it claimed, admitted (admission.ts: the only way a job starts), its status
//                              (?after=<version>&wait=<ms> waits for a change), stop it, a comment into it (jobs.ts; `wake`: the claimed comment wake it delivers);
//                              GET /v1/jobs?open=1 | ?task=<id>: its own jobs not yet acknowledged, or a task's; POST /v1/jobs/:job/ack: an ended job is dealt with
//   POST /v1/codehost/:op      (a module's own token) token | snapshot | clone on the code host that owns the repo, under the module's
//                              codehost grant (codehost.ts)
//   POST /v1/jobs/workspace    (a module with role kernel.jobs) {task}: the workspace folder it may write into (a task of an agent it dispatches)
//   GET  /v1/work[?task=|?job=|?agent=|?since=], GET /v1/work/metrics  (a module with role kernel.work-read) the jobs and records
//                              of the kernel's work: a task's, one job, an agent's, the records and billed cost since a time, or what
//                              runs and ended lately; Prometheus text (work.ts)
//   GET  /v1/work[?task=|?job=|?agent=|?since=]  (the board) the same reads; never the metrics or a token
//   GET  /v1/flow?task=|?item=|?idle=1|?journeys=1|?journey=|?since=[&to=&by=&scope=]  (the board, or a module with role
//                              kernel.flow-read) Flow's views over the fact log (flow.ts): a task's or item's waterfall, idle
//                              now, the declared journeys, a journey's items (journeys.ts), the summary with its insights
//   POST /v1/work/grader-token  (the one module with role kernel.grader) {task} -> a gateway
//                              token billed to the task's assignee under its caps, for a task its finish check holds; one live token per task
//   POST /v1/jobs/:job/post    (that job's module) {kind: reply|status|notice, body, status?, blocked_by?}: posted on the job's
//                              task as its agent, once per kind (outcomes.ts)
//   POST /v1/checks, GET /v1/checks/:check, POST /v1/receipts/verify  (a module with role kernel.checks) a credential-free check
//                              job of repo@head and its signed receipt (?after=<version>&wait=<ms>), a receipt checked against
//                              {repo, head, run, judge?, policy?} (checkjobs.ts)
//   POST /v1/checkout          (a kernel job's own token) {repo, sha?}: a code host snapshot (tar.gz) for a job holding the
//                              repo-checkout role, an agents-org repo only: GitHub's, or local/… from codehost-local (jobtools.ts checkout)
//   POST /v1/jobtools/:cmd     (a kernel job's own token) reset | engine {engine, model?} | cleanup: what the running job asks of its
//                              task's next turn (jobtools.ts)
//                              | clone {repo}: a repository on this server as a git bundle, which the box clones itself
//   GET  /v1/advisories        (the board's key) the marketplace advisories open against installed modules (advisories.ts)
//   GET  /v1/connections/health (the board's key) every connection's /healthz as the kernel reaches it -> {probes: {name: {ok, status?, state?, detail?, channels?, checkedAt}}} (health.ts)
//   POST /v1/auth/:op, /v1/accounts/:op, /v1/apps/:op, /v1/operator/:op  the accounts' routes (auth-api.ts): module UI
//                              sessions and account admin (the board), in-app requests (apps-platform), setup links (operator)
//   POST /v1/health/probe      (the host's health_probe_key, x-health-key) {probe}: one of health.ts's fixed read probes, called as the
//                              agent granted it -> {ok, ms, error?}, never the tool's answer; scripts/healthcheck.sh's reads
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Asserter } from "./assert.ts";
import type { Facts } from "./facts.ts";
import type { Brake } from "./brake.ts";
import type { Checks } from "./checks.ts";
import type { Lane } from "./lane.ts";
import type { Checks as CheckJobs } from "./checkjobs.ts";
import { CP_READ_PATHS, isChannel, neutral, type Api, type Channels, type ModulesFile } from "./channels.ts";
import type { Grant, Whoami } from "./identity.ts";
import type { Jobs } from "./jobs.ts";
import type { Admission } from "./admission.ts";
import { JOB_KINDS, type Outcomes } from "./outcomes.ts";
import { notice, type Notify } from "./notify.ts";
import type { JobTools } from "./jobtools.ts";
import type { Routing } from "./routing-tune.ts";
import { hostOf } from "./codehost.ts";
import { fail } from "./proxy.ts";
import type { Records, State } from "./records.ts";
import type { Work } from "./work.ts";
import { BY, type By, type Flow } from "./flow.ts";
import { AUTHOR_KINDS, SORTS, type AuthorKind, type Sort } from "./journeys.ts";
import type { Reviews } from "./reviews.ts";
import { wakeNotice, type Wakes } from "./wakes.ts";
import type { ModuleTasks } from "./modtasks.ts";
import { CONN_TOOL, type Writes } from "./writes.ts";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
type Handler = (req: IncomingMessage, res: ServerResponse, ...a: string[]) => Promise<void>;
/** Directory fields a module may read; everything else in the grants table (tools, models, caps, images) stays here. */
const DIRECTORY = ["key", "roles", "profile", "trial", "description", "delegate_to", "memory_inbox", "review_log", "graded", "feedback_for"];

/** What a task shows when the owner stops its run: the kernel's own words, the dispatcher posts nothing else for it. */
const STOPPED_NOTE = "**Stopped by the owner.** Say **continue** to pick up where it stopped.";
/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.mjs reads it, so the lock can't miss a route. */
export const ROUTES = [
  { method: "GET", path: "/healthz", auth: "none" },
  { method: "GET", path: "/v1/jwks", auth: "none" },
  { method: "GET", path: "/v1/whoami", auth: "bearer" },
  { method: "GET", path: "/v1/agents", auth: "module" },
  { method: "POST", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "DELETE", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "ANY", path: "/v1/cp/agent/*", auth: "module+assertion" },
  { method: "POST", path: "/v1/checks/:task", auth: "module" },
  { method: "POST", path: "/v1/writes", auth: "bearer" },
  { method: "GET", path: "/v1/writes", auth: "board" },
  { method: "GET", path: "/v1/writes/:id", auth: "bearer" },
  { method: "POST", path: "/v1/writes/:id/outcome", auth: "module" },
  { method: "GET", path: "/v1/channel/cards", auth: "module" },
  { method: "POST", path: "/v1/channel/decide", auth: "module" },
  { method: "POST", path: "/v1/channel/owner-message", auth: "module" },
  { method: "POST", path: "/v1/channel/stop", auth: "module" },
  { method: "POST", path: "/v1/channel/thread", auth: "module" },
  { method: "POST", path: "/v1/channel/exchange", auth: "module" },
  { method: "GET", path: "/v1/cp/read/*", auth: "module|board" },
  { method: "ANY", path: "/v1/cp/owner/*", auth: "board" },
  { method: "POST", path: "/v1/brake/notify", auth: "module" },
  { method: "POST", path: "/v1/notify", auth: "board" },
  { method: "GET", path: "/v1/notify/take", auth: "module" },
  { method: "POST", path: "/v1/notify/send", auth: "module" },
  { method: "POST", path: "/v1/facts", auth: "module" },
  { method: "POST", path: "/v1/wakes/events", auth: "events-key" },
  { method: "POST", path: "/v1/wakes", auth: "module" },
  { method: "POST", path: "/v1/wakes/claim", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/drop", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/note", auth: "module" },
  { method: "POST", path: "/v1/routines/cancel", auth: "module" },
  { method: "POST", path: "/v1/tasks", auth: "module" },
  { method: "POST", path: "/v1/tasks/:task/close", auth: "module" },
  { method: "POST", path: "/v1/reviews", auth: "reviewer-key" },
  { method: "POST", path: "/v1/reviews/:review", auth: "review-token" },
  { method: "POST", path: "/v1/jobs", auth: "module" },
  { method: "GET", path: "/v1/jobs", auth: "module" },
  { method: "POST", path: "/v1/jobs/workspace", auth: "module" },
  { method: "POST", path: "/v1/codehost/:op", auth: "module" },
  { method: "GET", path: "/v1/jobs/:job", auth: "module" },
  { method: "DELETE", path: "/v1/jobs/:job", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/input", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/ack", auth: "module" },
  { method: "GET", path: "/v1/work", auth: "module|board" },
  { method: "GET", path: "/v1/work/metrics", auth: "module" },
  { method: "GET", path: "/v1/flow", auth: "module|board" },
  { method: "POST", path: "/v1/work/grader-token", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/post", auth: "module" },
  { method: "POST", path: "/v1/checks", auth: "module" },
  { method: "GET", path: "/v1/checks/:check", auth: "module" },
  { method: "POST", path: "/v1/receipts/verify", auth: "module" },
  { method: "POST", path: "/v1/jobtools/:cmd", auth: "job" },
  { method: "POST", path: "/v1/checkout", auth: "job" },
  { method: "GET", path: "/v1/advisories", auth: "board" },
  { method: "GET", path: "/v1/connections/health", auth: "board" },
  { method: "POST", path: "/v1/settings/change", auth: "board" },
  { method: "POST", path: "/v1/stop", auth: "board" },
  { method: "POST", path: "/v1/routing/:op", auth: "module+assertion" },
  { method: "POST", path: "/v1/auth/:op", auth: "board" },
  { method: "POST", path: "/v1/accounts/:op", auth: "board+session" },
  { method: "POST", path: "/v1/apps/:op", auth: "module" },
  { method: "POST", path: "/v1/operator/:op", auth: "operator-key" },
  { method: "POST", path: "/v1/health/probe", auth: "health-key" },
] as const;
// `:id` matches a record id, any other `:name` [a-z0-9_]+, a trailing `/*` the rest of the path, slash included.
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:id\b/g, "(k-[0-9a-f]{16})").replace(/:review\b/g, "(r-[0-9a-f]{16})").replace(/:job\b/g, "(j-[0-9a-f]{16})").replace(/:check\b/g, "(c-[0-9a-f]{16})").replace(/:task\b/g, "([0-9a-f-]{36})").replace(/:key\b/g, "([^/]{1,200})").replace(/:\w+/g, "([a-z0-9_]+)").replace(/\/\*$/, "(/.*)")}$`) }));
/** The record lists the board and the runner read (`?state=`). */
const ALL: State[] = ["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"];
const LISTS: { [k: string]: State[] } = { review: ["review"], owner: ["owner"], pending: ["review", "owner"], approved: ["approved"], recent: ALL, finished: ["done", "failed", "unknown"] };

async function json(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "too_large", "too large"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
}

/** GET /v1/work's reads, by query: ?job=, ?task=, ?agent=, ?since=[&to=], ?generations=1, or what runs now (work.ts). */
function workRead(work: Work, p: URLSearchParams) {
  const [job, task, agent, since] = [p.get("job"), p.get("task"), p.get("agent"), p.get("since")];
  if (p.get("generations")) return work.generations();
  if (job) return work.job(job.slice(0, 40)) ?? (() => { throw fail(404, "not_found", `no job ${job.slice(0, 40)}`); })();
  if (agent) return work.agent(agent.slice(0, 100));
  if (since) {
    const to = p.get("to") ?? undefined;
    if (Number.isNaN(Date.parse(since)) || (to && Number.isNaN(Date.parse(to)))) throw fail(400, "bad_request", "since and to are ISO timestamps");
    return work.since(since, to);
  }
  return task ? work.task(task.slice(0, 100)) : work.activity();
}

const FACT_AT = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * GET /v1/flow's reads, by query: ?task=, ?item=, ?idle=1, ?journeys=1 (the declared journeys), ?journey=<name> (its items over
 * ?since= [&to=&author=agent,owner,outside&sort=recent|slowest|rounds&limit=200]), else the summary over ?since= (default 7 days)
 * [&to=&by=&scope=] with its insights.
 */
function flowRead(flow: Flow, p: URLSearchParams) {
  const [task, item] = [p.get("task"), p.get("item")];
  if (task) return flow.task(task.slice(0, 100));
  if (item) return flow.item(item.slice(0, 100));
  if (p.get("idle")) return flow.idleNow();
  if (p.get("journeys")) return flow.journeys();
  const since = p.get("since") ?? new Date(Date.now() - 7 * 864e5).toISOString(), to = p.get("to") ?? undefined, by = p.get("by") ?? "stage";
  if (Number.isNaN(Date.parse(since)) || (to && Number.isNaN(Date.parse(to)))) throw fail(400, "bad_request", "since and to are ISO timestamps");
  const journey = p.get("journey");
  if (journey) {
    const authors = p.get("author")?.split(",").filter(Boolean), sort = p.get("sort") ?? "recent", limit = Number(p.get("limit") ?? 200);
    if (authors?.some((a) => !(AUTHOR_KINDS as string[]).includes(a))) throw fail(400, "bad_request", `author is a list of ${AUTHOR_KINDS.join(", ")}`);
    if (!(SORTS as string[]).includes(sort)) throw fail(400, "bad_request", `sort is one of ${SORTS.join(", ")}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw fail(400, "bad_request", "limit is 1 to 1000");
    const list = flow.journey({ name: journey.slice(0, 100), since, to, authors: authors as AuthorKind[] | undefined, sort: sort as Sort, limit });
    if (!list) throw fail(404, "not_found", `no module declares journey ${journey.slice(0, 40)}`);
    return list;
  }
  if (!(BY as string[]).includes(by)) throw fail(400, "bad_request", `by is one of ${BY.join(", ")}`);
  return flow.summary({ since, to, by: by as By, scope: p.get("scope")?.slice(0, 100) || undefined });
}

export function createBackplane({ facts, whoami, asserter, proxy, cp, boardCp, grantsFile, writes, records, channels, brake, notify, owner, modules = () => ({}), boardKey = () => "", reviews, reviewerKey = () => "", jobs, codehost, admission, outcomes, wakes, tasks, eventsKey = () => "", work, flow, repos = () => ({}), graderToken = () => "", dropGraderToken = () => {}, advisories = () => [], accounts, checks, checkJobs, jobTools, localBundle, ownerRaw, lane, healthProbe, healthKey = () => "", connectionHealth, settingsChange, routing, log = () => {} }: {
  /** Flow's fact log (facts.ts): POST /v1/facts. */
  facts?: Facts;
  whoami: Whoami; asserter: Asserter; proxy: Handler; cp: Handler; boardCp?: Handler; grantsFile: () => { agents?: Record<string, Grant> } & Record<string, unknown>;
  writes?: Writes; records?: Records; boardKey?: () => string; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The reviewer slot, and the key a direct review request asks with (reviewer_key, which the board holds). */
  reviews?: Reviews; reviewerKey?: () => string;
  /** 2f: channel tokens and owner messages, the notify brake, and the control plane as the owner (reads, wake notices). */
  channels?: Channels; brake?: Brake; owner?: Api; modules?: () => ModulesFile;
  /** The control plane as the owner, the raw response (an attachment's bytes, which `owner`'s JSON can't carry). */
  ownerRaw?: (path: string) => Promise<Response>;
  /** The fast chat lane's exchanges onto its agents' chat tasks (lane.ts). */
  lane?: Lane;
  /** 3.2: the owner's messages, queued for the owner-channel module and handed to channels' transports. */
  notify?: Notify;
  /** 3e: jobs in the sandbox. */
  jobs?: Jobs;
  /** The GitHub code host's operations for modules (codehost.ts). */
  codehost?: (module: string, op: string, body: Record<string, unknown>, res: ServerResponse) => Promise<void>;
  /** Admission (admission.ts): a job on a wake the module claimed, its authority frozen, its computer the kernel's (boxes.ts). */
  admission?: Admission;
  /** F5: a job's outcome posted as its agent. */
  outcomes?: Outcomes;
  /** The wake inbox (wakes.ts), and the paperclip-events plugin's key. */
  wakes?: Wakes; eventsKey?: () => string;
  /** Tasks modules file for agents (modtasks.ts). */
  tasks?: ModuleTasks;
  /** Reads of the work the kernel owns (work.ts). */
  work?: Work;
  /** Flow's views over the fact log (flow.ts). */
  flow?: Flow;
  /** The repos the instance reaches (codehostRepos in main.ts): GET /v1/agents hands them to modules. */
  repos?: () => Record<string, unknown>;
  /** A grader-kind gateway token for a task (the kernel is the only minter). */
  graderToken?: (task: string, agent: string) => string;
  /** Forget a task's cached grader token (its hold resolved or was released). */
  dropGraderToken?: (task: string) => void;
  /** 4e: the open marketplace advisories. */
  advisories?: () => unknown[];
  /** 3g: the accounts' routes (auth-api.ts). */
  accounts?: (req: IncomingMessage, res: ServerResponse, group: string, op: string) => Promise<void>;
  /** 3h: the finish gate (checks.ts). */
  checks?: Checks;
  /** Check jobs and their receipts (checkjobs.ts). */
  checkJobs?: CheckJobs;
  /** A running job's requests for its task's next turn (jobtools.ts). */
  jobTools?: JobTools;
  /** codehost-local's bundle of a repo on this server, while it is enabled (`aidenhq clone`): the file, and `done` once sent. */
  localBundle?: (repo: string) => Promise<{ file: string; done: () => void }>;
  /** The host's health probes (health.ts), and the key the host's healthcheck asks with (health_probe_key, held by no container). */
  healthProbe?: (b: Record<string, unknown>) => Promise<{ ok: boolean; ms: number; error?: string }>;
  healthKey?: () => string;
  /** Every connection's /healthz (health.ts createConnectionHealth). */
  connectionHealth?: () => Promise<Record<string, unknown>>;
  /** The owner's typed settings change on their settings task (settings-change.ts). */
  settingsChange?: (task: unknown, changes: unknown) => Promise<unknown>;
  /** The routing learning loop (routing-tune.ts). */
  routing?: Routing;
}) {
  /** The calling module (its own token), or 401. */
  const moduleOf = async (req: IncomingMessage) => {
    const w = await whoami(bearer(req)).catch(() => undefined);
    if (w?.kind !== "module" || !w.module) throw fail(401, "unauthorized", "a module's own token is required");
    return w;
  };
  /** The chief of staff's agent id, from the grants table (where owner messages go by default). */
  const cos = () => chiefOfStaff(grantsFile().agents);
  const keyIs = (req: IncomingMessage, key: string) => { const a = Buffer.from(bearer(req)), b = Buffer.from(key); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  const isBoard = (req: IncomingMessage) => keyIs(req, boardKey());
  const reviewer = (req: IncomingMessage) => { if (!keyIs(req, reviewerKey())) throw fail(401, "unauthorized", "the reviewer key is required"); };
  const record = (id: string) => records?.get(id) ?? (() => { throw fail(404, "not_found", `no record ${id}`); })();
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path = "", q] = String(req.url ?? "").split(/\?(.*)/s);
    const query = q ? `?${q}` : "";
    try {
      const hit = compiled.find((r) => (r.method === "ANY" || r.method === req.method) && r.re.test(path));
      const m = hit ? hit.re.exec(path)!.slice(1) : [];
      switch (hit && `${hit.method} ${hit.path}`) {
        case "GET /healthz": return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        case "GET /v1/jwks": return send(res, 200, asserter.jwks);
        case "POST /v1/facts": {
          const w = await moduleOf(req);
          if (!w.roles.includes("kernel.facts")) throw fail(403, "forbidden", `${w.module} may not record facts (role kernel.facts)`);
          if (!facts || !records) throw fail(503, "unavailable", "the fact log is off");
          const b = await json(req, 5_000_000);
          if (!Array.isArray(b.facts) || b.facts.length > 500) throw fail(400, "bad_request", "send {facts: [...]} of at most 500");
          const declared = modules().modules?.[w.module!]?.facts ?? {};
          // All are checked before any is recorded: a bad fact refuses the batch, and the rest are recorded in one transaction.
          const t = Date.now();
          for (const f of b.facts) {
            if (!f || !text(f.type, 80) || !text(f.subject, 300) || !text(f.version, 300) || typeof f.at !== "string" || !FACT_AT.test(f.at) || Number.isNaN(Date.parse(f.at))) throw fail(400, "bad_request", "each fact is {type, subject, version, at (ISO), task?, data?}");
            if (!Object.hasOwn(declared, f.type)) throw fail(403, "forbidden", `${w.module} did not declare fact ${f.type} (module.yaml facts:)`);
            if (Date.parse(f.at) > t + 864e5) throw fail(400, "bad_request", `fact ${f.type} is dated more than a day ahead`);
            if (f.data !== undefined && (!f.data || typeof f.data !== "object" || Array.isArray(f.data) || Buffer.byteLength(JSON.stringify(f.data)) > 4096)) throw fail(400, "bad_request", `fact ${f.type}: data is an object of at most 4096 bytes`);
            const d = declared[f.type] ?? {};
            if (d.subject && !f.subject.startsWith(`${d.subject}:`)) throw fail(400, "bad_request", `fact ${f.type}'s subject is a ${d.subject}: (module.yaml facts:)`);
            if (f.data?.reason !== undefined && !(d.reasons ?? []).includes(String(f.data.reason))) throw fail(400, "bad_request", `fact ${f.type}: reason ${String(f.data.reason).slice(0, 40)} isn't declared (module.yaml facts:)`);
          }
          // The actor is the kernel's call, never the body's: the agent whose job (data.job) or PR (its code host record's requester) it
          // is, only when that job or record is the calling module's own; else the module itself.
          const agentOf = (id: unknown) => { try { const a = (records.db.prepare("SELECT agent FROM jobs WHERE id = ? AND module = ?").get(String(id), w.module!) as { agent: string } | undefined)?.agent; const key = a && (grantsFile().agents ?? {})[a]?.key; return key ? `agent:${key}` : undefined; } catch { return undefined; } };
          const prAgent = (subject: string, task: unknown) => {
            const repo = /^pr:([^#]+)#/.exec(subject)?.[1];
            if (!repo || typeof task !== "string") return undefined;
            const r = records.list(["approved", "claimed", "done", "failed"], 50, { task }).find((x) => x.module === w.module && /^codehost-[a-z0-9-]+\.pr$/.test(x.kind) && ((x.args as { only?: { repo?: string }[] } | null)?.only ?? []).some((o) => o.repo === repo));
            return r?.requester.key ? `agent:${r.requester.key}` : undefined;
          };
          let recorded = 0;
          // Facts older than the log keeps (facts.ts prune, 400 days) would be pruned at once: skipped, not refused (a history backfill).
          const kept = t - 400 * 864e5;
          records.db.exec("BEGIN IMMEDIATE");
          try {
            for (const f of b.facts) {
              if (Date.parse(f.at) < kept) continue;
              const data = f.data ?? {};
              const actor = (data.job != null ? agentOf(data.job) : undefined) ?? (f.subject.startsWith("pr:") ? prAgent(f.subject, f.task) : undefined) ?? `module:${w.module}`;
              // The module's name is part of the version (so of the id): two modules declaring one type can never pre-empt each other's facts.
              if (facts.record({ type: f.type, subject: f.subject, version: `${w.module}/${f.version}`, at: f.at, actor, ...(typeof f.task === "string" && f.task ? { task: f.task.slice(0, 100) } : {}), source: f.source === "backfill" ? "backfill" : "live", data })) recorded++;
            }
            records.db.exec("COMMIT");
          } catch (e) {
            records.db.exec("ROLLBACK");
            throw e;
          }
          return send(res, 200, { recorded });
        }
        case "GET /v1/whoami": {
          const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
          return send(res, 200, { kind: w.kind, ...(w.agent ? { agent: w.agent } : {}), roles: w.roles, ...(w.task ? { task: w.task } : {}), ...(w.run ? { run: w.run } : {}), ...(w.module ? { module: w.module } : {}), tools: w.tools });
        }
        case "GET /v1/agents": {
          const w = await whoami(bearer(req)).catch(() => undefined);
          if (w?.kind !== "module") throw fail(401, "unauthorized", "a module's own token is required");
          const t = grantsFile();
          const agents = Object.fromEntries(Object.entries(t.agents ?? {}).map(([id, g]) => [id, Object.fromEntries(DIRECTORY.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]))]));
          // The repos the instance reaches (the agents orgs, product, github_orgs, maintainer_repos): what a deliverable may name.
          return send(res, 200, { agents, repos: repos() });
        }
        case "POST /c/:connection/mcp": case "DELETE /c/:connection/mcp": return await proxy(req, res, m[0]!);
        case "ANY /v1/cp/agent/*": return await cp(req, res, m[0]!, query);
        case "POST /v1/checks/:task": {
          const w = await moduleOf(req);
          if (!checks) throw fail(503, "unavailable", "checks are off");
          const resolved = await checks.resolve(w.module!, m[0]!, await json(req));
          dropGraderToken(m[0]!);
          return send(res, 200, resolved);
        }
        case "POST /v1/notify": {
          // A module that tells the owner about its work (role kernel.owner-notice: the dispatch module's dead ends) queues too.
          if (!isBoard(req) && !(await whoami(bearer(req)).catch(() => undefined))?.roles?.includes("kernel.owner-notice")) throw fail(401, "unauthorized", "the board's key, or a module with role kernel.owner-notice, is required");
          if (!notify) throw fail(503, "unavailable", "notify is off");
          notify.queue(notice(await json(req)));
          return send(res, 200, { queued: true });
        }
        case "GET /v1/notify/take": case "POST /v1/notify/send": {
          const w = await moduleOf(req);
          if (!notify) throw fail(503, "unavailable", "notify is off");
          return send(res, 200, hit!.method === "GET" ? notify.take(w.roles) : await notify.send(w.roles, await json(req)));
        }
        case "POST /v1/health/probe": {
          const given = Buffer.from(String(req.headers["x-health-key"] ?? "")), want = Buffer.from(healthKey());
          if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) throw fail(401, "unauthorized", "the health probe key is required");
          if (!healthProbe) throw fail(503, "unavailable", "the health probe is off");
          return send(res, 200, await healthProbe(await json(req)));
        }
        case "POST /v1/checkout": {
          if (!jobTools || !codehost) throw fail(503, "unavailable", "repo-checkout is off");
          let snap;
          try { snap = jobTools.checkout(bearer(req), await json(req)); } catch (e) {
            const j = e as { name?: string; status?: number; code?: string; message: string };
            if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
            throw e;
          }
          return await codehost(hostOf(snap.repo), "snapshot", snap, res);
        }
        case "POST /v1/jobtools/:cmd": {
          if (!jobTools) throw fail(503, "unavailable", "job tools are off");
          const b = await json(req);
          if (m[0] === "clone") {
            // The repo's branches as a git bundle; the box clones from it itself.
            if (!localBundle) throw fail(404, "unavailable", "there are no repositories on this server (codehost-local isn't enabled)");
            let repo: string;
            try { ({ repo } = jobTools.clone(bearer(req), b)); } catch (e) {
              const j = e as { name?: string; status?: number; code?: string; message: string };
              if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
              throw e;
            }
            const out = await localBundle(repo).catch((e: { status?: number; message: string }) => { throw fail(e.status ?? 500, "no-repo", e.message); });
            res.writeHead(200, { "content-type": "application/octet-stream" });
            // An aborted client ends the pipeline too: the request never hangs and the temp bundle always goes.
            return void (await pipeline(createReadStream(out.file), res).catch(() => {}).finally(out.done));
          }
          try { return send(res, 200, { text: jobTools.run(bearer(req), m[0]!, b) }); } catch (e) {
            const j = e as { name?: string; status?: number; code?: string; message: string };
            if (j.name === "JobToolError") throw fail(j.status!, j.code!, j.message);
            throw e;
          }
        }
        case "GET /v1/cp/read/*": case "ANY /v1/cp/owner/*": {
          const read = hit!.path === "/v1/cp/read/*";
          if (read && !isBoard(req)) break; // a module's read: below
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!boardCp) throw fail(503, "unavailable", "the board's control-plane routes are off");
          return await boardCp(req, res, read ? "read" : "owner", m[0]!, query);
        }
        case "GET /v1/connections/health": if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required"); return send(res, 200, { probes: connectionHealth ? await connectionHealth() : {} });
        case "GET /v1/advisories": if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required"); return send(res, 200, { advisories: advisories() });
        case "POST /v1/stop": {
          // The owner's Stop, from the board's signed-in admin: the running jobs of a task or an agent end `cancelled`, the task stays open with one fixed note.
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!jobs || !outcomes) throw fail(503, "unavailable", "jobs are off");
          const b = await json(req);
          const by = String(req.headers["x-aidenhq-account"] ?? "");
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(by)) throw fail(400, "bad_request", "X-AidenHQ-Account names the admin who stops it");
          if ((typeof b.task === "string") === (typeof b.agent === "string")) throw fail(400, "bad_request", "send {task} or {agent}");
          const stopped = jobs.stopRunning(typeof b.task === "string" ? { task: b.task } : { agent: b.agent }, by);
          for (const j of stopped) {
            log("job stopped by the owner", { job: j.id, task: j.task, agent: j.agent, by });
            await outcomes.post(j, { kind: "notice", body: STOPPED_NOTE }).catch((e: Error) => log("stop note failed", { job: j.id, err: e.message }));
          }
          return send(res, 200, { stopped: stopped.map((j) => j.id) });
        }
        case "POST /v1/settings/change": {
          if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
          if (!settingsChange) throw fail(503, "unavailable", "settings changes are off");
          const b = await json(req, 2_000_000);
          // The owner reads why: a refusal of the change itself, or the code host's or the planner's answer.
          try { return send(res, 200, await settingsChange(b.task, b.changes)); } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
        }
      }
      if (hit?.path === "/v1/routing/:op") {
        // A module holding kernel.routing (the fleet-steward), serving a kernel job's tool call in flight: the job is read from
        // its own token, which the kernel keeps for that call, and must hold the routing-tuner role. Never the body's say-so.
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.routing")) throw fail(403, "forbidden", `${w.module} may not tune routing (role kernel.routing)`);
        if (!routing) throw fail(503, "unavailable", "routing tuning is off");
        const live = await asserter.inFlight(String(req.headers["x-aidenhq-caller"] ?? ""), w.module!);
        const job = live?.flight.bearer ? await whoami(live.flight.bearer).catch(() => undefined) : undefined;
        if (!live || job?.kind !== "run" || !job.task || !job.job || job.agent !== live.caller.agent) throw fail(401, "unauthorized", "only a kernel job's tool call in flight tunes routing");
        if (!job.roles.includes("routing-tuner")) throw fail(403, "forbidden", "routing changes are for an agent with the routing-tuner role");
        const op = m[0]!;
        if (!["evidence", "replay", "tune", "judge"].includes(op)) throw fail(404, "not_found", `no routing op ${op}`);
        const requester = { agent: job.agent ?? "", key: job.key ?? "", name: job.name ?? "", roles: job.roles, kind: job.kind, task: job.task, ...(job.run ? { run: job.run } : {}), ...(job.model ? { model: job.model } : {}) };
        const b = await json(req);
        try {
          return send(res, 200, op === "evidence" ? await routing.evidence(b) : op === "replay" ? routing.replay(b) : op === "tune" ? await routing.tune(requester, job.task, b) : await routing.judge(requester, job.task));
        } catch (e) { throw fail((e as { status?: number }).status ?? 502, "refused", String((e as Error).message).slice(0, 1000)); }
      }
      if (hit?.path.startsWith("/v1/tasks")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.tasks")) throw fail(403, "forbidden", `${w.module} may not file tasks (role kernel.tasks)`);
        if (!tasks) throw fail(503, "unavailable", "module tasks are off");
        const b = await json(req);
        const r = await (hit.path === "/v1/tasks" ? tasks.file(w.module!, b) : tasks.close(w.module!, decodeURIComponent(m[0]!), b)).catch((e: { name?: string; status?: number; message: string }) => { throw e.name === "TaskError" ? fail(e.status!, "bad_request", e.message) : e; });
        return send(res, 200, r);
      }
      if (hit && (hit.path.startsWith("/v1/wakes") || hit.path === "/v1/routines/cancel")) {
        if (hit.path === "/v1/wakes/events") {
          if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
          if (!keyIs(req, eventsKey())) throw fail(401, "unauthorized", "the events plugin's key is required");
          return send(res, 200, await wakes.event(await json(req)));
        }
        const w = await moduleOf(req);
        if (hit.path === "/v1/wakes") {
          if (!w.roles.includes("kernel.wake")) throw fail(403, "forbidden", `${w.module} may not schedule wakes (role kernel.wake)`);
          const b = await json(req);
          if (typeof b.text === "string") {
            // A wake notice now: the labelled comment on the task, posted as the owner, which wakes its agent.
            if (!owner) throw fail(503, "unavailable", "the control plane is off");
            const task = typeof b.task === "string" ? b.task.slice(0, 100) : "", text = neutral(b.text).trim().slice(0, 2000);
            if (!task || !text) throw fail(400, "bad_request", "send {task, text}");
            const r = await wakeNotice(owner, task, text).catch((e: Error) => { throw fail(502, "upstream", e.message); });
            if (r === "missing") throw fail(404, "not_found", `no task ${task}`);
            if (r === "closed") return send(res, 200, { posted: false, closed: true });
            log("wake notice", { module: w.module, task });
            return send(res, 200, { posted: true });
          }
          if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
          const r = await wakes.schedule(w.module!, b);
          if ("error" in r) throw fail(400, "bad_request", r.error!);
          return send(res, 200, r);
        }
        if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not claim wakes (role kernel.jobs)`);
        const b = await json(req);
        if (hit.path === "/v1/wakes/claim") return send(res, 200, { wakes: wakes.claim(w.module!, Math.min(Math.max(Number(b.limit) || 20, 1), 100)) });
        if (hit.path === "/v1/routines/cancel") {
          const r = await wakes.cancelRoutineRun(w.module!, b).catch((e: { name?: string; status?: number; code?: string; message: string }) => {
            throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
          });
          if ("error" in r) throw fail(r.status, "bad_request", r.error);
          return send(res, 200, r);
        }
        if (hit.path === "/v1/wakes/:key/note") {
          const r = await wakes.note(w.module!, decodeURIComponent(m[0]!), b.body).catch((e: { name?: string; status?: number; code?: string; message: string }) => {
            throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
          });
          if ("error" in r) throw fail(r.status, "bad_request", r.error);
          return send(res, 200, r);
        }
        return send(res, 200, wakes.drop(w.module!, decodeURIComponent(m[0]!), String(b.why ?? "")));
      }
      if (hit && /^\/v1\/(channel|cp\/read|brake)/.test(hit.path)) {
        const w = await moduleOf(req);
        const mod = w.module!;
        if (!channels || !brake || !owner) throw fail(503, "unavailable", "channels are off");
        switch (`${hit.method} ${hit.path}`) {
          case "GET /v1/channel/cards": return send(res, 200, await channels.cards(mod, new URLSearchParams(q ?? "").get("resync") === "1"));
          case "POST /v1/channel/decide": return send(res, 200, await channels.decide(mod, await json(req)));
          case "POST /v1/channel/owner-message": return send(res, 200, await channels.ownerMessage(mod, await json(req), cos));
          case "POST /v1/channel/thread": {
            const b = await json(req);
            return send(res, 200, await channels.thread(mod, b, (key) => { const e = Object.entries(grantsFile().agents ?? {}).find(([, g]) => key && g.key === key); return e && { id: e[0], trial: Boolean(e[1].trial) }; }));
          }
          case "POST /v1/channel/stop": return send(res, 200, await channels.stop(mod, await json(req)));
          case "POST /v1/channel/exchange": {
            if (!w.roles.includes("kernel.lane")) throw fail(403, "forbidden", `${mod} may not write lane exchanges (role kernel.lane)`);
            if (!lane) throw fail(503, "unavailable", "the lane is off");
            return send(res, 200, await lane.exchange(mod, await json(req)));
          }
          case "GET /v1/cp/read/*": {
            if (!isChannel(modules().modules?.[mod]) && !w.roles.includes("kernel.cp-read")) throw fail(403, "forbidden", `${mod} has no read access to the control plane (role kernel.cp-read)`);
            const att = /^\/attachments\/([A-Za-z0-9_-]{1,100})\/content$/.exec(m[0]!);
            if (att) {
              // One attachment's bytes: only one listed on the task named by ?task= (the same listing a module reads), at most 25 MB.
              const task = new URLSearchParams(q ?? "").get("task") ?? "";
              if (!task || task.length > 100) throw fail(400, "bad_request", "send ?task=<the task the attachment is on>");
              if (!ownerRaw) throw fail(503, "unavailable", "the control plane is off");
              const list = await owner("GET", `/api/issues/${encodeURIComponent(task)}/attachments`);
              if (list.status !== 200 || !Array.isArray(list.json) || !list.json.some((a: { id?: string }) => a?.id === att[1])) throw fail(404, "not_found", `no attachment ${att[1]} on task ${task.slice(0, 100)}`);
              const r = await ownerRaw(`/api/attachments/${att[1]}/content`);
              if (!r.ok) throw fail(r.status === 404 ? 404 : 502, r.status === 404 ? "not_found" : "upstream", `the control plane answered ${r.status}`);
              if (Number(r.headers.get("content-length") ?? 0) > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              const bytes = Buffer.from(await r.arrayBuffer());
              if (bytes.length > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              return void res.writeHead(200, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "content-length": bytes.length }).end(bytes);
            }
            if (!CP_READ_PATHS.some((re) => re.test(m[0]!))) throw fail(403, "forbidden", `GET ${m[0]} isn't a read route`);
            const r = await owner("GET", `${m[0]}${query}`);
            return send(res, r.status, r.json);
          }
          case "POST /v1/brake/notify": {
            if (!w.roles.includes("kernel.notify")) throw fail(403, "forbidden", "only the owner's router (role kernel.notify) asks the notify brake");
            return send(res, 200, await brake(await json(req)));
          }
        }
      }
      if (hit && /^\/v1\/(auth|accounts|apps|operator)\/:op$/.test(hit.path)) {
        if (!accounts) throw fail(503, "unavailable", "accounts are off");
        return await accounts(req, res, hit.path.split("/")[2]!, m[0]!);
      }
      if (hit?.path === "/v1/flow") {
        if (!isBoard(req)) { const w = await moduleOf(req); if (!w.roles.includes("kernel.flow-read")) throw fail(403, "forbidden", `${w.module} may not read flow (role kernel.flow-read)`); }
        if (!flow) throw fail(503, "unavailable", "flow reads are off");
        return send(res, 200, flowRead(flow, new URLSearchParams(q ?? "")));
      }
      if (hit?.path === "/v1/work" && isBoard(req)) {
        if (!work) throw fail(503, "unavailable", "work reads are off");
        return send(res, 200, workRead(work, new URLSearchParams(q ?? "")));
      }
      if (hit && hit.path.startsWith("/v1/work")) {
        const w = await moduleOf(req);
        if (hit.path !== "/v1/work/grader-token" && !w.roles.includes("kernel.work-read")) throw fail(403, "forbidden", `${w.module} may not read kernel work (role kernel.work-read)`);
        if (!work) throw fail(503, "unavailable", "work reads are off");
        if (hit.path === "/v1/work/grader-token") {
          if (!w.roles.includes("kernel.grader")) throw fail(403, "forbidden", `${w.module} may not ask for grader tokens (role kernel.grader)`);
          const b = await json(req);
          if (typeof b.task !== "string" || !b.task) throw fail(400, "bad_request", "send {task}");
          // Only a task the module's own finish check holds (finished, waiting for its verdict), and only for as long as it does.
          if (!checks?.held(w.module!, b.task.slice(0, 100))) throw fail(403, "forbidden", `no finish check of ${w.module} holds task ${b.task.slice(0, 100)}`);
          if (!owner) throw fail(503, "unavailable", "the control plane is off");
          const issue = await owner("GET", `/api/issues/${encodeURIComponent(b.task.slice(0, 100))}`);
          if (issue.status !== 200 || typeof issue.json.assigneeAgentId !== "string") throw fail(404, "not_found", `no task ${b.task.slice(0, 100)} with an assignee`);
          return send(res, 200, { token: graderToken(b.task.slice(0, 100), issue.json.assigneeAgentId) });
        }
        if (hit.path === "/v1/work/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(work.metrics());
        return send(res, 200, workRead(work, new URLSearchParams(q ?? "")));
      }
      if (hit?.path === "/v1/codehost/:op") {
        const w = await moduleOf(req);
        if (!codehost) throw fail(404, "not_found", "no GitHub code host here");
        return await codehost(w.module!, m[0]!, await json(req), res);
      }
      if (hit && hit.path.startsWith("/v1/jobs")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not run jobs (role kernel.jobs)`);
        if (!jobs) throw fail(503, "unavailable", "jobs are off");
        try {
          switch (`${hit.method} ${hit.path}`) {
            case "POST /v1/jobs": {
              // {wake, prompt, session?}: every job is admitted by the kernel, on a wake its module claimed.
              if (!admission) throw fail(503, "unavailable", "admission is off");
              const b = await json(req, 4_000_000);
              if (typeof (b as { wake?: unknown })?.wake !== "string") throw fail(400, "bad_request", "send {wake, prompt, session?}");
              return send(res, 200, await admission.admit(w.module!, b as never));
            }
            case "GET /v1/jobs": {
              const p = new URLSearchParams(q ?? "");
              const task = p.get("task");
              if (!task && !p.has("open")) throw fail(400, "bad_request", "send ?open=1 or ?task=<id>");
              return send(res, 200, { jobs: jobs.list(w.module!, task ? { task } : { open: true }) });
            }
            case "POST /v1/jobs/workspace": return send(res, 200, await jobs.workspace(w.module!, (await json(req)).task));
            case "GET /v1/jobs/:job": {
              const p = new URLSearchParams(q ?? "");
              return send(res, 200, await jobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
            }
            case "DELETE /v1/jobs/:job": return send(res, 200, jobs.stop(w.module!, m[0]!));
            case "POST /v1/jobs/:job/input": {
              const b = await json(req);
              if (typeof b.text !== "string") throw fail(400, "bad_request", "send {text}");
              const r = jobs.input(w.module!, m[0]!, b.text, typeof b.from === "string" ? b.from : "owner");
              // A claimed comment wake is delivered only once the run took it.
              if (r.sent && typeof b.wake === "string") wakes?.delivered(w.module!, b.wake);
              return send(res, 200, r);
            }
            case "POST /v1/jobs/:job/ack": return send(res, 200, jobs.ack(w.module!, m[0]!));
            case "POST /v1/jobs/:job/post": {
              if (!outcomes) throw fail(503, "unavailable", "outcomes are off");
              const job = await jobs.get(w.module!, m[0]!);
              const b = await json(req);
              if (!JOB_KINDS.includes(b.kind) || typeof b.body !== "string") throw fail(400, "bad_request", `send {kind: ${JOB_KINDS.join("|")}, body, status?, blocked_by?}`);
              if (b.blocked_by !== undefined && !(Array.isArray(b.blocked_by) && b.blocked_by.every((x: unknown) => typeof x === "string"))) throw fail(400, "bad_request", "blocked_by is a list of task ids");
              return send(res, 200, await outcomes.post(job, { kind: b.kind, body: b.body, ...(typeof b.status === "string" ? { status: b.status } : {}), ...(b.blocked_by ? { blockedBy: b.blocked_by } : {}) }));
            }
          }
        } catch (e) {
          const j = e as { name?: string; status?: number; code?: string; message: string };
          if (j.name === "JobError" || j.name === "OutcomeError") throw fail(j.status!, j.code!, j.message);
          throw e;
        }
      }
      if (hit && (hit.path === "/v1/checks" || hit.path === "/v1/checks/:check" || hit.path === "/v1/receipts/verify")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.checks")) throw fail(403, "forbidden", `${w.module} may not run checks (role kernel.checks)`);
        if (!checkJobs) throw fail(503, "unavailable", "check jobs are off");
        try {
          if (hit.path === "/v1/checks") return send(res, 200, checkJobs.start(w.module!, await json(req)));
          if (hit.path === "/v1/receipts/verify") { const b = await json(req); return send(res, 200, checkJobs.verify(b.receipt, b.for ?? {})); }
          const p = new URLSearchParams(q ?? "");
          return send(res, 200, await checkJobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
        } catch (e) {
          const c = e as { name?: string; status?: number; code?: string; message: string };
          if (c.name === "CheckError") throw fail(c.status!, c.code!, c.message);
          throw e;
        }
      }
      if (hit && hit.path.startsWith("/v1/reviews")) {
        if (!reviews) throw fail(503, "unavailable", "reviews are off");
        // A review request carries the whole diff: one past the reviewer's limit is still sent, so its verdict can say how large.
        if (hit.path === "/v1/reviews") {
          reviewer(req);
          const b = await json(req, 64_000_000);
          if (!b.request || typeof b.request !== "object") throw fail(400, "bad_request", "send {request}");
          return send(res, 200, await reviews.request(b.request));
        }
        const b = await json(req);
        if (!b || typeof b !== "object" || !reviews.verdict(m[0]!, bearer(req), b)) throw fail(404, "not_found", "no review waits for that token");
        return send(res, 200, { ok: true });
      }
      if (hit && hit.path.startsWith("/v1/writes")) {
        if (!writes || !records) throw fail(503, "unavailable", "records are off");
        const id = m[0] ?? "";
        switch (`${hit.method} ${hit.path}`) {
          case "POST /v1/writes": {
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const b = await json(req);
            const r = await writes.request(w, { kind: String(b.kind ?? ""), args: b.args, ...(typeof b.task === "string" ? { task: b.task } : {}), ...(b.evidence !== undefined ? { evidence: b.evidence } : {}) });
            return send(res, 200, { id: r.id, tier: r.tier, state: r.state });
          }
          case "GET /v1/writes": {
            if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required");
            const p = new URLSearchParams(q ?? "");
            const list = LISTS[p.get("state") ?? ""];
            if (!list) throw fail(400, "bad_request", `state=${Object.keys(LISTS).join(", ")}`);
            const task = p.get("task") || undefined;
            // The reviewed ones only (every Tier 0 write is a record too, and would crowd the cards out), unless `tier0=1`
            // asks for every record (the board's history shows Tier 0 runs after the fact); the review list says which wait out a
            // failed review's backoff.
            const rows = records.list(list, Math.min(Number(p.get("limit")) || 100, 1000), { reviewed: p.get("tier0") !== "1", ...(task ? { task } : {}) });
            return send(res, 200, { records: rows.map((r) => ({ ...r, state: records.shownState(r), ...(writes.retryAt(r.id) ? { retry_at: writes.retryAt(r.id) } : {}) })) });
          }
          case "GET /v1/writes/:id": {
            if (isBoard(req)) return send(res, 200, record(id));
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const r = record(id);
            const own = w.kind === "module" ? w.module === r.requester.module && r.requester.kind === "module" : Boolean(w.agent) && w.agent === r.requester.agent;
            if (!own) throw fail(404, "not_found", `no record ${id}`);
            return send(res, 200, { id: r.id, kind: r.kind, tier: r.tier, state: r.state, outcome: r.outcome, ...(r.owner_reason ? { reason: r.owner_reason } : {}) });
          }
          case "POST /v1/writes/:id/outcome": {
            const r = record(id);
            if (await whoami(bearer(req)).then((w) => w.kind !== "module" || r.kind === CONN_TOOL || w.module !== r.executor.module, () => true)) throw fail(403, "forbidden", "only the kind's executor reports its outcome");
            const b = await json(req);
            if (!writes.outcome(id, b.ok === true, String(b.text ?? "").slice(0, 200_000))) throw fail(409, "conflict", `this record is ${record(id).state}`);
            return send(res, 200, { ok: true });
          }
        }
      }
      send(res, 404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number; type?: string };
      const status = e.status ?? 500;
      if (status >= 500) log("backplane error", { url: path, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message } });
      else res.destroy();
    }
  };
}

/** The chief of staff: the agent holding the fleet-admin role in the grants table (found by role, never by key). */
export const chiefOfStaff = (agents: Record<string, Grant> | undefined) => Object.entries(agents ?? {}).find(([, g]) => (g.roles ?? []).includes("fleet-admin"))?.[0];
